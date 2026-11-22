// readers/todos.js
// Mercari のやることリストと取引詳細から、発送依頼中の商品を取得する。
(function () {
  "use strict";

  function itemIdFromUrl(url) {
    const m = String(url || "").match(/\/item\/(m[A-Za-z0-9]+)/);
    if (m) return m[1];
    // やることリストのカードは取引ページ /transaction/<商品ID> へリンクしており、
    // その ID がそのまま商品 ID なので、詳細ページを開かずに取得できる。
    const t = String(url || "").match(/\/transactions?\/(m[A-Za-z0-9]+)/);
    return t ? t[1] : null;
  }

  function scanTodoCards() {
    if (!/^\/todos\/?$/.test(location.pathname)) return [];
    const cards = Array.from(document.querySelectorAll("a[href], [role='link']"));
    const found = [];
    const seen = new Set();

    cards.forEach((card) => {
      const text = (card.textContent || "").replace(/\s+/g, " ").trim();
      if (!text.includes("発送をお願いします")) return;
      const href = card.href || card.getAttribute("href");
      if (!href) return;
      const url = new URL(href, location.origin).href;
      const itemId = itemIdFromUrl(url);
      const key = itemId || url;
      if (seen.has(key)) return;
      seen.add(key);
      found.push({ text, url, itemId });
    });
    return found;
  }

  function scanTransactionDetail() {
    if (!/^\/transactions?\/[^/]+/.test(location.pathname)) return null;
    const links = Array.from(document.querySelectorAll("a[href]"));
    for (const link of links) {
      const itemId = itemIdFromUrl(link.href);
      if (itemId) return { itemId, url: "https://jp.mercari.com/item/" + itemId };
    }
    return null;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "FurimaScanSoldTodos") return false;
    sendResponse({ ok: true, cards: scanTodoCards(), detail: scanTransactionDetail() });
    return false;
  });
})();
