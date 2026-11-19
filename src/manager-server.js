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
//   POST /api/tasks                タスク作成（プログラムの UI から）
//   POST /api/tasks/:id/claim      拡張が実行開始を宣言（二重実行防止）
//   POST /api/tasks/:id/result     拡張が結果を報告 { ok, listingUrl?, message? }
//   GET  /api/image?path=<abs>     ローカル画像ファイルを拡張へ配信
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

  const tasks = new Map();
  const taskImagePaths = new Set();
  let seq = 0;

  // タスクを 1 件作る（HTTP の POST と、Electron メインプロセス内からの
  // 直接作成の両方から使う）。タスクに載った画像パスは配信許可リストに入る。
  function addTask(body) {
    if (!body || !body.platform) {
      throw new Error("platform is required");
    }
    const type = body.type === "relist" ? "relist" : "listing";
    if (type === "relist" && !body.itemUrl) {
      throw new Error("itemUrl is required for relist tasks");
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
      itemUrl: type === "relist" ? String(body.itemUrl) : null,
      title: body.title
        ? String(body.title)
        : type === "relist"
          ? String(body.itemUrl)
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

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const pathname = url.pathname;

      if (token && req.headers["x-fc-token"] !== token) {
        return sendJson(res, 401, { ok: false, error: "unauthorized" });
      }

      if (req.method === "GET" && pathname === "/api/ping") {
        return sendJson(res, 200, { ok: true, app: "selling-goods-manager", version: 1 });
      }

      if (req.method === "GET" && pathname === "/api/tasks") {
        const status = url.searchParams.get("status");
        const list = Array.from(tasks.values()).filter(
          (t) => !status || t.status === status
        );
        return sendJson(res, 200, { ok: true, tasks: list });
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
        task.status = "running";
        return sendJson(res, 200, { ok: true, task });
      }

      const resultMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/result$/);
      if (req.method === "POST" && resultMatch) {
        const task = tasks.get(decodeURIComponent(resultMatch[1]));
        if (!task) return sendJson(res, 404, { ok: false, error: "task not found" });
        const body = await readBody(req);
        task.result = {
          ok: !!body.ok,
          listingUrl: body.listingUrl || null,
          message: body.message || null,
          at: new Date().toISOString(),
        };
        task.status = body.ok ? "done" : "failed";
        if (onTaskResult) onTaskResult(task);
        return sendJson(res, 200, { ok: true, task });
      }

      if (req.method === "POST" && pathname === "/api/sales/report") {
        const body = await readBody(req);
        const itemId = body.itemId
          ? String(body.itemId).trim()
          : String(body.listingUrl || "").match(/\/item\/(m[A-Za-z0-9]+)/)?.[1] || null;
        if (!itemId) {
          return sendJson(res, 400, { ok: false, error: "itemId or listingUrl is required" });
        }
        if (body.statusText && !String(body.statusText).includes("発送をお願いします")) {
          return sendJson(res, 200, { ok: true, ignored: true, itemId });
        }
        const result = onSaleReported
          ? await onSaleReported(Object.assign({}, body, { itemId }))
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
