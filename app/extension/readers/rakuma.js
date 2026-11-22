// readers/rakuma.js
// ラクマ商品ページ（https://item.fril.jp/* / https://fril.jp/item/*）から出品情報を読み取る。
// v0.1.1: 画像は JSON-LD（先頭1枚だけ）ではなく商品ギャラリー（img.sp-image）から全枚取得する。
// 画像 URL は img.fril.jp/img/<商品数値ID>/<サイズ>/<写真ID>.jpg 形式。
// 同じ写真が /m/（JSON-LD）と /l/（ギャラリー）で重複するので、写真IDで dedupe し /l/ を優先する。
// タイトル・説明・価格は JSON-LD を優先し、取れない項目は DOM で補う。
(() => {
  "use strict";
  const FC = window.FurimaCopy;
  if (!FC) return;

  function jsonLdProduct() {
    for (const node of FC.dom.jsonLdList()) {
      const type = node["@type"];
      if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) return node;
    }
    return null;
  }

  // 商品の数値IDを JSON-LD の画像 URL から取り出す（例: /img/862091701/m/xxx.jpg → 862091701）。
  function itemNumericId(node) {
    const img = node && node.image;
    const url = Array.isArray(img) ? img[0] : img;
    const m = typeof url === "string" && url.match(/\/img\/(\d+)\//);
    if (m) return m[1];
    const sp = document.querySelector("img.sp-image");
    const m2 = sp && (sp.getAttribute("src") || "").match(/\/img\/(\d+)\//);
    return m2 ? m2[1] : null;
  }

  // この商品の写真だけをギャラリー順に集める。/l/ を最優先、なければ大きい方を残す。
  function collectGalleryImages(numId) {
    const byPhoto = new Map(); // 写真ID -> {url, rank}
    const rank = (u) => (/\/l\//.test(u) ? 3 : /\/m\//.test(u) ? 2 : 1);
    const push = (raw) => {
      if (!raw || typeof raw !== "string") return;
      const m = raw.match(/\/img\/(\d+)\/[sml]\/(\d+\.jpg)/);
      if (!m) return;
      if (numId && m[1] !== numId) return; // 他商品（おすすめ等）は除外
      const prev = byPhoto.get(m[2]);
      if (!prev || rank(raw) > prev.rank) byPhoto.set(m[2], { url: raw, rank: rank(raw) });
    };
    document
      .querySelectorAll(
        'img.sp-image, img[src*="img.fril.jp/img/"], img[data-original*="img.fril.jp/img/"], img[data-src*="img.fril.jp/img/"]'
      )
      .forEach((img) => {
        push(img.getAttribute("src"));
        push(img.getAttribute("data-original"));
        push(img.getAttribute("data-src"));
      });
    return Array.from(byPhoto.values()).map((x) => x.url);
  }

  function extract() {
    const node = jsonLdProduct();
    const offers = node ? (Array.isArray(node.offers) ? node.offers[0] : node.offers) : null;
    const numId = itemNumericId(node);
    const gallery = collectGalleryImages(numId);
    const jsonImage = node && node.image ? (Array.isArray(node.image) ? node.image : [node.image]) : [];
    return {
      title:
        (node && typeof node.name === "string" ? node.name : null) ||
        FC.dom.text(["h1"]) ||
        FC.dom.meta("og:title"),
      description:
        (node && typeof node.description === "string" ? node.description : null) ||
        FC.dom.text(['[class*="description"]', '[class*="comment"]']),
      price:
        (offers ? FC.parsePrice(offers.price) : null) ??
        FC.parsePrice(FC.dom.text(['[class*="price"]', '[class*="Price"]'])),
      imageUrls: gallery.length ? gallery : jsonImage.filter((x) => typeof x === "string"),
      conditionText: FC.dom.specValue(["商品の状態", "状態"]),
      categoryText: FC.dom.specValue(["カテゴリ"]),
      shippingText: FC.dom.specValue(["配送料の負担", "送料", "配送"]),
      _diag: { numId, galleryCount: gallery.length, jsonLd: !!node },
    };
  }

  async function handleCopy() {
    const data = extract();
    const diag = data._diag;
    delete data._diag;
    const saved = await FC.save(Object.assign({}, data, { source: "rakuma", sourceUrl: location.href }));
    console.log("[FurimaCopy] rakuma", diag, saved);
    // 画像データもこの場で取り込んで保存する（出品ページで CDN に再取得しないため）。
    FC.ui.showToast("コピーしました。画像を取り込み中…");
    let okCount = 0;
    try {
      const items = await FC.captureImages(
        (saved.imageUrls || []).map((u) => ({ key: u, urls: [u] })),
        saved.sourceUrl
      );
      okCount = items.filter((x) => x.base64).length;
    } catch (e) {
      console.warn("[FurimaCopy] captureImages failed", e);
    }
    FC.ui.showToast(
      "コピーしました：" + (saved.title || "（タイトル不明）") +
      "（画像" + saved.imageUrls.length + "枚 / 取込" + okCount + "枚）"
    );
  }

  FC.ui.mountButton(handleCopy);

  // リモート/取り込み用（v0.6.0）: バックグラウンドからの指示でコピーを実行する。
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.type !== "FurimaRemoteCopy") return false;
      Promise.resolve()
        .then(() => handleCopy())
        .then(async () => {
          const d = await FC.load();
          sendResponse({
            ok: !!d,
            summary: d
              ? { title: d.title, price: d.price, imageCount: (d.imageUrls || []).length }
              : null,
          });
        })
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    });
  }
})();
