// background.js
// フリマコピー（自作）の MV3 サービスワーカー。
// 役割は 1 つだけ: コンテンツスクリプトの代わりに画像を取得し、base64 で返す。
// v0.2.1: Mercari の CDN（static.mercdn.net）が「出品ページ等からの参照」でない取得を
// 403 で弾くため、コピー元ページ URL を Referer にして取得を試みる。
// 試行順: 1) Referer 付き 2) Referer + Cookie 付き 3) 素の fetch（他 CDN 用の保険）。
// どの試行で成功したかを attempt として返し、ページ側コンソールで分かるようにする。
"use strict";

// ArrayBuffer → base64（大きい画像でもスタック溢れしないようチャンク処理）。
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function fetchWithFallbacks(url, referrer) {
  // 画像読み込み時と同じ Accept を付ける（CDN の Vary / 判定対策）。
  const headers = { Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8" };
  const attempts = [];
  if (referrer) {
    attempts.push({ headers, referrer, referrerPolicy: "unsafe-url" });
    attempts.push({ headers, referrer, referrerPolicy: "unsafe-url", credentials: "include" });
  }
  attempts.push({ headers });
  const errors = [];
  for (let i = 0; i < attempts.length; i++) {
    try {
      const res = await fetch(url, attempts[i]);
      if (!res.ok) throw new Error("HTTP " + res.status);
      return { res, attempt: i + 1 };
    } catch (e) {
      errors.push("attempt" + (i + 1) + ": " + String((e && e.message) || e));
    }
  }
  throw new Error(errors.join(" | ") || "fetch failed");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 配送方法の自動選択が失敗したとき、診断タブを開く（v0.12.36 ローカル検証用）。
  // ポップアップはフォーカスを失うと閉じてしまうため、タブで残す。
  if (message && message.type === "FurimaShowShipDiag") {
    chrome.tabs.create({ url: chrome.runtime.getURL("diag.html") });
    return false;
  }
  // 出品ページで画像の取込データが無かったときの取り直し（filler からの依頼、v0.7.13）。
  if (message && message.type === "FurimaRecaptureImages" && message.itemUrl) {
    recaptureImages(message.itemUrl).then((r) => sendResponse(r));
    return true;
  }
  if (!message || message.type !== "FurimaCopyFetchImage" || !message.url) {
    return false;
  }
  (async () => {
    imageFetchInFlight++;
    lastImageFetchAt = Date.now();
    try {
      // Referer の第一候補はメッセージで渡されたコピー元 URL、なければ送信元タブの URL。
      const referrer = message.referrer || (sender.tab && sender.tab.url) || null;
      const { res, attempt } = await fetchWithFallbacks(message.url, referrer);
      const buffer = await res.arrayBuffer();
      sendResponse({
        ok: true,
        base64: arrayBufferToBase64(buffer),
        contentType: res.headers.get("content-type") || "image/jpeg",
        attempt,
      });
    } catch (e) {
      console.warn("[FurimaCopy] image fetch failed:", message.url, e);
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    } finally {
      imageFetchInFlight--;
      lastImageFetchAt = Date.now();
    }
  })();
  return true; // 非同期で sendResponse するので true を返す
});

// ============================================================================
// リモート指令（v0.5.0）は v0.12.31 で廃止した。ポップアップ UI・指令
// ポーリング・テスト実行・executeRelist をすべて撤去し、Gist 経由の
// 再出品指令は受け付けない。remoteSleep / startKeepAlive などの共通
// ヘルパはこの下に残してある（管理プログラムのタスク実行が使う）。
// ============================================================================

function remoteSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}


// サービスワーカーが途中で眠らないよう、実行中は定期的に API を叩く。
function startKeepAlive() {
  const t = setInterval(() => {
    try {
      chrome.runtime.getPlatformInfo(() => {});
    } catch (e) {
      /* noop */
    }
  }, 20000);
  return () => clearInterval(t);
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        chrome.tabs.onUpdated.removeListener(listener);
      } catch (e) {
        /* noop */
      }
      resolve(ok);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish(true);
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs
      .get(tabId)
      .then((t) => {
        if (t && t.status === "complete") finish(true);
      })
      .catch(() => {});
    setTimeout(() => finish(false), timeoutMs || 45000);
  });
}

// コンテンツスクリプトの読み込み完了を待ちながらメッセージを送る。
async function sendToTabWithRetry(tabId, message, tries, intervalMs) {
  let lastErr = null;
  for (let i = 0; i < (tries || 15); i++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, message);
      if (res) return res;
    } catch (e) {
      lastErr = e;
    }
    await remoteSleep(intervalMs || 3000);
  }
  throw new Error(
    "ページ側スクリプトが応答しませんでした: " +
      String((lastErr && lastErr.message) || lastErr || "")
  );
}



// ============================================================================
// 画像の再取込（v0.7.13）
// ----------------------------------------------------------------------------
// Mercari の CDN は出品ページからの直接取得を 403 で拒むため、画像は
// コピー時に商品ページで取り込んだデータ（copyImages）から貼るのが前提。
// ところが取込データは「最後にコピーした 1 件分」しか残らず、別の商品を
// コピーした後だと対象商品分が消えていて 0 枚になる。そこで filler から
// 依頼されたら、コピー元ページを裏タブで開いて読み取り直し、取込データを
// 作り直す（リモート再出品と同じ仕組みの流用）。
// ============================================================================

let recaptureRunning = false;

async function recaptureImages(itemUrl) {
  if (recaptureRunning) return { ok: false, error: "再取込を実行中です" };
  recaptureRunning = true;
  const stopKeepAlive = startKeepAlive();
  try {
    const tab = await chrome.tabs.create({ url: itemUrl, active: false });
    try {
      await chrome.tabs.update(tab.id, { autoDiscardable: false });
    } catch (e) {
      /* noop */
    }
    await waitForTabComplete(tab.id, 45000);
    await remoteSleep(2000);
    const res = await sendToTabWithRetry(
      tab.id,
      { type: "FurimaRemoteCopy" },
      20,
      3000
    );
    try {
      await chrome.tabs.remove(tab.id);
    } catch (e) {
      /* noop */
    }
    if (!res || !res.ok) {
      return { ok: false, error: "読み取り失敗: " + ((res && res.error) || "不明") };
    }
    const stored = await chrome.storage.local.get("copyImages");
    const imgs = stored.copyImages;
    const captured =
      imgs && Array.isArray(imgs.items)
        ? imgs.items.filter((x) => x && x.base64).length
        : 0;
    return { ok: true, captured, sourceUrl: imgs ? imgs.sourceUrl : null };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    stopKeepAlive();
    recaptureRunning = false;
  }
}

// ============================================================================
// 出品管理プログラム連携（v0.9.0）
// ----------------------------------------------------------------------------
// ユーザーの PC で動く出品管理プログラム（selling-goods-manager）が
// localhost に立てる小さな HTTP サーバと通信し、「自動出品タスク」を実行する。
//   1. 1 分ごとに pending タスクを問い合わせる（設定 ON のときだけ）
//   2. タスクを claim する。type="relist" のタスクは参照商品ページを
//      開いて通常のコピーで staging し、それ以外（従来型）は商品データと
//      画像（プログラムから直接取得）を copyData / copyImages に staging する
//   3. 出品ページを開いて自動入力させ、タスクが autoSubmit のときだけ
//      filler 側が「出品する」まで押し、lastSubmitReport に結果を残す
//   4. 結果（成否・出品 URL・手動項目）をプログラムへ返す
// 自動出品（送信）を行うのは管理プログラムから来たタスクだけ。
// 通常のコピー＆入力と Gist リモート再出品は従来どおり入力止まり。
// 対応プラットフォームは Mercari と Yahoo!オークション（他は pending のまま残す）。
// ============================================================================

const MANAGER_ALARM = "fcManagerPoll";
const TODO_SCAN_ALARM = "fcMercariTodoScan";
const YAHOO_SCAN_ALARM = "fcYahooSoldScan";
const MANAGER_DEFAULTS = {
  enabled: false,
  baseUrl: "http://127.0.0.1:17341",
  token: "",
  todoScanEnabled: false,
  todoScanInterval: 5,
  todoScanUnit: "minutes",
  lastPollAt: null,
  lastStatus: "未設定",
  lastSaleScanAt: null,
  lastSaleScanStatus: "未スキャン",
  yahooScanEnabled: false,
  yahooScanInterval: 5,
  yahooScanUnit: "minutes",
  lastYahooScanAt: null,
  lastYahooScanStatus: "未スキャン",
};
const MANAGER_SELL_URLS = {
  mercari: "https://jp.mercari.com/sell/create",
};
let managerRunning = false;
let soldScanRunning = false;
let yahooScanRunning = false;
// 画像取込プロキシの活動量（自動更新の空き判定に使う、v0.12.30）
let imageFetchInFlight = 0;
let lastImageFetchAt = 0;

async function getManagerConfig() {
  const res = await chrome.storage.local.get("managerConfig");
  return Object.assign({}, MANAGER_DEFAULTS, res.managerConfig || {});
}

async function setManagerConfig(patch) {
  const cfg = Object.assign(await getManagerConfig(), patch);
  await chrome.storage.local.set({ managerConfig: cfg });
  return cfg;
}

// v0.12.0: ノード ID（Chrome プロファイル単位の恒久 ID）。
// 管理プログラムはこの ID でタスクを振り分け、名前はプログラム側でのみ登録する。
let fcNodeIdCache = null;
async function getNodeId() {
  if (fcNodeIdCache) return fcNodeIdCache;
  const res = await chrome.storage.local.get("fcNodeId");
  if (res.fcNodeId) {
    fcNodeIdCache = String(res.fcNodeId);
    return fcNodeIdCache;
  }
  const id =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : "node-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
  await chrome.storage.local.set({ fcNodeId: id });
  fcNodeIdCache = id;
  return id;
}

async function managerFetch(cfg, path, init) {
  const base = String(cfg.baseUrl || "").replace(/\/$/, "");
  const nodeId = await getNodeId();
  const res = await fetch(
    base + path,
    Object.assign({}, init || {}, {
      headers: Object.assign(
        { "x-fc-token": cfg.token || "", "x-fc-node": nodeId },
        (init && init.headers) || {}
      ),
    })
  );
  if (!res.ok) throw new Error("manager HTTP " + res.status);
  return res.json();
}

async function scanMercariSoldTodos(cfg, force) {
  if (!cfg.todoScanEnabled && !force) return { ok: true, skipped: true };
  if (soldScanRunning) return { ok: false, error: "Todo 扫描正在进行中" };
  soldScanRunning = true;
  const stopKeepAlive = startKeepAlive();
  let todosTab = null;
  let cards = [];
  let matched = 0;
  let unmatched = 0;
  try {
    todosTab = await chrome.tabs.create({ url: "https://jp.mercari.com/todos", active: false });
    await waitForTabComplete(todosTab.id, 45000);
    await remoteSleep(3000);
    const scan = await sendToTabWithRetry(
      todosTab.id,
      { type: "FurimaScanSoldTodos" },
      10,
      2000
    );
    cards = scan && scan.cards ? scan.cards : [];

    for (const card of cards) {
      let itemId = card.itemId;
      let listingUrl = itemId ? "https://jp.mercari.com/item/" + itemId : null;

      if (!itemId && /^https:\/\/jp\.mercari\.com\/transactions?\//.test(card.url)) {
        const detailTab = await chrome.tabs.create({ url: card.url, active: false });
        try {
          await waitForTabComplete(detailTab.id, 45000);
          await remoteSleep(2500);
          const detail = await sendToTabWithRetry(
            detailTab.id,
            { type: "FurimaScanSoldTodos" },
            10,
            2000
          );
          if (detail && detail.detail) {
            itemId = detail.detail.itemId;
            listingUrl = detail.detail.url;
          }
        } finally {
          try {
            await chrome.tabs.remove(detailTab.id);
          } catch (e) {}
        }
      }

      if (!itemId) {
        unmatched += 1;
        continue;
      }
      const report = await managerFetch(cfg, "/api/sales/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId,
          listingUrl,
          statusText: card.text,
          at: new Date().toISOString(),
        }),
      });
      if (report && report.matched) matched += 1;
      else unmatched += 1;
    }
    await setManagerConfig({
      lastSaleScanAt: new Date().toISOString(),
      lastSaleScanStatus:
        "発送待ち " + cards.length + "件 / 在庫連携 " + matched +
        "件 / 商品未一致 " + unmatched + "件",
    });
    return { ok: true };
  } catch (e) {
    console.warn("[FurimaCopy] sold todos scan failed", e);
    await setManagerConfig({
      lastSaleScanAt: new Date().toISOString(),
      lastSaleScanStatus: "スキャン失敗: " + String((e && e.message) || e),
    });
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    if (todosTab) {
      try {
        await chrome.tabs.remove(todosTab.id);
      } catch (e) {}
    }
    soldScanRunning = false;
    stopKeepAlive();
  }
}

// Yahoo!オークション「出品終了分（落札者あり）」をスキャンし、
// 「発送をしてください」（支払い済み・発送待ち）の商品を管理プログラムへ
// platform=yahoo で報告する。Mercari の Todo スキャンと同じ形。
async function scanYahooSold(cfg, force) {
  if (!cfg.yahooScanEnabled && !force) return { ok: true, skipped: true };
  if (yahooScanRunning) return { ok: false, error: "Yahoo 扫描正在进行中" };
  yahooScanRunning = true;
  const stopKeepAlive = startKeepAlive();
  let scanTab = null;
  let found = 0;
  let matched = 0;
  let unmatched = 0;
  try {
    scanTab = await chrome.tabs.create({
      url: "https://auctions.yahoo.co.jp/my/closed?hasWinner=1",
      active: false,
    });
    await waitForTabComplete(scanTab.id, 45000);
    await remoteSleep(2500);
    const scan = await sendToTabWithRetry(
      scanTab.id,
      { type: "FurimaScanYahooSold" },
      10,
      2000
    );
    const entries = scan && scan.entries ? scan.entries : [];
    found = entries.length;
    for (const entry of entries) {
      const report = await managerFetch(cfg, "/api/sales/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: "yahoo",
          itemId: entry.itemId,
          listingUrl: entry.listingUrl,
          statusText: entry.statusText,
          at: new Date().toISOString(),
        }),
      });
      if (report && report.matched) matched += 1;
      else unmatched += 1;
    }
    await setManagerConfig({
      lastYahooScanAt: new Date().toISOString(),
      lastYahooScanStatus:
        "発送待ち " + found + "件 / 在庫連携 " + matched +
        "件 / 商品未一致 " + unmatched + "件",
    });
    return { ok: true };
  } catch (e) {
    console.warn("[FurimaCopy] yahoo sold scan failed", e);
    await setManagerConfig({
      lastYahooScanAt: new Date().toISOString(),
      lastYahooScanStatus: "スキャン失敗: " + String((e && e.message) || e),
    });
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    if (scanTab) {
      try {
        await chrome.tabs.remove(scanTab.id);
      } catch (e) {}
    }
    yahooScanRunning = false;
    stopKeepAlive();
  }
}

// v0.12.0: タスクを「失敗」で燃やさず、キューヘ返却する（所有権ゲート用）。
async function releaseManagerTask(cfg, task, reason) {
  try {
    await managerFetch(cfg, "/api/tasks/" + encodeURIComponent(task.id) + "/release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: reason || "not-owner" }),
    });
  } catch (e) {
    console.warn("[FurimaCopy] task release failed", e);
  }
}

// Mercari 商品ページで「自分の商品か」を判定する。
// 出品者向けコントロール（商品の編集 / 出品を一時停止 等）が見えていること
// を肯定的な証拠とし、見えなければ他人の商品として扱う（fail-closed）。
// v0.12.11: 売却済みページには編集/一時停止ボタンが存在しないため、従来の
// 判定では「自分の売れた商品」が永遠に所有権なしになっていた。売却済み
// ページでは取引当事者にしか見えない「取引画面を表示する」リンクを
// 出品者側の証拠として扱う（購入手続きボタンが無いことも確認する）。
async function probeMercariOwnership(tabId) {
  let last = { isOwner: false, sellerSignals: [], buyerSignals: [] };
  for (let i = 0; i < 5; i++) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const visible = (el) => {
            const s = getComputedStyle(el);
            return (
              s.display !== "none" &&
              s.visibility !== "hidden" &&
              el.getClientRects().length > 0
            );
          };
          const texts = Array.from(
            document.querySelectorAll('a, button, [role="button"]')
          )
            .filter(visible)
            .map((el) => String(el.innerText || "").replace(/\s+/g, " ").trim())
            .filter(Boolean);
          const sellerSignals = texts.filter((t) =>
            /出品を一時停止|一時停止する|商品の編集/.test(t)
          );
          const buyerSignals = texts.filter((t) => /購入手続き|購入に進む/.test(t));
          const bodyHead = String(
            (document.body && document.body.innerText) || ""
          ).slice(0, 6000);
          const soldOut = /売り切れ/.test(bodyHead);
          const txSignals = texts.filter((t) => /取引画面を表示する/.test(t));
          const soldOwner =
            soldOut && txSignals.length > 0 && buyerSignals.length === 0;
          return {
            isOwner: sellerSignals.length > 0 || soldOwner,
            via:
              sellerSignals.length > 0
                ? "active-controls"
                : soldOwner
                  ? "sold-transaction"
                  : null,
            sellerSignals: sellerSignals.slice(0, 3),
            txSignals: txSignals.slice(0, 3),
            buyerSignals: buyerSignals.slice(0, 3),
          };
        },
      });
      if (results[0] && results[0].result) last = results[0].result;
      if (last.isOwner) return last;
    } catch (e) {
      /* ページ準備中なら少し待って再試行する */
    }
    await remoteSleep(2000);
  }
  return last;
}

// Yahoo 商品ページで「自分の商品か」を判定する（所有権確認用）。
// 出品中のオークションでは再出品ページが使えないため、商品ページ自体に
// 出品者だけが見える「オークションの編集」があるかを見る（fail-closed）。
async function probeYahooAuctionOwnership(tabId) {
  let last = { isOwner: false, sellerSignals: [] };
  for (let i = 0; i < 4; i++) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const visible = (el) => {
            const s = getComputedStyle(el);
            return (
              s.display !== "none" &&
              s.visibility !== "hidden" &&
              el.getClientRects().length > 0
            );
          };
          const texts = Array.from(
            document.querySelectorAll('a, button, [role="button"]')
          )
            .filter(visible)
            .map((el) => String(el.innerText || "").replace(/\s+/g, " ").trim())
            .filter(Boolean);
          const sellerSignals = texts.filter((t) =>
            /オークションの編集|出品の編集|この出品を編集|取引ナビ/.test(t)
          );
          return {
            isOwner: sellerSignals.length > 0,
            sellerSignals: sellerSignals.slice(0, 3),
          };
        },
      });
      if (results[0] && results[0].result) last = results[0].result;
      if (last.isOwner) return last;
    } catch (e) {
      /* ページ準備中なら少し待って再試行する */
    }
    await remoteSleep(2000);
  }
  return last;
}

// Yahoo 再出品ページが操作可能か（＝自分の商品か）を、クリックせずに判定する。
// 決定的な結果（操作可能 / すでに再出品済み / エラー表示 / 別ページ遷移）
// 以外はページ描画待ちの可能性があるため、数回リトライする。
async function probeYahooResubmit(tabId, itemId) {
  let last = { operable: false, reason: "応答がありません" };
  for (let i = 0; i < 3; i++) {
    last = await probeYahooResubmitOnce(tabId, itemId);
    if (last.operable || last.definitive) return last;
    await remoteSleep(2000);
  }
  return last;
}

async function probeYahooResubmitOnce(tabId, itemId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      args: [itemId],
      func: (expectedId) => {
        const url = new URL(location.href);
        if (url.origin !== "https://auctions.yahoo.co.jp") {
          return { operable: false, definitive: true, reason: "別ドメインへ遷移しました: " + url.origin };
        }
        if (!url.pathname.startsWith("/sell/jp/show/")) {
          return { operable: false, definitive: true, reason: "再出品ページではありません: " + url.pathname };
        }
        const aID = url.searchParams.get("aID");
        if (aID && aID !== expectedId) {
          return { operable: false, definitive: true, reason: "商品 ID が一致しません" };
        }
        const bodyText = String(document.body ? document.body.innerText || "" : "");
        if (/すでに再出品されています/.test(bodyText)) {
          // 所有権なしではなく「再出品の目的は達成済み」。呼び出し側で
          // 完了として扱う（所有権なしで返却するとタスクが回り続ける）。
          return { operable: false, definitive: true, alreadyRelisted: true, reason: "すでに再出品されています" };
        }
        if (/再出品できません|出品できません|存在しません|エラーが発生/.test(bodyText)) {
          return { operable: false, definitive: true, reason: "再出品できない旨の表示があります" };
        }
        const visible = (el) => {
          const s = getComputedStyle(el);
          return (
            s.display !== "none" &&
            s.visibility !== "hidden" &&
            el.getClientRects().length > 0
          );
        };
        const labels = Array.from(
          document.querySelectorAll(
            'button, input[type="submit"], input[type="button"], [role="button"]'
          )
        )
          .filter(visible)
          .map((el) =>
            String(el.innerText || el.value || "").replace(/\s+/g, " ").trim()
          )
          .filter(Boolean);
        const hasAction = labels.some((t) => /確認|出品する|再出品する/.test(t));
        return { operable: hasAction, labels: labels.slice(0, 8) };
      },
    });
    return (
      (results[0] && results[0].result) || { operable: false, reason: "応答がありません" }
    );
  } catch (e) {
    return { operable: false, reason: String((e && e.message) || e) };
  }
}

// v0.12.0: 所有権確認タスク（type=verify）。管理プログラムで手貼りした
// レコードについて、各ブラウザが「その商品は自分のものか」を実地で確かめ、
// 本人だけが /api/claims で名乗りを上げる。他人の場合は notOwner で返し、
// サーバ側で試行済みとしてこのノードには再配信されなくなる。
async function executeVerifyTask(cfg, task) {
  const stopKeepAlive = startKeepAlive();
  let tabId = null;
  try {
    await setManagerConfig({
      lastStatus: "所有権確認中: " + (task.product_no || task.id),
    });
    let isOwner = false;
    let listingId = null;
    if (task.platform === "yahoo") {
      const m =
        String(task.itemUrl || "").match(/\/jp\/auction\/([a-zA-Z]?\d+)/) ||
        String(task.itemUrl || "").match(/^([a-zA-Z]?\d+)$/);
      listingId = m && m[1];
      if (!listingId) throw new Error("オークション ID を特定できませんでした");
      const tab = await chrome.tabs.create({ url: task.itemUrl, active: false });
      tabId = tab.id;
      await waitForTabComplete(tabId, 45000);
      await remoteSleep(2500);
      // 出品中オークション: 商品ページの出品者向け「オークションの編集」で判定。
      const pageProbe = await probeYahooAuctionOwnership(tabId);
      isOwner = !!pageProbe.isOwner;
      if (!isOwner) {
        // 終了済みオークション: 再出品ページが操作できれば自分のもの。
        await chrome.tabs.update(tabId, {
          url:
            "https://auctions.yahoo.co.jp/sell/jp/show/resubmit?aID=" +
            encodeURIComponent(listingId),
        });
        await waitForTabComplete(tabId, 45000);
        await remoteSleep(1800);
        const rp = await probeYahooResubmit(tabId, listingId);
        isOwner = !!(rp && rp.operable);
      }
      if (!isOwner) {
        // 最後の保険: 自分の出品中一覧に載っているか走査する。
        try {
          isOwner = await scanSellingListForItem(tabId, listingId);
        } catch (e) {
          /* 走査失敗時は未所有として扱う */
        }
      }
    } else {
      const m = String(task.itemUrl || "").match(/\/item\/(m[A-Za-z0-9]+)/);
      listingId = m && m[1];
      if (!listingId) throw new Error("商品 ID を特定できませんでした");
      const tab = await chrome.tabs.create({ url: task.itemUrl, active: false });
      tabId = tab.id;
      await waitForTabComplete(tabId, 45000);
      await remoteSleep(2500);
      const probe = await probeMercariOwnership(tabId);
      isOwner = !!probe.isOwner;
    }
    if (isOwner) {
      await managerFetch(cfg, "/api/claims", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: task.platform,
          listingId,
          taskId: task.id,
        }),
      });
      await setManagerConfig({
        lastStatus: "所有権を確認しました: " + (task.product_no || listingId),
      });
    } else {
      await managerFetch(cfg, "/api/tasks/" + encodeURIComponent(task.id) + "/result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ok: false,
          notOwner: true,
          message: "このブラウザの商品ではありません",
        }),
      });
      await setManagerConfig({
        lastStatus: "所有権なし（確認タスク）: " + (task.product_no || listingId),
      });
    }
  } catch (e) {
    console.warn("[FurimaCopy] verify task failed", e);
    await setManagerConfig({
      lastStatus: "所有権確認に失敗: " + String((e && e.message) || e),
    });
  } finally {
    if (tabId) {
      try {
        await chrome.tabs.remove(tabId);
      } catch (e) {}
    }
    stopKeepAlive();
  }
}

// Yahoo!オークションの管理タスクを実行する。再出品はプラットフォーム
// 自体の再出品ページを使う（コピーはしない）: 対象の再出品ページを開き、
// バッチ再出品と同じ処理で送信まで進め、出品中一覧で確認してから
// 管理プログラムへ結果を返す。再出品は同じオークション ID のまま。
async function executeYahooManagerTask(cfg, task) {
  const stopKeepAlive = startKeepAlive();
  const postResult = async (ok, listingUrl, message) => {
    try {
      await managerFetch(cfg, "/api/tasks/" + encodeURIComponent(task.id) + "/result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ok: !!ok,
          listingUrl: listingUrl || null,
          message: message || null,
        }),
      });
    } catch (e) {
      console.warn("[FurimaCopy] manager result post failed", e);
    }
    await setManagerConfig({
      lastStatus: (ok ? "完了: " : "失敗: ") + (message || task.title || task.id),
    });
  };
  let workTabId = null;
  let keepWorkTab = false;
  try {
    await managerFetch(cfg, "/api/tasks/" + encodeURIComponent(task.id) + "/claim", {
      method: "POST",
    });
    await setManagerConfig({ lastStatus: "実行中: " + (task.title || task.id) });
    if (!task.autoSubmit) {
      throw new Error("自動出品が無効なタスクのため実行しませんでした");
    }
    const m =
      String(task.itemUrl || "").match(/\/jp\/auction\/([a-zA-Z]?\d+)/) ||
      String(task.itemUrl || "").match(/^([a-zA-Z]?\d+)$/);
    const itemId = m && m[1];
    if (!itemId) {
      throw new Error("タスクのオークション ID を特定できませんでした: " + (task.itemUrl || ""));
    }
    const workTab = await chrome.tabs.create({ active: true });
    workTabId = workTab.id;
    // Yahoo の再出品は新しいオークション ID で公開される。送信後に
    // 出品中一覧でタイトルから新しい ID を特定するため、先に旧商品
    // ページでタイトルを取得しておく。
    const itemTitle = await getYahooAuctionTitle(workTabId, itemId);
    // v0.12.0 所有権ゲート: 再出品ページが操作できなければ他アカウントの
    // 商品とみなし、タスクを失敗にせずキューへ返却する。
    await chrome.tabs.update(workTabId, {
      url:
        "https://auctions.yahoo.co.jp/sell/jp/show/resubmit?aID=" +
        encodeURIComponent(itemId),
    });
    await waitForTabComplete(workTabId, 45000);
    await remoteSleep(1800);
    const yahooProbe = await probeYahooResubmit(workTabId, itemId);
    if (yahooProbe.alreadyRelisted) {
      // すでに再出品済み: 現在の出品は新しい ID で公開されているはず。
      // タイトルで出品中一覧を引き、現在の ID を特定して記録させる。
      // 特定できなければ旧 ID のまま完了にせず、失敗として返す。
      const liveId = await resolveYahooRelistedId(workTabId, itemId, itemTitle);
      if (liveId) {
        await postResult(
          true,
          "https://auctions.yahoo.co.jp/jp/auction/" + liveId,
          liveId !== itemId
            ? "すでに再出品済みでした（現在の出品 " + liveId + " を記録しました）"
            : "すでに再出品済みでした（このオークションは再出品されています）"
        );
      } else {
        await postResult(
          false,
          null,
          "すでに再出品済みでしたが、出品中一覧で現在の出品を特定できませんでした"
        );
      }
      return;
    }
    if (!yahooProbe.operable) {
      await releaseManagerTask(cfg, task, "not-owner");
      await setManagerConfig({
        lastStatus:
          "所有権なしのためタスクを返却しました（ヤフオク " + itemId + "）: " +
          (yahooProbe.reason || "再出品ページが操作できません"),
      });
      return;
    }
    const relistRes = await processYahooRelistItem(workTabId, {
      id: itemId,
      title: itemTitle || "",
    });
    const newId = (relistRes && relistRes.listingId) || itemId;
    await postResult(
      true,
      "https://auctions.yahoo.co.jp/jp/auction/" + newId,
      newId !== itemId
        ? "ヤフオク再出品が完了しました（新 ID: " + newId + "）"
        : "ヤフオク再出品が完了しました"
    );
  } catch (e) {
    keepWorkTab = !!workTabId;
    await postResult(false, null, String((e && e.message) || e));
  } finally {
    if (workTabId && !keepWorkTab) {
      try {
        await chrome.tabs.remove(workTabId);
      } catch (e) {
        /* Tab may already be closed. */
      }
    }
    stopKeepAlive();
  }
}

// ============================================================
// 自動下架タスク（v0.12.14、Mercari は v0.12.26 で仕様変更）
// プログラムの「自動下架」スイッチが ON のレコードについて、在庫より
// 出品が多くなったときに余剰分を落とす。
//   Mercari: 出品を「一時停止」する（2026-11-22 ユーザーが仕様変更。
//            削除すると商品 ID が消え、次に売るとき辿れなくなるため。
//            停止なら ID は残り、再開もできる）。結果は paused:true で
//            返し、プログラム側は ID を保持したまま「一時停止」状態に
//            する。補充は従来どおりコピー再出品（ユーザー確定）。
//   Yahoo:   入札 0 件なら「取り消し」。入札があれば絶対に触らず、
//            hasBids で返してプログラム側で手動対応に回す。
// どちらも所有権ゲート必須・操作後の検証必須・fail-closed。
// Mercari の一時停止ボタンは編集ページ末尾にある（実ページで確認済:
// 商品ページには無い）。押した後の確認モーダルの有無は未確認のため、
// 確認ボタンが現れた場合だけ押し、成否は編集ページを開き直して
// 「再開」ボタンの出現で検証する。
// ============================================================

function delistPostResultFactory(cfg, task) {
  return async (ok, message, extra) => {
    try {
      await managerFetch(cfg, "/api/tasks/" + encodeURIComponent(task.id) + "/result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ok: !!ok,
          listingUrl: null,
          message: message || null,
          hasBids: !!(extra && extra.hasBids),
          paused: !!(extra && extra.paused),
        }),
      });
    } catch (e) {
      console.warn("[FurimaCopy] delist result post failed", e);
    }
    await setManagerConfig({
      lastStatus: (ok ? "下架完了: " : "下架失敗: ") + (message || task.id),
    });
  };
}

async function executeMercariDelistTask(cfg, task) {
  const stopKeepAlive = startKeepAlive();
  const postResult = delistPostResultFactory(cfg, task);
  let tabId = null;
  try {
    await managerFetch(cfg, "/api/tasks/" + encodeURIComponent(task.id) + "/claim", {
      method: "POST",
    });
    await setManagerConfig({ lastStatus: "下架実行中: " + (task.title || task.id) });
    const itemId = (String(task.itemUrl || "").match(/(m\d+)/) || [])[1];
    if (!itemId) throw new Error("タスクの商品 ID を特定できませんでした: " + (task.itemUrl || ""));
    const tab = await chrome.tabs.create({ url: task.itemUrl, active: true });
    tabId = tab.id;
    try {
      await chrome.tabs.update(tabId, { autoDiscardable: false });
    } catch (e) {
      /* noop */
    }
    await waitForTabComplete(tabId, 45000);
    await remoteSleep(2500);
    // 所有権ゲート（出品中ページの出品者コントロールで判定）。
    const probe = await probeMercariOwnership(tabId);
    if (!probe.isOwner) {
      await releaseManagerTask(cfg, task, "not-owner");
      await setManagerConfig({
        lastStatus: "下架をキューへ返却（所有権なし）: " + itemId,
      });
      return;
    }
    // 編集ページへ遷移する。
    const toEdit = await chrome.scripting
      .executeScript({
        target: { tabId },
        func: () => {
          const visible = (el) => {
            const s = getComputedStyle(el);
            return s.display !== "none" && s.visibility !== "hidden" && el.getClientRects().length > 0;
          };
          const cands = Array.from(document.querySelectorAll('a, button, [role="button"]')).filter(visible);
          const hit = cands.find((el) =>
            /商品の編集|編集する/.test(String(el.innerText || "").replace(/\s+/g, " ").trim())
          );
          if (!hit) return false;
          hit.click();
          return true;
        },
      })
      .then((r) => !!(r[0] && r[0].result))
      .catch(() => false);
    if (!toEdit) throw new Error("編集ボタンが見つかりませんでした");
    await waitForTabComplete(tabId, 45000);
    await remoteSleep(2500);
    // 編集ページ末尾の「出品を一時停止する」を押す。既に停止中なら
    // 「出品を再開する」系のボタンに変わっているので、その場合は
    // 何もせず成功（停止済み）として返す。
    const pauseAction = await chrome.scripting
      .executeScript({
        target: { tabId },
        func: () => {
          const visible = (el) => {
            const s = getComputedStyle(el);
            return s.display !== "none" && s.visibility !== "hidden" && el.getClientRects().length > 0;
          };
          const cands = Array.from(document.querySelectorAll('a, button, [role="button"]')).filter(visible);
          const texts = cands.map((el) => String(el.innerText || "").replace(/\s+/g, " ").trim());
          const pauseHit = cands[texts.indexOf("出品を一時停止する")];
          if (pauseHit) {
            pauseHit.scrollIntoView({ block: "center" });
            pauseHit.click();
            return "clicked";
          }
          if (texts.some((t) => t.includes("再開"))) return "already";
          return "missing";
        },
      })
      .then((r) => (r[0] && r[0].result) || "missing")
      .catch(() => "missing");
    if (pauseAction === "already") {
      await postResult(true, "既に一時停止中でした: " + itemId, { paused: true });
      return;
    }
    if (pauseAction !== "clicked") throw new Error("一時停止ボタン（出品を一時停止する）が見つかりませんでした");
    await remoteSleep(1800);
    // 確認モーダルが出た場合だけ、その「一時停止する」を押す
    // （キャンセル側は絶対に押さない）。モーダルが無ければ何もしない。
    await chrome.scripting
      .executeScript({
        target: { tabId },
        func: () => {
          const visible = (el) => {
            const s = getComputedStyle(el);
            return s.display !== "none" && s.visibility !== "hidden" && el.getClientRects().length > 0;
          };
          const cands = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible);
          const hit = cands.find((el) => {
            const t = String(el.innerText || "").replace(/\s+/g, " ").trim();
            return t === "一時停止する" || t === "停止する";
          });
          if (!hit) return false;
          hit.click();
          return true;
        },
      })
      .catch(() => false);
    await remoteSleep(2000);
    // 検証: 編集ページを開き直し、「再開」ボタンに変わっていて
    // 「出品を一時停止する」が消えていることを確かめる。
    await chrome.tabs.update(tabId, {
      url: "https://jp.mercari.com/sell/edit/" + encodeURIComponent(itemId),
      active: true,
    });
    await waitForTabComplete(tabId, 45000);
    await remoteSleep(2500);
    const verified = await chrome.scripting
      .executeScript({
        target: { tabId },
        func: () => {
          const visible = (el) => {
            const s = getComputedStyle(el);
            return s.display !== "none" && s.visibility !== "hidden" && el.getClientRects().length > 0;
          };
          const cands = Array.from(document.querySelectorAll('a, button, [role="button"]')).filter(visible);
          const labels = cands.map((el) => String(el.innerText || "").replace(/\s+/g, " ").trim());
          const hasResume = labels.some((t) => t.includes("再開"));
          const hasPause = labels.some((t) => t === "出品を一時停止する");
          return hasResume && !hasPause;
        },
      })
      .then((r) => !!(r[0] && r[0].result))
      .catch(() => false);
    if (!verified) throw new Error("一時停止を確認できませんでした（編集ページが停止状態になっていません）");
    await postResult(true, "出品を一時停止しました: " + itemId, { paused: true });
  } catch (e) {
    await postResult(false, String((e && e.message) || e));
  } finally {
    if (tabId != null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch (e) {}
    }
    stopKeepAlive();
  }
}

// Yahoo 商品ページから入札件数を読み取る。読めなければ null（=中止）。
async function readYahooBidCount(tabId) {
  const results = await chrome.scripting
    .executeScript({
      target: { tabId },
      func: () => {
        const scripts = Array.from(document.querySelectorAll("script"))
          .map((s) => s.textContent || "")
          .join("\n");
        let m = scripts.match(/"(?:bidCount|bids|bid_count)"\s*:\s*(\d+)/);
        if (m) return parseInt(m[1], 10);
        const text = String(document.body ? document.body.innerText || "" : "");
        m = text.match(/入札件数\s*[:：]?\s*(\d+)\s*件/);
        if (m) return parseInt(m[1], 10);
        m = text.match(/入札\s*[:：]\s*(\d+)\s*件/);
        if (m) return parseInt(m[1], 10);
        if (/入札はありません|入札履歴はありません/.test(text)) return 0;
        return null;
      },
    })
    .catch(() => null);
  const v = results && results[0] ? results[0].result : null;
  return typeof v === "number" && isFinite(v) ? v : null;
}

async function executeYahooDelistTask(cfg, task) {
  const stopKeepAlive = startKeepAlive();
  const postResult = delistPostResultFactory(cfg, task);
  let tabId = null;
  try {
    await managerFetch(cfg, "/api/tasks/" + encodeURIComponent(task.id) + "/claim", {
      method: "POST",
    });
    await setManagerConfig({ lastStatus: "下架実行中: " + (task.title || task.id) });
    const m =
      String(task.itemUrl || "").match(/\/jp\/auction\/([a-zA-Z]?\d+)/) ||
      String(task.itemUrl || "").match(/^([a-zA-Z]?\d+)$/);
    const itemId = m && m[1];
    if (!itemId) throw new Error("タスクのオークション ID を特定できませんでした: " + (task.itemUrl || ""));
    const tab = await chrome.tabs.create({ url: task.itemUrl, active: true });
    tabId = tab.id;
    try {
      await chrome.tabs.update(tabId, { autoDiscardable: false });
    } catch (e) {
      /* noop */
    }
    await waitForTabComplete(tabId, 45000);
    await remoteSleep(2000);
    // 所有権ゲート: 商品ページの出品者信号 → 出品中一覧の在席確認。
    const probe = await probeYahooAuctionOwnership(tabId);
    if (!probe.isOwner) {
      const inList = await scanSellingListForItem(tabId, itemId);
      if (!inList) {
        await releaseManagerTask(cfg, task, "not-owner");
        await setManagerConfig({
          lastStatus: "下架をキューへ返却（所有権なし）: " + itemId,
        });
        return;
      }
      await chrome.tabs.update(tabId, { url: task.itemUrl, active: true });
      await waitForTabComplete(tabId, 45000);
      await remoteSleep(1500);
    }
    // 入札チェック: 1件でもあれば絶対に触らない。読めなくても触らない。
    const bids = await readYahooBidCount(tabId);
    if (bids === null) {
      throw new Error("入札件数を確認できなかったため、取消しを中止しました");
    }
    if (bids > 0) {
      await postResult(
        false,
        "入札が " + bids + " 件あるため自動取消しを中止しました（手動対応に回します）",
        { hasBids: true }
      );
      return;
    }
    // 取消し導線: 商品ページ上の「取り消し」系コントロールを探す。
    const cancelClicked = await chrome.scripting
      .executeScript({
        target: { tabId },
        func: () => {
          const visible = (el) => {
            const s = getComputedStyle(el);
            return s.display !== "none" && s.visibility !== "hidden" && el.getClientRects().length > 0;
          };
          const cands = Array.from(document.querySelectorAll('a, button, [role="button"]')).filter(visible);
          const hit = cands.find((el) => {
            const t = String(el.innerText || "").replace(/\s+/g, " ").trim();
            return /出品の取り消し|出品を取り消す|この出品を取り消す|オークションの取り消し/.test(t);
          });
          if (!hit) return false;
          hit.click();
          return true;
        },
      })
      .then((r) => !!(r[0] && r[0].result))
      .catch(() => false);
    if (!cancelClicked) {
      throw new Error("取り消しボタンが見つかりませんでした（導線は実機確認で詰めます）");
    }
    await waitForTabComplete(tabId, 45000);
    await remoteSleep(1800);
    // 確認モーダル（実機 2026-11-23、ユーザー提示）: 「オークションの
    // 取り消し」モーダルでは「オプション利用料等の説明を確認した」に
    // チェックを入れるまで「出品を取り消す」が無効（グレー）のまま。
    // 旧実装は無効なボタンを押して成功扱いにし、検証で失敗していた
    // （＝マネージャ側の「取消しを確認できませんでした」の正体）。
    // チェック → 有効化を待って押す、の順。キャンセル系は絶対に押さない。
    const feeState = await chrome.scripting
      .executeScript({
        target: { tabId },
        func: () => {
          const visible = (el) => {
            const s = getComputedStyle(el);
            return s.display !== "none" && s.visibility !== "hidden" && el.getClientRects().length > 0;
          };
          const labels = Array.from(document.querySelectorAll("label")).filter(visible);
          const lab = labels.find((el) =>
            String(el.innerText || "").includes("オプション利用料等の説明を確認した")
          );
          let box = null;
          if (lab) {
            box = lab.querySelector('input[type="checkbox"]');
            if (!box && lab.htmlFor) box = document.getElementById(lab.htmlFor);
          }
          if (!box) {
            box =
              Array.from(document.querySelectorAll('input[type="checkbox"]'))
                .filter(visible)
                .find((el) => {
                  const row = el.closest("label, div, p, li");
                  return (
                    row &&
                    String(row.innerText || "").includes("オプション利用料等の説明を確認した")
                  );
                }) || null;
          }
          if (!box) return "notfound";
          if (!box.checked) {
            box.click();
            if (!box.checked && lab) lab.click();
          }
          return box.checked ? "checked" : "unchecked";
        },
      })
      .then((r) => (r[0] && r[0].result) || "notfound")
      .catch(() => "notfound");
    if (feeState === "unchecked") {
      throw new Error("オプション利用料の確認チェックを入れられませんでした");
    }
    // 「出品を取り消す」が有効になるまで待って押す（最大 ~6 秒ポーリング）。
    let confirmed = false;
    for (let attempt = 0; attempt < 8 && !confirmed; attempt++) {
      confirmed = await chrome.scripting
        .executeScript({
          target: { tabId },
          func: () => {
            const visible = (el) => {
              const s = getComputedStyle(el);
              return s.display !== "none" && s.visibility !== "hidden" && el.getClientRects().length > 0;
            };
            const cands = Array.from(
              document.querySelectorAll('button, a, [role="button"], input[type="submit"]')
            ).filter(visible);
            const hit = cands.find((el) => {
              const t = String(el.innerText || el.value || "").replace(/\s+/g, " ").trim();
              if (/キャンセル|やめる|戻る|取り消さない/.test(t)) return false;
              return /^(取り消しする|出品を取り消す|取り消す|この出品を取り消す)$/.test(t);
            });
            if (!hit) return false;
            if (hit.disabled || hit.getAttribute("aria-disabled") === "true") return false;
            hit.click();
            return true;
          },
        })
        .then((r) => !!(r[0] && r[0].result))
        .catch(() => false);
      if (!confirmed) await remoteSleep(800);
    }
    if (!confirmed) throw new Error("取り消しの確認ボタンが見つからないか、有効になりませんでした");
    await remoteSleep(2500);
    // 検証: 出品中一覧から消えていること。
    const stillListed = await scanSellingListForItem(tabId, itemId);
    if (stillListed) {
      throw new Error("取消しを確認できませんでした（出品中一覧に残っています）");
    }
    await postResult(true, "出品を取り消しました: " + itemId);
  } catch (e) {
    await postResult(false, String((e && e.message) || e));
  } finally {
    if (tabId != null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch (e) {}
    }
    stopKeepAlive();
  }
}

// ---- 同梱拡張の自動更新（v0.12.30） --------------------------------------
// 管理プログラム（v0.2.18+）は同梱した拡張を実フォルダへ配置し、ポーリング
// 応答の extVersion で「配置済みの版」を知らせる。自版より新しく、かつ
// タスク実行・リモート指令・再出品・スキャン・画像取込のどれも動いて
// いないときだけ chrome.runtime.reload() で読み直す（開いている出品
// フォームのタブは従来どおりページ更新まで旧スクリプトのまま）。
// 読み直しても版が上がらない場合に備え、同一版への試行は 10 分間隔で
// 最大 3 回まで（chrome.storage.local に記録し、SW 再起動をまたぐ）。
function compareVersions(a, b) {
  const pa = String(a || "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

const EXT_UPDATE_KEY = "fcExtAutoUpdate";

async function maybeAutoUpdateExtension(serverVersion) {
  try {
    if (!serverVersion) return;
    const own = chrome.runtime.getManifest().version;
    if (compareVersions(serverVersion, own) <= 0) return;
    if (
      managerRunning ||
      yahooRelistRun ||
      soldScanRunning ||
      yahooScanRunning ||
      imageFetchInFlight > 0 ||
      Date.now() - lastImageFetchAt < 60 * 1000
    ) {
      return; // 仕事中は読み直さない。次回ポーリングで再挑戦する
    }
    const res = await chrome.storage.local.get(EXT_UPDATE_KEY);
    const st = res[EXT_UPDATE_KEY] || {};
    const now = Date.now();
    const sameTarget = st.target === serverVersion;
    if (sameTarget) {
      if ((st.attempts || 0) >= 3) return;
      if (now - (st.lastAt || 0) < 10 * 60 * 1000) return;
    }
    await chrome.storage.local.set({
      [EXT_UPDATE_KEY]: {
        target: serverVersion,
        attempts: sameTarget ? (st.attempts || 0) + 1 : 1,
        lastAt: now,
      },
    });
    await setManagerConfig({
      lastStatus: "拡張を自動更新します: v" + own + " → v" + serverVersion,
    });
    console.log("[FurimaCopy] auto-updating extension", own, "->", serverVersion);
    chrome.runtime.reload();
  } catch (e) {
    console.warn("[FurimaCopy] auto-update check failed", e);
  }
}

async function pollManagerTasks(why) {
  const cfg = await getManagerConfig();
  if (!cfg.enabled || managerRunning) return;
  let data;
  try {
    data = await managerFetch(cfg, "/api/tasks?status=pending");
    const patch = { lastPollAt: new Date().toISOString() };
    if (data.node) {
      patch.nodeId = data.node.id || null;
      patch.nodeName = data.node.name || null;
    }
    await setManagerConfig(patch);
  } catch (e) {
    await setManagerConfig({
      lastStatus: "接続できません（プログラム未起動？）",
    });
    return;
  }
  const task = (data.tasks || []).find(
    (t) => t.platform === "mercari" || t.platform === "yahoo"
  );
  if (!task) {
    await setManagerConfig({ lastStatus: "待機中（タスクなし） " + (why || "") });
    await maybeAutoUpdateExtension(data.extVersion);
    return;
  }
  managerRunning = true;
  try {
    if (task.type === "verify") await executeVerifyTask(cfg, task);
    else if (task.type === "healthscan") await executeHealthScanTask(cfg, task);
    else if (task.type === "delist" && task.platform === "yahoo")
      await executeYahooDelistTask(cfg, task);
    else if (task.type === "delist") await executeMercariDelistTask(cfg, task);
    else if (task.platform === "yahoo") await executeYahooManagerTask(cfg, task);
    else await executeManagerTask(cfg, task);
  } catch (e) {
    console.warn("[FurimaCopy] manager task failed", e);
  } finally {
    managerRunning = false;
  }
  await maybeAutoUpdateExtension(data.extVersion);
}

async function executeManagerTask(cfg, task) {
  const stopKeepAlive = startKeepAlive();
  const startedAt = Date.now();
  const base = String(cfg.baseUrl || "").replace(/\/$/, "");
  const postResult = async (ok, listingUrl, message) => {
    try {
      await managerFetch(cfg, "/api/tasks/" + encodeURIComponent(task.id) + "/result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ok: !!ok,
          listingUrl: listingUrl || null,
          message: message || null,
        }),
      });
    } catch (e) {
      console.warn("[FurimaCopy] manager result post failed", e);
    }
    await setManagerConfig({
      lastStatus:
        (ok ? "完了: " : "失敗: ") + (message || task.title || task.id),
    });
  };
  try {
    await managerFetch(cfg, "/api/tasks/" + encodeURIComponent(task.id) + "/claim", {
      method: "POST",
    });

    let expectedSourceItemId = null;
    if (task.type === "relist") {
      // ---- 再出品タスク: 参照商品ページを開き、通常のコピーで staging ----
      // タイトル・説明・価格・画像はすべて参照商品からコピーする
      // （管理プログラムのローカル画像は使わない）。
      if (
        !/^https:\/\/jp\.mercari\.com\/item\/[A-Za-z0-9]+/.test(
          task.itemUrl || ""
        )
      ) {
        throw new Error("参照商品の URL が不正です: " + (task.itemUrl || ""));
      }
      const itemTab = await chrome.tabs.create({
        url: task.itemUrl,
        active: true,
      });
      try {
        await chrome.tabs.update(itemTab.id, { autoDiscardable: false });
      } catch (e) {
        /* noop */
      }
      await waitForTabComplete(itemTab.id, 45000);
      await remoteSleep(3000); // SPA の描画待ち
      // v0.12.0 所有権ゲート: 出品者向けコントロールが見えなければ
      // 他アカウントの商品とみなし、タスクを失敗にせずキューへ返却する。
      const ownProbe = await probeMercariOwnership(itemTab.id);
      if (!ownProbe.isOwner) {
        try {
          await chrome.tabs.remove(itemTab.id);
        } catch (e) {
          /* noop */
        }
        await releaseManagerTask(cfg, task, "not-owner");
        await setManagerConfig({
          lastStatus:
            "所有権なしのためタスクを返却しました（メルカリ " +
            (task.product_no || task.id) +
            "）",
        });
        return;
      }
      const copyRes = await sendToTabWithRetry(
        itemTab.id,
        { type: "FurimaRemoteCopy" },
        20,
        3000
      );
      if (!copyRes || !copyRes.ok) {
        throw new Error(
          "参照商品の読み取り失敗: " +
            ((copyRes && copyRes.error) || "不明なエラー")
        );
      }
      const expectedSourceId =
        String(task.itemUrl || "").match(/\/item\/(m[A-Za-z0-9]+)/) || [];
      expectedSourceItemId = expectedSourceId[1] || null;
      const copiedSourceId =
        copyRes.summary &&
        String(copyRes.summary.sourceUrl || "").match(/\/item\/(m[A-Za-z0-9]+)/);
      const sourceMismatch =
        !expectedSourceId[1] ||
        !copiedSourceId ||
        copiedSourceId[1] !== expectedSourceId[1];
      try {
        await chrome.tabs.remove(itemTab.id);
      } catch (e) {
        /* noop */
      }
      if (sourceMismatch) {
        throw new Error(
          "参照商品 ID が一致しません（指定: " +
            (expectedSourceId[1] || "不明") +
            "、読み取り: " +
            ((copiedSourceId && copiedSourceId[1]) || "不明") +
            "）。出品を中止しました。"
        );
      }
      // 管理プログラムの商品番号を管理Noとして付け、タスク由来である
      // ことを copyData に印す（filler の表示と送信ガードが参照する）。
      const st = await chrome.storage.local.get("copyData");
      const cd = st.copyData || {};
      cd.inventoryCode = task.product_no || null;
      cd.managerTask = {
        id: task.id,
        autoSubmit: !!task.autoSubmit,
        sourceItemId: expectedSourceItemId,
        productNo: task.product_no || null,
      };
      await chrome.storage.local.set({ copyData: cd });
    } else {
    // ---- staging: copyData / copyImages を通常のコピーと同じ形で作る ----
    const sourceUrl = "manager://task/" + task.id;
    const imageUrls = (task.images || []).map(
      (p) => base + "/api/image?path=" + encodeURIComponent(p)
    );
    await chrome.storage.local.set({
      copyData: {
        source: task.platform,
        sourceUrl,
        title: task.title || null,
        description: task.description || null,
        price: task.price != null ? task.price : null,
        imageUrls,
        conditionText: task.conditionText || null,
        categoryText: task.categoryText || null,
        shippingText: task.shippingText || null,
        inventoryCode: task.product_no || null,
        managerTask: {
          id: task.id,
          autoSubmit: !!task.autoSubmit,
          sourceItemId: null,
          productNo: task.product_no || null,
        },
        copiedAt: new Date().toISOString(),
      },
    });
    const items = [];
    for (const u of imageUrls) {
      try {
        const r = await fetch(u, {
          headers: { "x-fc-token": cfg.token || "", "x-fc-node": await getNodeId() },
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const buf = await r.arrayBuffer();
        items.push({
          key: u,
          base64: arrayBufferToBase64(buf),
          type: r.headers.get("content-type") || "image/jpeg",
          via: "manager",
          capturedUrl: u,
        });
      } catch (e) {
        items.push({ key: u, base64: null, type: null, via: null, capturedUrl: null });
      }
    }
    await chrome.storage.local.set({
      copyImages: { sourceUrl, at: new Date().toISOString(), items },
    });
    }

    // ---- 出品ページを開いて自動入力（タスク指定時は出品まで） ----
    const managerFillRequest = {
      managerTaskId: task.id,
      autoSubmit: !!task.autoSubmit,
      productNo: task.product_no || null,
      sourceItemId: expectedSourceItemId,
    };
    if (task.platform !== "mercari") {
      await chrome.storage.local.set({
        autoFillRequest: {
          target: task.platform,
          at: Date.now(),
          status: "ready",
          ...managerFillRequest,
        },
      });
    }
    const tab = await chrome.tabs.create({
      url: MANAGER_SELL_URLS[task.platform],
      active: true,
    });
    try {
      await chrome.tabs.update(tab.id, { autoDiscardable: false });
    } catch (e) {
      /* noop */
    }
    if (task.platform === "mercari") {
      const loaded = await waitForTabComplete(tab.id, 45000);
      if (!loaded) throw new Error("Mercari 出品ページの読み込みがタイムアウトしました");
      const fillRes = await sendToTabWithRetry(
        tab.id,
        { type: "FurimaManagerAutoFill", request: managerFillRequest },
        15,
        1000
      );
      if (!fillRes || !fillRes.ok) {
        throw new Error(
          "Mercari 出品ページの自動入力を開始できませんでした: " +
            ((fillRes && fillRes.error) || "不明なエラー")
        );
      }
    }

    // ---- 結果待ち: 入力レポート →（autoSubmit 時）送信レポート ----
    const deadline = Date.now() + 4 * 60 * 1000;
    let fillReport = null;
    let submitReport = null;
    while (Date.now() < deadline) {
      await remoteSleep(2000);
      const st = await chrome.storage.local.get([
        "lastFillReport",
        "lastSubmitReport",
      ]);
      if (
        st.lastFillReport &&
        st.lastFillReport.at > startedAt &&
        (task.platform !== "mercari" || st.lastFillReport.taskId === task.id)
      ) {
        fillReport = st.lastFillReport;
      }
      if (
        st.lastSubmitReport &&
        st.lastSubmitReport.at > startedAt &&
        st.lastSubmitReport.taskId === task.id
      ) {
        submitReport = st.lastSubmitReport;
        break;
      }
      if (fillReport && !task.autoSubmit) break;
    }

    const manualSummary = fillReport
      ? (fillReport.lines || [])
          .filter((l) => l.status !== "ok" && !(l.label || "").includes("送信前確認"))
          .map((l) => l.label + (l.note ? ": " + l.note : ""))
          .join(" / ")
      : "";

    if (task.autoSubmit) {
      if (!submitReport) {
        await postResult(false, null, "出品結果を確認できませんでした（タイムアウト）");
        return;
      }
      await postResult(
        !!submitReport.ok,
        submitReport.listingUrl || null,
        [
          submitReport.message || (submitReport.ok ? "出品しました" : "出品失敗"),
          manualSummary ? "要確認: " + manualSummary : "",
        ]
          .filter(Boolean)
          .join(" ")
      );
      return;
    }
    if (!fillReport) {
      await postResult(false, null, "入力結果を確認できませんでした（タイムアウト）");
      return;
    }
    await postResult(
      true,
      null,
      "入力完了（自動出品 OFF）" + (manualSummary ? " 手動項目: " + manualSummary : "")
    );
  } catch (e) {
    await postResult(false, null, String((e && e.message) || e));
  } finally {
    stopKeepAlive();
  }
}

chrome.alarms.create(MANAGER_ALARM, { periodInMinutes: 1 });
function todoScanPeriodInMinutes(config) {
  const interval = Number(config.todoScanInterval);
  const unit = config.todoScanUnit;
  if (!Number.isInteger(interval) || interval < 1) {
    throw new Error("Todo 扫描间隔必须是正整数");
  }
  if (unit === "minutes" && interval <= 1440) return interval;
  if (unit === "hours" && interval <= 24) return interval * 60;
  throw new Error("Todo 扫描间隔无效：分钟最多 1440，小时最多 24");
}

async function updateTodoScanAlarm(config) {
  if (!config.todoScanEnabled) {
    await chrome.alarms.clear(TODO_SCAN_ALARM);
    return;
  }
  chrome.alarms.create(TODO_SCAN_ALARM, {
    periodInMinutes: todoScanPeriodInMinutes(config),
  });
}

function restoreTodoScanAlarm() {
  getManagerConfig()
    .then(updateTodoScanAlarm)
    .catch((error) => console.error("[FurimaCopy] failed to restore Todo scan schedule", error));
}

function yahooScanPeriodInMinutes(config) {
  const interval = Number(config.yahooScanInterval);
  const unit = config.yahooScanUnit;
  if (!Number.isInteger(interval) || interval < 1) {
    throw new Error("Yahoo 扫描间隔必须是正整数");
  }
  if (unit === "minutes" && interval <= 1440) return interval;
  if (unit === "hours" && interval <= 24) return interval * 60;
  throw new Error("Yahoo 扫描间隔无效：分钟最多 1440，小时最多 24");
}

async function updateYahooScanAlarm(config) {
  if (!config.yahooScanEnabled) {
    await chrome.alarms.clear(YAHOO_SCAN_ALARM);
    return;
  }
  chrome.alarms.create(YAHOO_SCAN_ALARM, {
    periodInMinutes: yahooScanPeriodInMinutes(config),
  });
}

function restoreYahooScanAlarm() {
  getManagerConfig()
    .then(updateYahooScanAlarm)
    .catch((error) => console.error("[FurimaCopy] failed to restore Yahoo scan schedule", error));
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(MANAGER_ALARM, { periodInMinutes: 1 });
  // リモート指令の廃止に伴う後片付け（v0.12.31）: 旧アラームと設定を消す。
  chrome.alarms.clear("fcRemotePoll");
  chrome.storage.local.remove(["remoteConfig", "lastRemoteResult"]);
  restoreTodoScanAlarm();
  restoreYahooScanAlarm();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(MANAGER_ALARM, { periodInMinutes: 1 });
  restoreTodoScanAlarm();
  restoreYahooScanAlarm();
  pollManagerTasks("startup");
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === MANAGER_ALARM) pollManagerTasks("alarm");
  if (alarm.name === TODO_SCAN_ALARM) {
    getManagerConfig()
      .then((config) => scanMercariSoldTodos(config))
      .catch((error) => console.error("[FurimaCopy] scheduled Todo scan failed", error));
  }
  if (alarm.name === YAHOO_SCAN_ALARM) {
    getManagerConfig()
      .then((config) => scanYahooSold(config))
      .catch((error) => console.error("[FurimaCopy] scheduled Yahoo scan failed", error));
  }
});
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "FurimaManagerSaveConfig") {
    (async () => {
      const interval = Number(msg.todoScanInterval);
      const unit = msg.todoScanUnit;
      const todoScanEnabled = !!msg.todoScanEnabled;
      todoScanPeriodInMinutes({
        todoScanInterval: interval,
        todoScanUnit: unit,
      });
      const yahooInterval = Number(msg.yahooScanInterval);
      const yahooUnit = msg.yahooScanUnit;
      const yahooScanEnabled = !!msg.yahooScanEnabled;
      yahooScanPeriodInMinutes({
        yahooScanInterval: yahooInterval,
        yahooScanUnit: yahooUnit,
      });
      const config = await setManagerConfig({
        enabled: !!msg.enabled,
        baseUrl: String(msg.baseUrl || "").trim() || "http://127.0.0.1:17341",
        token: String(msg.token || "").trim(),
        todoScanEnabled,
        todoScanInterval: interval,
        todoScanUnit: unit,
        yahooScanEnabled,
        yahooScanInterval: yahooInterval,
        yahooScanUnit: yahooUnit,
      });
      await updateTodoScanAlarm(config);
      await updateYahooScanAlarm(config);
      sendResponse({ ok: true });
    })().catch((error) => {
      sendResponse({ ok: false, error: String((error && error.message) || error) });
    });
    return true;
  }
  if (msg && msg.type === "FurimaYahooScanNow") {
    getManagerConfig()
      .then((config) => scanYahooSold(config, true))
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: String((error && error.message) || error),
      }));
    return true;
  }
  if (msg && msg.type === "FurimaTodoScanNow") {
    getManagerConfig()
      .then((config) => scanMercariSoldTodos(config, true))
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: String((error && error.message) || error),
      }));
    return true;
  }
  if (msg && msg.type === "FurimaManagerPollNow") {
    pollManagerTasks("manual").then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

// Yahoo! オークション「落札者なし」一覧を全ページ確認し、順番に再出品する。
const YAHOO_RELIST_STATE_KEY = "yahooRelistState";
const YAHOO_RELIST_MAX_ITEMS = 1000;
let yahooRelistRun = null;

function isYahooClosedNoWinnerUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.origin === "https://auctions.yahoo.co.jp" &&
      url.pathname === "/my/closed" &&
      url.searchParams.get("hasWinner") === "0"
    );
  } catch (e) {
    return false;
  }
}

async function scanYahooClosedPage(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const currentUrl = new URL(location.href);
      if (
        currentUrl.origin !== "https://auctions.yahoo.co.jp" ||
        currentUrl.pathname !== "/my/closed" ||
        currentUrl.searchParams.get("hasWinner") !== "0"
      ) {
        return { ok: false, error: "対象ページが「落札者なし」ではありません" };
      }
      const list = document.getElementById("itm") || document;
      const items = [];
      const seen = new Set();
      for (const link of list.querySelectorAll('a[href*="/sell/jp/show/resubmit"]')) {
        let url;
        try {
          url = new URL(link.href, location.href);
        } catch (e) {
          return { ok: false, error: "再出品リンクの URL を解析できませんでした" };
        }
        const id = url.searchParams.get("aID") || "";
        if (
          url.origin !== "https://auctions.yahoo.co.jp" ||
          url.pathname !== "/sell/jp/show/resubmit"
        ) {
          return { ok: false, error: "商品一覧に想定外の再出品リンクが含まれています" };
        }
        if (!/^[A-Za-z0-9]+$/.test(id)) {
          return { ok: false, error: "再出品リンクに有効な商品 ID がありません" };
        }
        if (seen.has(id)) continue;
        seen.add(id);
        const row = link.closest("tr, [role='row'], li") || link.parentElement;
        items.push({
          id,
          title: (row && row.textContent ? row.textContent : link.textContent || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 120),
        });
      }

      const links = Array.from(document.querySelectorAll("a[href]"));
      const isClosedListPageLink = (link) => {
        try {
          const url = new URL(link.href, location.href);
          return (
            url.origin === currentUrl.origin &&
            url.pathname === currentUrl.pathname &&
            url.searchParams.get("hasWinner") === "0" &&
            url.href !== currentUrl.href
          );
        } catch (e) {
          return false;
        }
      };
      const findPageLink = (pattern) => links.find((link) => {
        if (!isClosedListPageLink(link)) return false;
        const label = [
          link.innerText,
          link.getAttribute("aria-label"),
          link.getAttribute("title"),
        ]
          .filter(Boolean)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        return pattern.test(label);
      });
      const findRelPageLink = (rel) =>
        links.find(
          (link) =>
            isClosedListPageLink(link) && link.rel.split(/\s+/).includes(rel)
        );
      const parsePageUrl = (link) => {
        if (!link) return null;
        const parsedNext = new URL(link.href, location.href);
        if (
          parsedNext.origin === currentUrl.origin &&
          parsedNext.pathname === currentUrl.pathname &&
          parsedNext.searchParams.get("hasWinner") === "0" &&
          parsedNext.href !== currentUrl.href
        ) {
          return parsedNext.href;
        }
        return null;
      };
      const nextUrl = parsePageUrl(
        findRelPageLink("next") ||
          findPageLink(/^(次へ|次のページ|次ページ|次の\d+件|›|»|>)(?:\s|[（(]|$)/)
      );
      const previousUrl = parsePageUrl(
        findRelPageLink("prev") ||
          findPageLink(/^(前へ|前のページ|前ページ|前の\d+件|‹|«|<)(?:\s|[（(]|$)/)
      );
      return { ok: true, items, nextUrl, previousUrl };
    },
  });
  const scan = results[0] && results[0].result;
  if (!scan || !scan.ok) {
    throw new Error((scan && scan.error) || "商品一覧を読み取れませんでした");
  }
  return scan;
}

async function scanYahooClosedTab(tabId) {
  const sourceTab = await chrome.tabs.get(tabId);
  if (!isYahooClosedNoWinnerUrl(sourceTab.url || "")) {
    throw new Error("「落札者なし」（hasWinner=0）の出品終了分ページを開いてください");
  }
  const scanTab = await chrome.tabs.create({ url: sourceTab.url, active: false });
  const items = [];
  const seenItems = new Set();
  const seenPages = new Set();
  const pagesBackToFirst = [];
  const addItems = (page) => {
    for (const item of page.items) {
      if (seenItems.has(item.id)) continue;
      seenItems.add(item.id);
      items.push(item);
      if (items.length > YAHOO_RELIST_MAX_ITEMS) {
        throw new Error("対象が多すぎます。表示件数を減らしてから実行してください");
      }
    }
  };
  try {
    if (!(await waitForTabComplete(scanTab.id, 45000))) {
      throw new Error("商品一覧ページの読み込みがタイムアウトしました");
    }

    const backwardPages = new Set();
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const currentTab = await chrome.tabs.get(scanTab.id);
      const currentUrl = currentTab.url || "";
      if (backwardPages.has(currentUrl)) {
        throw new Error("商品一覧の前ページ移動でループを検出しました");
      }
      backwardPages.add(currentUrl);
      const page = await scanYahooClosedPage(scanTab.id);
      pagesBackToFirst.push(page);
      if (!page.previousUrl) break;
      await chrome.tabs.update(scanTab.id, { url: page.previousUrl });
      if (!(await waitForTabComplete(scanTab.id, 45000))) {
        throw new Error("前の商品一覧ページの読み込みがタイムアウトしました");
      }
      await remoteSleep(500);
      if (pageNumber === 99) {
        throw new Error("商品一覧のページ数が上限を超えました");
      }
    }
    backwardPages.forEach((url) => seenPages.add(url));

    for (let index = pagesBackToFirst.length - 1; index >= 0; index--) {
      addItems(pagesBackToFirst[index]);
    }

    let nextUrl = pagesBackToFirst[0] && pagesBackToFirst[0].nextUrl;
    for (let pageNumber = 0; nextUrl; pageNumber++) {
      if (pageNumber >= 100 || seenPages.size >= 100) {
        throw new Error("商品一覧のページ数が上限を超えました");
      }
      await chrome.tabs.update(scanTab.id, { url: nextUrl });
      if (!(await waitForTabComplete(scanTab.id, 45000))) {
        throw new Error("次の商品一覧ページの読み込みがタイムアウトしました");
      }
      await remoteSleep(700);
      const currentTab = await chrome.tabs.get(scanTab.id);
      const currentUrl = currentTab.url || "";
      if (seenPages.has(currentUrl)) {
        throw new Error("商品一覧のページ移動でループを検出しました");
      }
      seenPages.add(currentUrl);

      const page = await scanYahooClosedPage(scanTab.id);
      addItems(page);
      nextUrl = page.nextUrl;
    }
    return items;
  } finally {
    try {
      await chrome.tabs.remove(scanTab.id);
    } catch (e) {
      /* Scan tab may already be closed. */
    }
  }
}

async function setYahooRelistState(state) {
  const saved = Object.assign({}, state, { updatedAt: new Date().toISOString() });
  await chrome.storage.local.set({ [YAHOO_RELIST_STATE_KEY]: saved });
  return saved;
}

function sameYahooRelistIds(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

async function inspectAndAdvanceYahooRelist(
  tabId,
  expectedId,
  reviewClicks,
  finalSubmitAlreadyClicked
) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    args: [expectedId, reviewClicks, finalSubmitAlreadyClicked],
    func: (itemId, priorReviewClicks, didFinalSubmit) => {
      const url = new URL(location.href);
      if (url.origin !== "https://auctions.yahoo.co.jp") {
        return { status: "error", error: "Yahoo! オークション以外のページへ移動しました" };
      }
      const auctionPath = url.pathname.match(/^\/jp\/auction\/([a-zA-Z]?\d+)$/);
      if (auctionPath && auctionPath[1] !== itemId) {
        // 送信後に新しい商品ページへ着地した場合は、それが新しい ID。
        return { status: "success", listingId: auctionPath[1] };
      }
      const isPreviewPage = url.pathname === "/sell/jp/show/preview";
      const visibleText = (el) => {
        if (!el || !el.getClientRects().length) return "";
        const text =
          el.tagName === "INPUT"
            ? el.value || el.getAttribute("aria-label") || ""
            : el.innerText || el.getAttribute("aria-label") || el.value || "";
        return String(text)
          .replace(/\s+/g, " ")
          .trim();
      };
      const notices = Array.from(
        document.querySelectorAll('h1, h2, [role="alert"], [role="status"], [class*="success"], [class*="complete"]')
      ).map(visibleText).filter(Boolean);
      if (
        notices.some((text) =>
          /再出品が完了しました|再出品しました|出品が完了しました|出品しました|出品完了/.test(text)
        )
      ) {
        return { status: "success" };
      }
      // 完了ページ（/sell/jp/config/submit）は「出品手続きが完了しました」と
      // 商品タイトルだけを表示し、新しい商品へのリンクは無い。タイトルを
      // 拾っておき、呼び出し側が出品中一覧で新しい ID を特定する材料にする。
      const extractCompletionTitle = () => {
        const marker = "出品手続きが完了しました";
        if (!String(document.body ? document.body.innerText || "" : "").includes(marker)) return null;
        const boxes = Array.from(document.querySelectorAll("div, section, td, p"))
          .filter((el) => el.innerText && el.innerText.includes(marker))
          .sort((a, b) => a.innerText.length - b.innerText.length);
        if (!boxes.length) return null;
        const lines = boxes[0].innerText
          .split("\n")
          .map((s) => s.replace(/\s+/g, " ").trim())
          .filter((l) => l && !l.includes(marker) && !/ご利用ありがとうございました/.test(l) && l.length >= 8);
        lines.sort((a, b) => b.length - a.length);
        return lines[0] || null;
      };
      const completionTitle = extractCompletionTitle();
      if (completionTitle) return { status: "verify", completionTitle };
      if (!url.pathname.startsWith("/sell/jp/show/")) {
        // 送信クリック後は /sell/jp/config/submit のような完了側のページへ
        // 遷移して終わることがある。成否は出品中一覧で確かめる。
        if (didFinalSubmit) return { status: "verify" };
        return {
          status: "error",
          error: "再出品後の完了を確認できないページへ移動しました: " + url.pathname,
        };
      }
      const pageItemId = url.searchParams.get("aID");
      if (pageItemId && pageItemId !== itemId) {
        return { status: "error", error: "再出品ページの商品 ID が一致しません" };
      }
      if (didFinalSubmit) return { status: "pending" };

      const finalLabels = new Set([
        "出品する",
        "再出品する",
        "この内容で再出品する",
        "この内容で出品する",
        "出品を確定する",
        "上記のガイドライン、規約、情報提供等に同意して出品する",
        "上記のガイドライン、規約、情報提供等に同意して 出品する",
        "ガイドラインと上記規約等に同意して 出品する",
        "ガイドラインと上記規約等に同意して出品する",
      ]);
      const reviewLabels = new Set([
        "確認する",
        "入力内容を確認する",
        "確認画面へ",
        "出品する",
        "再出品する",
      ]);
      // 確認ページの最終ボタンは文言のバリエーションがある（実例:
      // 「ガイドラインと上記規約等に同意して 出品する」）。ガイドライン
      // 同意に触れていて「出品する」で終わるラベルも最終送信とみなす。
      const isFinalLabel = (label) =>
        finalLabels.has(label) ||
        (label.includes("ガイドライン") && label.endsWith("出品する"));
      const scope =
        document.querySelector("main") ||
        document.querySelector('[role="main"]') ||
        document.body;
      if (!scope) {
        return { status: "pending" };
      }
      const listControls = (root) =>
        Array.from(
          root.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]')
        )
          .filter((el) => {
            const style = getComputedStyle(el);
            return style.display !== "none" && style.visibility !== "hidden" && el.getClientRects().length > 0;
          })
          .map((el) => ({ el, label: visibleText(el) }));
      const pickMatches = (labeled) =>
        labeled.filter(({ label }) =>
          isPreviewPage ? isFinalLabel(label) : reviewLabels.has(label)
        );
      let labeledControls = listControls(scope);
      let matches = pickMatches(labeledControls);
      if (!matches.length && document.body && scope !== document.body) {
        // main スコープの外にボタンがあるページバリエーション向けの保険。
        const bodyControls = listControls(document.body);
        const bodyMatches = pickMatches(bodyControls);
        if (bodyMatches.length) {
          labeledControls = bodyControls;
          matches = bodyMatches;
        }
      }
      const previousClick =
        window.__fcYahooRelistClickedFor === itemId
          ? window.__fcYahooRelistClickedKind
          : null;
      if (previousClick === "submit") return { status: "pending" };
      if (
        previousClick === "review" &&
        !matches.some(({ label }) => isPreviewPage && isFinalLabel(label))
      ) {
        return { status: "pending" };
      }
      if (matches.length !== 1) {
        return {
          status: "error",
          error: matches.length
            ? "出品操作ボタンを一意に特定できませんでした"
            : "安全に押せる再出品ボタンが見つかりませんでした（可见操作：" +
              labeledControls.map(({ label }) => label).filter(Boolean).slice(0, 8).join(" / ") +
              "）",
        };
      }
      const match = matches[0];
      const kind = isPreviewPage ? "submit" : "review";
      if (kind === "review" && priorReviewClicks >= 3) {
        return { status: "error", error: "確認ページが多すぎるため停止しました" };
      }
      window.__fcYahooRelistClickedFor = itemId;
      window.__fcYahooRelistClickedKind = kind;
      match.el.click();
      return { status: "clicked", kind, label: match.label };
    },
  });
  return results[0] && results[0].result;
}

// 出品中一覧を全ページ走査し、対象の商品 ID が載っているか返す。
// 所有権確認用（特定 ID の存在確認）。再出品の成否確認には使わない:
// Yahoo の再出品は新しい ID で公開されるため、旧 ID は一覧に現れない。
async function scanSellingListForItem(tabId, itemId) {
  await chrome.tabs.update(tabId, {
    url: "https://auctions.yahoo.co.jp/my/selling",
    active: true,
  });
  if (!(await waitForTabComplete(tabId, 45000))) return false;
  await remoteSleep(1200);
  for (let page = 0; page < 10; page++) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      args: [itemId],
      func: (targetId) => {
        const links = Array.from(document.querySelectorAll("a[href]"));
        const found = links.some((a) => {
          try {
            return new URL(a.href, location.href).pathname === "/jp/auction/" + targetId;
          } catch (e) {
            return false;
          }
        });
        let nextUrl = null;
        if (!found) {
          for (const a of links) {
            const label = (a.innerText || a.getAttribute("aria-label") || "")
              .replace(/\s+/g, " ")
              .trim();
            try {
              const u = new URL(a.href, location.href);
              if (
                u.pathname === "/my/selling" &&
                u.href !== location.href &&
                /^(次へ|次のページ|›|»)/.test(label)
              ) {
                nextUrl = u.href;
                break;
              }
            } catch (e) {
              /* 解析できないリンクは無視する */
            }
          }
        }
        return { found, nextUrl };
      },
    });
    const r = results[0] && results[0].result;
    if (!r) return false;
    if (r.found) return true;
    if (!r.nextUrl) return false;
    await chrome.tabs.update(tabId, { url: r.nextUrl, active: true });
    if (!(await waitForTabComplete(tabId, 45000))) return false;
    await remoteSleep(800);
  }
  return false;
}

// 出品中一覧を全ページ走査し、{id, title} の一覧を返す。
async function scanSellingListEntries(tabId) {
  await chrome.tabs.update(tabId, {
    url: "https://auctions.yahoo.co.jp/my/selling",
    active: true,
  });
  if (!(await waitForTabComplete(tabId, 45000))) return null;
  await remoteSleep(1200);
  const byId = new Map();
  for (let page = 0; page < 10; page++) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const links = Array.from(document.querySelectorAll("a[href]"));
        const entries = [];
        let nextUrl = null;
        for (const a of links) {
          try {
            const u = new URL(a.href, location.href);
            const m = u.pathname.match(/^\/jp\/auction\/([a-zA-Z]?\d+)$/);
            if (m) {
              entries.push({
                id: m[1],
                title: String(a.innerText || "").replace(/\s+/g, " ").trim(),
              });
            }
          } catch (e) {
            /* 解析できないリンクは無視する */
          }
        }
        for (const a of links) {
          const label = (a.innerText || a.getAttribute("aria-label") || "")
            .replace(/\s+/g, " ")
            .trim();
          try {
            const u = new URL(a.href, location.href);
            if (
              u.pathname === "/my/selling" &&
              u.href !== location.href &&
              /^(次へ|次のページ|›|»)/.test(label)
            ) {
              nextUrl = u.href;
              break;
            }
          } catch (e) {
            /* 解析できないリンクは無視する */
          }
        }
        return { entries, nextUrl };
      },
    });
    const r = results[0] && results[0].result;
    if (!r) return null;
    for (const e of r.entries) {
      const prev = byId.get(e.id);
      if (!prev || (e.title && e.title.length > (prev.title || "").length)) {
        byId.set(e.id, e);
      }
    }
    if (!r.nextUrl) break;
    await chrome.tabs.update(tabId, { url: r.nextUrl, active: true });
    if (!(await waitForTabComplete(tabId, 45000))) break;
    await remoteSleep(800);
  }
  return Array.from(byId.values());
}

// 出品中一覧の全ページ走査（完全性つき）。scanSellingListEntries と
// 同じ歩き方だが、ページ上限に達して次ページが残っていた場合は
// complete=false を返す。绑定体检は「完全な一覧で見当たらない」
// ことをもって初めてレコードの死を疑うため、この区別が要る。
async function scanSellingListEntriesEx(tabId) {
  await chrome.tabs.update(tabId, {
    url: "https://auctions.yahoo.co.jp/my/selling",
    active: true,
  });
  if (!(await waitForTabComplete(tabId, 45000))) return null;
  await remoteSleep(1200);
  const byId = new Map();
  let complete = false;
  for (let page = 0; page < 10; page++) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const links = Array.from(document.querySelectorAll("a[href]"));
        const entries = [];
        let nextUrl = null;
        for (const a of links) {
          try {
            const u = new URL(a.href, location.href);
            const m = u.pathname.match(/^\/jp\/auction\/([a-zA-Z]?\d+)$/);
            if (m) {
              entries.push({
                id: m[1],
                title: String(a.innerText || "").replace(/\s+/g, " ").trim(),
              });
            }
          } catch (e) {
            /* 解析できないリンクは無視する */
          }
        }
        for (const a of links) {
          const label = (a.innerText || a.getAttribute("aria-label") || "")
            .replace(/\s+/g, " ")
            .trim();
          try {
            const u = new URL(a.href, location.href);
            if (
              u.pathname === "/my/selling" &&
              u.href !== location.href &&
              /^(次へ|次のページ|›|»)/.test(label)
            ) {
              nextUrl = u.href;
              break;
            }
          } catch (e) {
            /* 解析できないリンクは無視する */
          }
        }
        return { entries, nextUrl };
      },
    });
    const r = results[0] && results[0].result;
    if (!r) return null;
    for (const e of r.entries) {
      const prev = byId.get(e.id);
      if (!prev || (e.title && e.title.length > (prev.title || "").length)) {
        byId.set(e.id, e);
      }
    }
    if (!r.nextUrl) {
      complete = true;
      break;
    }
    if (page === 9) break; // 上限到達・次ページあり = 不完全
    await chrome.tabs.update(tabId, { url: r.nextUrl, active: true });
    if (!(await waitForTabComplete(tabId, 45000))) break;
    await remoteSleep(800);
  }
  return { entries: Array.from(byId.values()), complete };
}

// Mercari の出品中一覧（マイページ）をスクロールしながら全件集める。
// 一覧は無限スクロール前提で、件数が 2 ラウンド連続で増えなければ
// 最後まで来たとみなす。0 件のときは「本当に 0 件」か「ページを
// 読めていない」か区別できないため complete=false に倒す
// （誤って全レコードを死扱いしないための安全弁）。
async function scanMercariLiveListings(tabId) {
  const byId = new Map();
  let stableRounds = 0;
  let complete = false;
  for (let round = 0; round < 40; round++) {
    const results = await chrome.scripting
      .executeScript({
        target: { tabId },
        func: () => {
          const out = [];
          for (const a of document.querySelectorAll("a[href]")) {
            let u;
            try {
              u = new URL(a.href, location.href);
            } catch (e) {
              continue;
            }
            const m = u.pathname.match(/^\/item\/(m[A-Za-z0-9]+)$/);
            if (!m) continue;
            const img = a.querySelector("img");
            const title = String(
              a.getAttribute("aria-label") || a.innerText || (img && img.alt) || ""
            )
              .replace(/\s+/g, " ")
              .trim();
            out.push({ id: m[1], title });
          }
          window.scrollTo(0, document.body.scrollHeight);
          return out;
        },
      })
      .catch(() => null);
    const entries = results && results[0] && results[0].result;
    if (!entries) return null;
    const before = byId.size;
    for (const e of entries) {
      const prev = byId.get(e.id);
      if (!prev || (e.title && e.title.length > (prev.title || "").length)) {
        byId.set(e.id, e);
      }
    }
    if (byId.size === before) {
      stableRounds += 1;
      if (stableRounds >= 2) {
        complete = byId.size > 0;
        break;
      }
    } else {
      stableRounds = 0;
    }
    await remoteSleep(1100);
  }
  return { entries: Array.from(byId.values()), complete };
}

// 绑定体检タスク: このブラウザ（ノード）の在售リストを列挙して
// 管理プログラムへ返す。対照と異常判定は管理プログラム側で行う。
// ここでは「見えたものを正直に返す」だけ: 取り切れなかった場合は
// complete=false を付け、失敗は失敗として報告する。
async function executeHealthScanTask(cfg, task) {
  const stopKeepAlive = startKeepAlive();
  let tabId = null;
  const postResult = async (ok, message, scan) => {
    try {
      await managerFetch(cfg, "/api/tasks/" + encodeURIComponent(task.id) + "/result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ok: !!ok,
          message: message || null,
          scan: scan || null,
        }),
      });
    } catch (e) {
      console.warn("[FurimaCopy] health scan result post failed", e);
    }
  };
  try {
    await managerFetch(cfg, "/api/tasks/" + encodeURIComponent(task.id) + "/claim", {
      method: "POST",
    });
    await setManagerConfig({
      lastStatus: "绑定体检スキャン中: " + (task.platform || ""),
    });
    let scan = null;
    if (task.platform === "yahoo") {
      const tab = await chrome.tabs.create({
        url: "https://auctions.yahoo.co.jp/my/selling",
        active: false,
      });
      tabId = tab.id;
      try {
        await chrome.tabs.update(tabId, { autoDiscardable: false });
      } catch (e) {
        /* noop */
      }
      await waitForTabComplete(tabId, 45000);
      scan = await scanSellingListEntriesEx(tabId);
    } else {
      const tab = await chrome.tabs.create({
        url: "https://jp.mercari.com/mypage/listings",
        active: false,
      });
      tabId = tab.id;
      try {
        await chrome.tabs.update(tabId, { autoDiscardable: false });
      } catch (e) {
        /* noop */
      }
      await waitForTabComplete(tabId, 45000);
      await remoteSleep(2500);
      scan = await scanMercariLiveListings(tabId);
    }
    if (!scan) throw new Error("出品中一覧を取得できませんでした");
    await postResult(
      true,
      "在售 " + scan.entries.length + " 件" + (scan.complete ? "" : "（不完全なスキャン）"),
      { complete: scan.complete, items: scan.entries }
    );
    await setManagerConfig({
      lastStatus:
        "绑定体检完了: " + (task.platform || "") + " 在售 " + scan.entries.length + " 件",
    });
  } catch (e) {
    await postResult(false, String((e && e.message) || e));
    await setManagerConfig({
      lastStatus: "绑定体检に失敗: " + String((e && e.message) || e),
    });
  } finally {
    if (tabId != null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch (e) {}
    }
    stopKeepAlive();
  }
}

function normalizeListingTitle(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[…\.]+$/, "");
}

function titlesMatch(a, b) {
  const x = normalizeListingTitle(a);
  const y = normalizeListingTitle(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const shorter = x.length <= y.length ? x : y;
  const longer = x.length <= y.length ? y : x;
  return shorter.length >= 12 && longer.startsWith(shorter);
}

// 再出品で公開された現在の出品 ID を特定する。Yahoo の再出品は新しい
// オークション ID が発行されるため、旧 ID は一覧に現れない。タイトルが
// 一意に一致する出品を新しい ID とみなす（曖昧な場合は null = 失敗）。
// 一覧への反映遅延に備えて数ラウンド待つ。
async function resolveYahooRelistedId(tabId, oldId, title) {
  for (let round = 0; round < 8; round++) {
    const entries = await scanSellingListEntries(tabId);
    if (entries) {
      if (entries.some((e) => e.id === oldId)) return oldId;
      if (title) {
        const matches = entries.filter(
          (e) => e.id !== oldId && titlesMatch(e.title, title)
        );
        if (matches.length === 1) return matches[0].id;
      }
    }
    await remoteSleep(8000);
  }
  return null;
}

// 終了したオークションの商品ページからタイトルを取得する（再出品後の
// 新 ID 特定に使う）。取得できなければ空文字。
async function getYahooAuctionTitle(tabId, itemId) {
  await chrome.tabs.update(tabId, {
    url: "https://auctions.yahoo.co.jp/jp/auction/" + encodeURIComponent(itemId),
    active: true,
  });
  if (!(await waitForTabComplete(tabId, 45000))) return "";
  await remoteSleep(1500);
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const h1 = document.querySelector("h1");
        let t = h1 ? String(h1.innerText || "").replace(/\s+/g, " ").trim() : "";
        if (!t) {
          const og = document.querySelector('meta[property="og:title"]');
          t = og ? String(og.getAttribute("content") || "").trim() : "";
        }
        if (!t) {
          t = String(document.title || "")
            .replace(/\s*-\s*Yahoo!オークション.*$/, "")
            .trim();
        }
        return t;
      },
    });
    return (results[0] && results[0].result) || "";
  } catch (e) {
    return "";
  }
}

async function processYahooRelistItem(tabId, item) {
  const url =
    "https://auctions.yahoo.co.jp/sell/jp/show/resubmit?aID=" +
    encodeURIComponent(item.id);
  await chrome.tabs.update(tabId, { url, active: true });
  // 前の商品の完了ページが残ったまま判定すると、未処理の商品を成功と
  // 誤判定したり商品 ID 不一致で止まったりするため、この商品の
  // 再出品 URL に実際に遷移したことを確認してから進む。
  let onTargetPage = false;
  for (let i = 0; i < 40; i++) {
    try {
      const t = await chrome.tabs.get(tabId);
      const u = new URL(t.url || "");
      if (
        u.origin === "https://auctions.yahoo.co.jp" &&
        u.pathname === "/sell/jp/show/resubmit" &&
        u.searchParams.get("aID") === item.id
      ) {
        onTargetPage = true;
        break;
      }
    } catch (e) {
      /* タブ取得に失敗したら次のポーリングで再確認する */
    }
    await remoteSleep(500);
  }
  if (!onTargetPage) {
    throw new Error(
      "再出品ページへの移動を確認できませんでした（商品 ID: " + item.id + "）"
    );
  }
  if (!(await waitForTabComplete(tabId, 45000))) {
    throw new Error("再出品フォームの読み込みがタイムアウトしました");
  }
  await remoteSleep(1800);

  let finalSubmitClicked = false;
  let reviewClicks = 0;
  let lastCompletionTitle = "";
  for (let attempt = 0; attempt < 30; attempt++) {
    const page = await inspectAndAdvanceYahooRelist(
      tabId,
      item.id,
      reviewClicks,
      finalSubmitClicked
    );
    if (!page) throw new Error("再出品ページから応答がありませんでした");
    if (page.completionTitle) lastCompletionTitle = page.completionTitle;
    if (page.status === "success" && page.listingId) {
      return { success: true, listingId: page.listingId };
    }
    if (page.status === "success" || page.status === "verify") {
      // Yahoo の再出品は新しいオークション ID で公開される。タイトルで
      // 出品中一覧を引き、新しい ID を特定して返す。旧 ID のまま結果を
      // 返すと、管理側のレコードが終了済み ID を指し続けて販売照合が壊れる。
      const title = item.title || lastCompletionTitle || "";
      const newId = await resolveYahooRelistedId(tabId, item.id, title);
      if (newId) return { success: true, listingId: newId };
      throw new Error(
        "送信後に出品中一覧で再出品を確認できませんでした。重複送信を避けるため処理を停止しました"
      );
    }
    if (page.status === "error") {
      // 描画直後でボタンがまだ無い等の一過性エラーは、数回だけ待って再試行する。
      if (attempt < 4 && /見つかりませんでした/.test(page.error || "")) {
        await remoteSleep(2000);
        continue;
      }
      throw new Error(page.error || "再出品ページを確認できませんでした");
    }
    if (page.status === "clicked") {
      if (page.kind === "submit") finalSubmitClicked = true;
      else reviewClicks++;
      await waitForTabComplete(tabId, 30000);
      await remoteSleep(1200);
      continue;
    }
    await remoteSleep(1200);
  }
  throw new Error(
    finalSubmitClicked
      ? "送信後の完了表示を確認できませんでした。重複送信を避けるため処理を停止しました"
      : "再出品の完了を確認できず、処理を停止しました"
  );
}

async function runYahooRelist(tabId, requestedIds, run) {
  const stopKeepAlive = startKeepAlive();
  let workTabId = null;
  let keepWorkTab = false;
  let items = [];
  let completed = 0;
  try {
    items = await scanYahooClosedTab(tabId);
    const liveIds = items.map((item) => item.id);
    if (!sameYahooRelistIds(liveIds, requestedIds)) {
      throw new Error("確認後に対象ページの商品が変わりました。もう一度対象を確認してください");
    }
    if (!items.length) throw new Error("現在ページに再出品できる商品がありません");

    await setYahooRelistState({
      status: "running",
      total: items.length,
      completed: 0,
      currentId: null,
      message: "開始準備中",
    });
    const workTab = await chrome.tabs.create({ active: true });
    workTabId = workTab.id;

    for (let index = 0; index < items.length; index++) {
      if (run.stopRequested) break;
      const item = items[index];
      run.currentId = item.id;
      await setYahooRelistState({
        status: "running",
        total: items.length,
        completed,
        currentId: item.id,
        message: "処理中 " + (index + 1) + "/" + items.length + "：" + item.title,
      });
      await processYahooRelistItem(workTabId, item);
      completed++;
      run.currentId = null;
      await setYahooRelistState({
        status: "running",
        total: items.length,
        completed,
        currentId: item.id,
        message: "再出品を確認しました " + completed + "/" + items.length,
      });
    }

    const stopped = run.stopRequested || completed < items.length;
    await setYahooRelistState({
      status: stopped ? "stopped" : "completed",
      total: items.length,
      completed,
      currentId: run.currentId || null,
      message: stopped
        ? "停止しました（再出品済み " + completed + "/" + items.length + " 件）"
        : "現在ページの未落札商品をすべて再出品しました",
    });
  } catch (e) {
    keepWorkTab = !!workTabId;
    await setYahooRelistState({
      status: "error",
      total: items.length,
      completed,
      currentId: run.currentId || null,
      message: String((e && e.message) || e),
    });
  } finally {
    if (workTabId && !keepWorkTab) {
      try {
        await chrome.tabs.remove(workTabId);
      } catch (e) {
        /* Tab may already be closed. */
      }
    }
    if (yahooRelistRun === run) yahooRelistRun = null;
    stopKeepAlive();
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("FurimaYahooRelist")) {
    return false;
  }

  if (msg.type === "FurimaYahooRelistPreview") {
    const tabId = sender.tab && sender.tab.id;
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, error: "Yahoo! オークションのタブから実行してください" });
      return false;
    }
    scanYahooClosedTab(tabId)
      .then((items) => sendResponse({ ok: true, items }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  if (msg.type === "FurimaYahooRelistStart") {
    if (yahooRelistRun) {
      sendResponse({ ok: false, error: "Yahoo! 再出品を実行中です" });
      return false;
    }
    if (!Array.isArray(msg.ids) || !msg.ids.length) {
      sendResponse({ ok: false, error: "再出品対象がありません" });
      return false;
    }
    const tabId = sender.tab && sender.tab.id;
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, error: "Yahoo! オークションの対象ページから実行してください" });
      return false;
    }
    const run = { stopRequested: false };
    yahooRelistRun = run;
    runYahooRelist(tabId, msg.ids, run).catch(async (e) => {
      await setYahooRelistState({
        status: "error",
        total: msg.ids.length,
        completed: 0,
        currentId: null,
        message: String((e && e.message) || e),
      });
      if (yahooRelistRun === run) yahooRelistRun = null;
    });
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "FurimaYahooRelistStop") {
    if (!yahooRelistRun) {
      sendResponse({ ok: false, error: "実行中の Yahoo! 再出品はありません" });
      return false;
    }
    yahooRelistRun.stopRequested = true;
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
