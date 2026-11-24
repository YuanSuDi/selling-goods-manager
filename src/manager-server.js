// manager-server.js
// 出品管理プログラム（Electron メインプロセス）から FurimaCopy 拡張へ
// 「自動出品タスク」を渡すための localhost 専用 HTTP サーバ。
//
// 設計:
//   - 127.0.0.1 のみにバインドし、全リクエストに共有トークン（x-fc-token）を要求する。
//   - 依存ライブラリなし（Node 標準の http のみ）なので、Electron 本体が無くても
//     単体で起動してテストできる。
//   - タスクはメモリ上のキューで管理し、生成/結果のたびにコールバックで
//     呼び出し側（NeDB への永続化など）へ通知する。
//
// API:
//   GET  /api/ping                 疎通確認
//   GET  /api/tasks?status=pending 未実行タスク一覧（拡張がポーリングする）
//   ping / tasks の応答には extVersion（配置済みの同梱拡張の版、v0.2.18）が
//   載る。拡張は自版より新しければ空き時間に自己再読み込みする（v0.12.30）。
//   POST /api/tasks                タスク作成（プログラムの UI から）
//   POST /api/tasks/:id/claim      拡張が実行開始を宣言（二重実行防止）
//   POST /api/tasks/:id/result     拡張が結果を報告 { ok, listingUrl?, message? }
//   POST /api/tasks/:id/release    拡張が claim 済みタスクをキューへ返す
//   POST /api/claims               所有権の自己申告（認領） { platform, listingId, taskId? }
//   GET  /api/image?path=<abs>     ローカル画像ファイルを拡張へ配信
//
// ノード（v0.2.0）:
//   拡張は各リクエストに x-fc-node ヘッダで自動生成ノード ID を付ける。
//   タスクの node_id がそのノード専用なら、そのノードにしか見えない。
//   node_id が空のタスクは「既定プール」で、名前未登録のノードと
//   ヘッダなし（旧拡張）にだけ見える。node_id '*' は全ノード宛（所有権確認用）。
//
// タスクの形:
//   { id, product_no, platform: "mercari"|"paypay"|"rakuma"|"yahoo",
//     type: "listing"|"relist",
//     title, description, price, conditionText, categoryText, shippingText,
//     images: [絶対パス...], autoSubmit: boolean,
//     status: "pending"|"running"|"done"|"failed",
//     result: { ok, listingUrl, message, at } | null, createdAt }
//   type="relist" のときは itemUrl（参照商品の URL）が必須で、拡張はその
//   商品ページをブラウザでコピーして再出品する（ローカル画像は使わない）。
//   title は参照 URL で代用する。
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const MIME = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function createManagerServer(options) {
  const opts = options || {};
  const port = opts.port || 17341;
  const token = opts.token || "";
  const imageRoots = (opts.imageRoots || []).map((r) => path.resolve(r));
  const onTaskCreated = typeof opts.onTaskCreated === "function" ? opts.onTaskCreated : null;
  const onTaskResult = typeof opts.onTaskResult === "function" ? opts.onTaskResult : null;
  const onSaleReported = typeof opts.onSaleReported === "function" ? opts.onSaleReported : null;
  const onNodeSeen = typeof opts.onNodeSeen === "function" ? opts.onNodeSeen : null;
  const getNodeInfo = typeof opts.getNodeInfo === "function" ? opts.getNodeInfo : null;
  const onOwnershipClaim = typeof opts.onOwnershipClaim === "function" ? opts.onOwnershipClaim : null;
  const onTaskReleased = typeof opts.onTaskReleased === "function" ? opts.onTaskReleased : null;
  const getExtVersion = typeof opts.getExtVersion === "function" ? opts.getExtVersion : null;
  const extVersion = () => {
    try {
      return getExtVersion ? getExtVersion() : null;
    } catch (e) {
      return null;
    }
  };

  const tasks = new Map();
  const taskImagePaths = new Set();
  let seq = 0;

  // 绑定体检スキャン結果の整形。上限を設けて巨大な body を防ぐ。
  function sanitizeScan(scan) {
    if (!scan || !Array.isArray(scan.items)) return null;
    const items = [];
    for (const it of scan.items.slice(0, 3000)) {
      const id = it && it.id != null ? String(it.id).slice(0, 64) : "";
      if (!id) continue;
      items.push({ id, title: it.title != null ? String(it.title).slice(0, 300) : "" });
    }
    return { complete: !!scan.complete, items };
  }

  // タスクを 1 件作る（HTTP の POST と、Electron メインプロセス内からの
  // 直接作成の両方から使う）。タスクに載った画像パスは配信許可リストに入る。
  function addTask(body) {
    if (!body || !body.platform) {
      throw new Error("platform is required");
    }
    const type =
      body.type === "relist" ? "relist"
      : body.type === "verify" ? "verify"
      : body.type === "delist" ? "delist"
      : body.type === "manual-delist" ? "manual-delist"
      : body.type === "healthscan" ? "healthscan"
      : "listing";
    if ((type === "relist" || type === "verify" || type === "delist") && !body.itemUrl) {
      throw new Error("itemUrl is required for relist/verify/delist tasks");
    }
    if (type === "listing" && !body.title) {
      throw new Error("title is required");
    }
    seq += 1;
    const task = {
      id: "task-" + Date.now() + "-" + seq,
      product_no: body.product_no || null,
      platform: body.platform,
      type,
      trigger: body.trigger || "manual",
      // v0.2.0: 出品レコードとの紐付けと、担当ノード。
      // node_id: '' = 既定プール / '*' = 全ノード（所有権確認）/ それ以外は専用。
      condition_id: body.condition_id || null,
      listing_id: body.listing_id || null,
      node_id: body.node_id != null ? String(body.node_id) : "",
      attemptedBy: [],
      claimedBy: null,
      itemUrl:
        type === "relist" || type === "verify" || type === "delist" || type === "manual-delist"
          ? body.itemUrl
            ? String(body.itemUrl)
            : null
          : null,
      manualReason: body.manualReason ? String(body.manualReason) : null,
      title: body.title
        ? String(body.title)
        : type === "relist"
          ? String(body.itemUrl)
          : type === "healthscan"
            ? "绑定体检"
            : "",
      description: body.description || "",
      price: body.price != null ? Number(body.price) : null,
      conditionText: body.conditionText || null,
      categoryText: body.categoryText || null,
      shippingText: body.shippingText || null,
      images: Array.isArray(body.images) ? body.images.map(String) : [],
      autoSubmit: !!body.autoSubmit,
      status: "pending",
      result: null,
      createdAt: new Date().toISOString(),
    };
    tasks.set(task.id, task);
    task.images.forEach((p) => taskImagePaths.add(path.resolve(p)));
    if (onTaskCreated) onTaskCreated(task);
    return task;
  }

  function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > 2 * 1024 * 1024) {
          reject(new Error("body too large"));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (!text) return resolve({});
        try {
          resolve(JSON.parse(text));
        } catch (e) {
          reject(new Error("invalid json"));
        }
      });
      req.on("error", reject);
    });
  }

  function isImageAllowed(absPath) {
    const ext = path.extname(absPath).toLowerCase();
    if (!MIME[ext]) return false;
    if (taskImagePaths.has(absPath)) return true;
    if (!imageRoots.length) return true;
    return imageRoots.some(
      (root) => absPath === root || absPath.startsWith(root + path.sep)
    );
  }

  // リクエスト元ノード（x-fc-node）から見て、そのタスクが対象かどうか。
  // nodeId が null（ヘッダなし＝旧拡張）は既定プール扱い。
  function nodeInfoOf(nodeId) {
    if (!nodeId) return null;
    try {
      return getNodeInfo ? getNodeInfo(nodeId) : null;
    } catch (e) {
      return null;
    }
  }
  function isNamedNode(nodeId) {
    const info = nodeInfoOf(nodeId);
    return !!(info && info.name);
  }
  function taskVisibleTo(task, nodeId) {
    if (task.node_id === "*") {
      // 所有権確認は全ノード宛。ただし既に試したノードには二度出さない。
      return !(task.attemptedBy || []).includes(nodeId);
    }
    if (task.node_id) return task.node_id === nodeId;
    // 既定プール: 名前付きノードには見せない（担当分離を守る）。
    return !isNamedNode(nodeId);
  }
  function nodePayload(nodeId) {
    if (!nodeId) return null;
    const info = nodeInfoOf(nodeId);
    return { id: nodeId, name: info ? info.name || null : null };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const pathname = url.pathname;

      if (token && req.headers["x-fc-token"] !== token) {
        return sendJson(res, 401, { ok: false, error: "unauthorized" });
      }

      const reqNodeId = req.headers["x-fc-node"] ? String(req.headers["x-fc-node"]) : null;
      if (reqNodeId && onNodeSeen) {
        try {
          onNodeSeen(reqNodeId);
        } catch (e) { /* 登録簿の更新失敗で本体を止めない */ }
      }

      if (req.method === "GET" && pathname === "/api/ping") {
        return sendJson(res, 200, { ok: true, app: "selling-goods-manager", version: 2, extVersion: extVersion(), node: nodePayload(reqNodeId) });
      }

      if (req.method === "GET" && pathname === "/api/tasks") {
        const status = url.searchParams.get("status");
        let list = Array.from(tasks.values()).filter(
          (t) => !status || t.status === status
        );
        if (!status || status === "pending") {
          list = list.filter((t) => taskVisibleTo(t, reqNodeId));
        }
        return sendJson(res, 200, { ok: true, tasks: list, extVersion: extVersion(), node: nodePayload(reqNodeId) });
      }

      if (req.method === "POST" && pathname === "/api/tasks") {
        const body = await readBody(req);
        try {
          const task = addTask(body);
          return sendJson(res, 201, { ok: true, task });
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: String((e && e.message) || e) });
        }
      }

      const claimMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/claim$/);
      if (req.method === "POST" && claimMatch) {
        const task = tasks.get(decodeURIComponent(claimMatch[1]));
        if (!task) return sendJson(res, 404, { ok: false, error: "task not found" });
        if (task.status !== "pending") {
          return sendJson(res, 409, { ok: false, error: "task already " + task.status });
        }
        if (!taskVisibleTo(task, reqNodeId)) {
          return sendJson(res, 403, { ok: false, error: "task is assigned to another node" });
        }
        if (task.type === "verify") {
          // 所有権確認は複数ノードが試すものなので、claim でロックしない。
          return sendJson(res, 200, { ok: true, task });
        }
        task.status = "running";
        task.claimedBy = reqNodeId;
        return sendJson(res, 200, { ok: true, task });
      }

      const releaseMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/release$/);
      if (req.method === "POST" && releaseMatch) {
        const task = tasks.get(decodeURIComponent(releaseMatch[1]));
        if (!task) return sendJson(res, 404, { ok: false, error: "task not found" });
        const body = await readBody(req);
        if (task.status !== "running") {
          return sendJson(res, 409, { ok: false, error: "task is not running" });
        }
        if (task.claimedBy && reqNodeId && task.claimedBy !== reqNodeId) {
          return sendJson(res, 403, { ok: false, error: "task is claimed by another node" });
        }
        // 担当ノード自身が「所有権なし」で返却し続けるレコード紐付き
        // 再出品タスクは、他ノードが引き継ぐこともできない。このままだと
        // 実行中⇔実行待ちを永遠に往復するため、3 回目の返却で失敗にする。
        const ownNodeNotOwner =
          task.type === "relist" &&
          task.node_id &&
          task.node_id !== "*" &&
          reqNodeId &&
          task.node_id === reqNodeId &&
          (body.reason || null) === "not-owner";
        if (ownNodeNotOwner) {
          task.notOwnerReleases = (task.notOwnerReleases || 0) + 1;
        }
        task.releaseNote = {
          by: reqNodeId,
          reason: body.reason || null,
          at: new Date().toISOString(),
        };
        if (ownNodeNotOwner && task.notOwnerReleases >= 3) {
          task.status = "failed";
          task.claimedBy = null;
          task.result = {
            ok: false,
            listingUrl: null,
            message:
              "担当ノードが「所有権なし」で返却を繰り返したため失敗にしました。再出品ページが操作できない状態です（すでに再出品済み・落札済みなど）。",
            at: new Date().toISOString(),
            executedBy: reqNodeId,
          };
          if (onTaskResult) onTaskResult(task);
          return sendJson(res, 200, { ok: true, task, gaveUp: true });
        }
        task.status = "pending";
        task.claimedBy = null;
        if (onTaskReleased) onTaskReleased(task);
        return sendJson(res, 200, { ok: true, task });
      }

      if (req.method === "POST" && pathname === "/api/claims") {
        const body = await readBody(req);
        const platform = body.platform === "yahoo" ? "yahoo" : "mercari";
        const listingId = body.listingId
          ? String(body.listingId).trim()
          : platform === "yahoo"
            ? String(body.listingUrl || "").match(/\/jp\/auction\/([a-zA-Z]?[0-9]+)/)?.[1] || null
            : String(body.listingUrl || "").match(/\/item\/(m[A-Za-z0-9]+)/)?.[1] || null;
        if (!listingId) {
          return sendJson(res, 400, { ok: false, error: "listingId or listingUrl is required" });
        }
        const claimResult = onOwnershipClaim
          ? await onOwnershipClaim({ nodeId: reqNodeId, platform, listingId, taskId: body.taskId || null })
          : { ok: false, assigned: false };
        // 紐付く所有権確認タスクがあれば完了にする。
        if (claimResult && claimResult.assigned && body.taskId) {
          const task = tasks.get(String(body.taskId));
          if (task && task.type === "verify" && task.status === "pending") {
            task.status = "done";
            task.result = {
              ok: true,
              listingUrl: task.itemUrl || null,
              message: "所有権を確認しました",
              at: new Date().toISOString(),
              executedBy: reqNodeId,
            };
            if (onTaskResult) onTaskResult(task);
          }
        }
        return sendJson(res, 200, Object.assign({ ok: true, listingId }, claimResult || {}));
      }

      const resultMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/result$/);
      if (req.method === "POST" && resultMatch) {
        const task = tasks.get(decodeURIComponent(resultMatch[1]));
        if (!task) return sendJson(res, 404, { ok: false, error: "task not found" });
        const body = await readBody(req);
        // 所有権確認で「自分の商品ではない」と分かった場合は、タスクを
        // 失敗にせず、このノードには二度出さないようにして pending のまま残す。
        if (task.type === "verify" && body.notOwner) {
          task.attemptedBy = Array.from(new Set([...(task.attemptedBy || []), reqNodeId]));
          if (onTaskReleased) onTaskReleased(task);
          return sendJson(res, 200, { ok: true, task, notOwner: true });
        }
        task.result = {
          ok: !!body.ok,
          listingUrl: body.listingUrl || null,
          message: body.message || null,
          // 下架タスク専用: Yahoo で入札があり自動取消しを中止した印。
          hasBids: !!body.hasBids,
          // 下架タスク専用: Mercari は削除ではなく一時停止になった印
          // （ID を保持するため、レコード側の反映が変わる）。
          paused: !!body.paused,
          // 绑定体检タスク専用: 在售リストの列挙結果 { complete, items }。
          scan: sanitizeScan(body.scan),
          at: new Date().toISOString(),
          executedBy: reqNodeId,
        };
        task.status = body.ok ? "done" : "failed";
        if (onTaskResult) onTaskResult(task);
        return sendJson(res, 200, { ok: true, task });
      }

      if (req.method === "POST" && pathname === "/api/sales/report") {
        const body = await readBody(req);
        const platform = body.platform === "yahoo" ? "yahoo" : "mercari";
        const itemId = body.itemId
          ? String(body.itemId).trim()
          : platform === "yahoo"
            ? String(body.listingUrl || "").match(/\/jp\/auction\/([a-zA-Z]?[0-9]+)/)?.[1] || null
            : String(body.listingUrl || "").match(/\/item\/(m[A-Za-z0-9]+)/)?.[1] || null;
        if (!itemId) {
          return sendJson(res, 400, { ok: false, error: "itemId or listingUrl is required" });
        }
        // 状態テキストの関門はプラットフォームごと:
        // Mercari は「発送をお願いします」、ヤフオクは発送を促す文言（「発送」を含む）。
        if (body.statusText) {
          const st = String(body.statusText);
          const passes = platform === "yahoo" ? st.includes("発送") : st.includes("発送をお願いします");
          if (!passes) {
            return sendJson(res, 200, { ok: true, ignored: true, itemId });
          }
        }
        const result = onSaleReported
          ? await onSaleReported(Object.assign({}, body, { itemId, platform, nodeId: reqNodeId }))
          : { ok: false, matched: false };
        return sendJson(res, 200, Object.assign({ ok: true, itemId }, result || {}));
      }

      if (req.method === "GET" && pathname === "/api/image") {
        const p = url.searchParams.get("path");
        if (!p) return sendJson(res, 400, { ok: false, error: "path is required" });
        const abs = path.resolve(p); // searchParams.get が既にデコード済み
        if (!isImageAllowed(abs)) {
          return sendJson(res, 403, { ok: false, error: "image not allowed" });
        }
        fs.readFile(abs, (err, data) => {
          if (err) return sendJson(res, 404, { ok: false, error: "image not found" });
          res.writeHead(200, {
            "Content-Type": MIME[path.extname(abs).toLowerCase()],
            "Content-Length": data.length,
          });
          res.end(data);
        });
        return;
      }

      return sendJson(res, 404, { ok: false, error: "not found" });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });

  // 永続化された pending タスクを起動時に復元する（id はそのまま使う）。
  function restore(task) {
    if (!task || !task.id) return null;
    tasks.set(task.id, task);
    (task.images || []).forEach((p) => taskImagePaths.add(path.resolve(p)));
    return task;
  }

  return {
    tasks,
    addTask,
    restore,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve({ port }));
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { createManagerServer };

// 単体テスト用: `node src/manager-server.js` で起動できる。
if (require.main === module) {
  const srv = createManagerServer({
    port: Number(process.env.FC_MANAGER_PORT || 17341),
    token: process.env.FC_MANAGER_TOKEN || "dev-token",
    imageRoots: [process.cwd()],
    onTaskCreated: (t) => console.log("[manager-server] task created:", t.id, t.platform, t.title),
    onTaskResult: (t) => console.log("[manager-server] task result:", t.id, t.status, t.result),
  });
  srv.listen().then(({ port }) => {
    console.log("[manager-server] listening on http://127.0.0.1:" + port);
  });
}
