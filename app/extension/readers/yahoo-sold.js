// Yahoo!オークション「出品終了分（落札者あり）」ページの売却スキャン。
// 背景スクリプトからの依頼でページを読み、状態が「発送をしてください」
// （支払い済み・発送待ち）の商品だけを集めて返す。背景は管理プログラムへ
// platform=yahoo で報告する。ページ上の操作は一切しない（読み取りのみ）。
(() => {
  "use strict";
  if (window.__furimaYahooSoldLoaded) return;
  window.__furimaYahooSoldLoaded = true;

  const AWAITING = "発送をしてください";
  const KNOWN_STATUSES = [
    "発送をしてください",
    "発送完了しました",
    "受取連絡がされました",
  ];

  function auctionIdFromHref(href) {
    try {
      const u = new URL(href, location.href);
      const m = u.pathname.match(/\/jp\/auction\/([a-zA-Z]?\d+)$/);
      return m ? m[1] : null;
    } catch (e) {
      return null;
    }
  }

  // 「商品ID：…」表示のある要素から上へ辿り、その商品だけを含む
  // 行コンテナ（商品ID が 1 つだけで、既知の状態文言を含む要素）を探す。
  function rowContainerOf(el) {
    let node = el;
    for (let depth = 0; depth < 12 && node; depth++) {
      node = node.parentElement;
      if (!node) break;
      const text = node.innerText || "";
      const idCount = (text.match(/商品ID[:：]/g) || []).length;
      if (idCount === 1 && KNOWN_STATUSES.some((s) => text.includes(s))) {
        return node;
      }
    }
    return null;
  }

  function scan() {
    const url = new URL(location.href);
    if (
      url.origin !== "https://auctions.yahoo.co.jp" ||
      url.pathname !== "/my/closed" ||
      url.searchParams.get("hasWinner") !== "1"
    ) {
      return {
        ok: false,
        error: "対象ページが「落札者あり」ではありません",
        entries: [],
      };
    }
    const scope = document.getElementById("itm") || document;
    const entries = [];
    const seen = new Set();
    const idEls = Array.from(scope.querySelectorAll("*")).filter(
      (el) => el.children.length === 0 && /商品ID[:：]/.test(el.textContent || "")
    );
    for (const el of idEls) {
      const m = (el.textContent || "").match(/商品ID[:：]\s*([a-zA-Z]?\d+)/);
      if (!m) continue;
      const itemId = m[1];
      if (seen.has(itemId)) continue;
      const row = rowContainerOf(el);
      if (!row) continue;
      if (!row.innerText || !row.innerText.includes(AWAITING)) continue;
      seen.add(itemId);
      let listingUrl = "https://auctions.yahoo.co.jp/jp/auction/" + itemId;
      const link = Array.from(row.querySelectorAll("a[href]")).find(
        (a) => auctionIdFromHref(a.href) === itemId
      );
      if (link) listingUrl = link.href;
      entries.push({ itemId, listingUrl, statusText: AWAITING });
    }
    return { ok: true, entries };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "FurimaScanYahooSold") {
      try {
        sendResponse(scan());
      } catch (e) {
        sendResponse({
          ok: false,
          error: String((e && e.message) || e),
          entries: [],
        });
      }
    }
    return false;
  });
})();
