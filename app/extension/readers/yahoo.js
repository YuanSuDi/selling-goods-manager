// readers/yahoo.js
// Yahoo!オークション商品ページ（https://auctions.yahoo.co.jp/jp/auction/*）から出品情報を読み取る。
// 第一候補: JSON-LD（Product）。第二候補: DOM（価格は「現在価格」の表記も拾う）。
// 最後の保険: og: メタタグ。どの項目も取れなければ null / 空配列にし、例外は投げない。
// 注意（v0.8.3）: JSON-LD の description は途中で切れた要約文のことがある（実測では約150字で
// 切断され、表組みも潰れる）。説明文はページの説明ブロックから全文を取り、DOM 側が長ければ
// そちらを優先する。あわせて説明ブロックの HTML（危険な要素を除いたもの）を descriptionHtml
// として保存し、Yahoo!→Yahoo! のコピーでは書式ごと再現できるようにする。
// 注意（v0.12.6）: 現在の Yahoo! 商品ページでは、表示されている説明ブロック（#description）
// 自体が末尾「...」で切れた要約（実測 235 字）しか持っていない。売り手の全文はページ埋め込みの
// 状態 JSON の descriptionHtml（実測 992 字）にだけあるため、そちらを最優先で使う。
// あわせて状態 JSON の shipping.methods から配送方法名も拾い、フォーム自動選択用に
// 送料負担・発送元・発送日数を構造化して保存する。
(() => {
  "use strict";
  const FC = window.FurimaCopy;
  if (!FC) return;

  function extractFromJsonLd() {
    for (const node of FC.dom.jsonLdList()) {
      const type = node["@type"];
      const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
      if (!isProduct) continue;
      const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers;
      const images = node.image ? (Array.isArray(node.image) ? node.image : [node.image]) : [];
      return {
        title: typeof node.name === "string" ? node.name : null,
        description: typeof node.description === "string" ? node.description : null,
        price: offers ? FC.parsePrice(offers.price) : null,
        imageUrls: images.filter((x) => typeof x === "string"),
      };
    }
    return null;
  }

  const EXPLANATION_SELECTORS = [
    '[class*="ProductExplanation"]',
    '[class*="explanation"]',
    '[id*="description"]',
  ];

  // ページ上の「商品の説明」ブロック要素を探す。候補をすべて集め、末尾が
  // 「...」で切れた要約ブロック（#description 等）を避けて最長のものを返す。
  function findExplanationEl() {
    const candidates = [];
    for (const sel of EXPLANATION_SELECTORS) {
      document.querySelectorAll(sel).forEach((el) => {
        if ((el.textContent || "").trim().length > 20) candidates.push(el);
      });
    }
    const heads = Array.from(document.querySelectorAll("h1, h2, h3, h4, dt, th, span, div, p"));
    const head = heads.find((h) => {
      const t = (h.textContent || "").trim();
      return t === "商品の説明" || t === "商品説明";
    });
    if (head) {
      let node = head;
      for (let i = 0; i < 3 && node; i++) {
        node = node.parentElement;
        if (node && (node.textContent || "").trim().length > 100) {
          candidates.push(node);
          break;
        }
      }
    }
    if (!candidates.length) return null;
    const isTruncated = (el) => /\.\.\.$|…$/.test((el.textContent || "").trim());
    const full = candidates.filter((el) => !isTruncated(el));
    const pool = full.length ? full : candidates;
    pool.sort((a, b) => (b.textContent || "").length - (a.textContent || "").length);
    return pool[0];
  }

  // 説明ブロック内の Yahoo! 側の見出し（商品説明 / 商品の説明）と、隠れた
  // 重複ブロック（表示切替用など）を取り除く。
  function stripExplanationChrome(clone) {
    clone.querySelectorAll("h1, h2, h3, h4").forEach((h) => {
      if (/^商品の?説明$/.test((h.textContent || "").trim())) h.remove();
    });
    clone
      .querySelectorAll('[style*="display:none"], [style*="display: none"], [hidden]')
      .forEach((n) => n.remove());
  }

  // 説明ブロックを読みやすいプレーンテキスト化する（表は行ごとに改行、セルは空白区切り）。
  function readableText(el) {
    const clone = el.cloneNode(true);
    stripExplanationChrome(clone);
    clone.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
    clone.querySelectorAll("td, th").forEach((c) => c.append(" "));
    clone
      .querySelectorAll("p, div, tr, li, table, h1, h2, h3, h4, h5, h6")
      .forEach((b) => b.append("\n"));
    const text = (clone.textContent || "")
      .replace(/[ \t\u00a0]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return text || null;
  }

  // 説明ブロックの HTML を、スクリプト等の危険な要素・属性を取り除いて返す。
  function sanitizedHtml(el) {
    const clone = el.cloneNode(true);
    stripExplanationChrome(clone);
    clone
      .querySelectorAll("script, style, iframe, object, embed, form, input, button, link, meta")
      .forEach((n) => n.remove());
    clone.querySelectorAll("*").forEach((n) => {
      Array.from(n.attributes || []).forEach((attr) => {
        if (/^on/i.test(attr.name)) n.removeAttribute(attr.name);
        if (
          (attr.name === "href" || attr.name === "src") &&
          /^\s*javascript:/i.test(attr.value || "")
        ) {
          n.removeAttribute(attr.name);
        }
      });
    });
    const html = (clone.innerHTML || "").trim();
    return html || null;
  }

  // カテゴリは値セル内のリンクを階層として拾い " > " でつなぐ。
  // textContent をそのまま取ると区切り文字が DOM に無く
  // 「コンピュータタブレットAppleiPad本体」のように潰れてしまう（実測）。
  function categoryFromDom() {
    const SKIP = ["トップ", "ホーム", "Yahoo!オークション", "すべてのカテゴリ"];
    const joinLinks = (root) => {
      const texts = Array.from(root.querySelectorAll("a"))
        .map((a) => (a.textContent || "").trim())
        .filter((t) => t && !SKIP.includes(t));
      const dedup = texts.filter((t, i) => i === 0 || t !== texts[i - 1]);
      return dedup.length ? dedup.join(" > ") : null;
    };
    // 1) 詳細表のカテゴリ行のリンク
    for (const el of document.querySelectorAll("th, dt")) {
      const labelText = (el.textContent || "").trim();
      if (!["カテゴリー", "カテゴリ"].some((l) => labelText.includes(l))) continue;
      const row = el.closest("tr");
      const cell = row ? row.querySelector("td") : el.nextElementSibling;
      if (cell) {
        const joined = joinLinks(cell);
        if (joined) return joined;
      }
    }
    // 2) パンくず（カテゴリパス）のリンク
    const crumbs = document.querySelectorAll(
      '[class*="breadcrumb" i], [id*="breadcrumb" i], [class*="categoryPath" i]'
    );
    for (const c of crumbs) {
      const joined = joinLinks(c);
      if (joined && joined.includes(">")) return joined;
    }
    return null;
  }

  // ページ埋め込みの状態 JSON から、売り手の説明 HTML 全文と配送方法名を拾う。
  // 表示ブロックも JSON-LD も要約しか持っていないため、これが取れれば最優先。
  function extractFromPageState() {
    let descHtml = null;
    let shipMethod = null;
    let categoryPath = null;
    let startPrice = null;
    let winPrice = null;
    try {
      for (const s of document.querySelectorAll("script")) {
        const t = s.textContent || "";
        if (!descHtml && t.includes('"descriptionHtml"')) {
          const m = t.match(/"descriptionHtml":"((?:[^"\\]|\\.)*)"/);
          if (m) {
            try { descHtml = JSON.parse('"' + m[1] + '"'); } catch (e) { descHtml = null; }
          }
        }
        if (!categoryPath && t.includes('"category"') && t.includes('"path"')) {
          const pm = t.match(/"category":\{"path":\[([\s\S]*?)\],"isAdult"/);
          if (pm) {
            const names = [];
            for (const nm of pm[1].matchAll(/"name":"((?:[^"\\]|\\.)*)"/g)) {
              try { names.push(JSON.parse('"' + nm[1] + '"')); } catch (e) { /* skip */ }
            }
            // 先頭の「オークション」(node 0) は出品ツリーの階層に無いので落とす。
            // DOM のパンくず/詳細表は中間階層を落とすことがある（実測:
            // フォグランプ > 社外品 > その他 が DOM では 社外品 欠落）。
            // 状態 JSON の path が完全なので、取れたらこちらを正とする。
            const segs = names.filter((n) => n && n !== "オークション");
            if (segs.length >= 2) categoryPath = segs.join(" > ");
          }
        }
        if (startPrice == null && t.includes('"initPrice"')) {
          const m = t.match(/"initPrice":\s*"?(\d+)"?/);
          if (m) startPrice = parseInt(m[1], 10);
        }
        if (winPrice == null && t.includes('"winPrice"')) {
          const m = t.match(/"winPrice":\s*"?(\d+)"?/);
          if (m) winPrice = parseInt(m[1], 10);
        }
        if (!shipMethod && t.includes('"methods"')) {
          const m = t.match(/"shipping":\{"methods":\[\{"id":"[^"]*","name":"((?:[^"\\]|\\.)*)"/);
          if (m) {
            try { shipMethod = JSON.parse('"' + m[1] + '"'); } catch (e) { shipMethod = null; }
            // 状態 JSON の名称は「おてがる配送ゆうパケット」のように
            // 接頭辞付きで返る（2026-11-23 実測）。フォームのカード名は
            // 接頭辞なし（ゆうパケット）なので、既知名称の最長一致で
            // 正規化しておかないと自動選択が永遠に一致しない。
            if (shipMethod) shipMethod = matchShipMethod(shipMethod) || shipMethod;
          }
        }
        if (descHtml && shipMethod) break;
      }
    } catch (e) {
      /* 状態 JSON が無いページでは DOM 抽出に任せる */
    }
    return { descHtml, shipMethod, categoryPath, startPrice, winPrice };
  }

  function htmlToReadableText(html) {
    const div = document.createElement("div");
    div.innerHTML = html;
    return readableText(div);
  }

  function sanitizeHtmlString(html) {
    const div = document.createElement("div");
    div.innerHTML = html;
    return sanitizedHtml(div);
  }

  // 配送方法の既知名称（長い順に並べ、最長一致で拾う）。
  const SHIP_METHOD_NAMES = [
    "ゆうパケットポストmini", "ゆうパケットプラス", "レターパックプラス",
    "レターパックライト", "宅急便コンパクト", "クリックポスト",
    "ゆうパケット", "定形外郵便", "ゆうメール", "ゆうパック",
    "定形郵便", "ネコポス", "飛脚宅配便", "宅急便",
  ];
  function matchShipMethod(text) {
    if (!text) return null;
    for (const name of SHIP_METHOD_NAMES) {
      if (String(text).includes(name)) return name;
    }
    return null;
  }

  // フォーム自動選択用に、配送まわりを構造化して拾う。
  function shippingFromDom() {
    const feeText = FC.dom.specValue(["送料"]);
    let burden = null;
    if (feeText) {
      if (/無料/.test(feeText)) burden = "seller";
      else if (/着払い|落札者/.test(feeText)) burden = "buyer";
      else if (/出品者/.test(feeText)) burden = "seller";
    }
    const from = FC.dom.specValue(["発送元の地域", "発送元"]);
    const daysText = FC.dom.specValue(["発送までの日数"]);
    let days = null;
    if (daysText) {
      const m = String(daysText).match(/(\d+)\s*[〜～~]\s*(\d+)\s*日/);
      if (m) days = m[1] + "〜" + m[2] + "日";
    }
    // 送料の値セルには配送方法名も連結されて入っていることがある（実測）。
    let method =
      matchShipMethod(feeText) || matchShipMethod(FC.dom.specValue(["配送方法"]));
    if (!method) {
      const areas = Array.from(document.querySelectorAll("div, section, td, li"));
      const area = areas.find((el) => {
        const t = el.textContent || "";
        return t.includes("配送方法一覧") && t.length < 600;
      });
      if (area) method = matchShipMethod(area.textContent);
    }
    return { burden, from: from || null, days, method };
  }

  function extractFromDom() {
    const explEl = findExplanationEl();
    const imgs = [];
    // ギャラリー付近の大きめの画像を優先し、取れなければ yimg の画像全体から拾う。
    const galleryImgs = document.querySelectorAll(
      '[class*="ProductImage"] img, [class*="productImage"] img, [id*="image"] img'
    );
    const pushImg = (img) => {
      const src = img.getAttribute("src") || img.getAttribute("data-src");
      if (src) imgs.push(src);
    };
    if (galleryImgs.length) {
      galleryImgs.forEach(pushImg);
    } else {
      document.querySelectorAll('img[src*="yimg.jp"]').forEach((img) => {
        // アイコン等の小さい画像を避けるため、表示サイズが取れる場合は 150px 以上だけ拾う。
        if (!img.complete || img.naturalWidth === 0 || img.naturalWidth >= 150) pushImg(img);
      });
    }
    const ogImage = FC.dom.meta("og:image");

    const priceText =
      FC.dom.text(['[class*="Price"]', '[class*="price"]']) ||
      FC.dom.specValue(["現在価格", "即決価格", "価格"]);

    const shipInfo = shippingFromDom();
    return {
      title: FC.dom.text(["h1"]) || FC.dom.meta("og:title"),
      description: explEl ? readableText(explEl) : FC.dom.text(EXPLANATION_SELECTORS),
      descriptionHtml: explEl ? sanitizedHtml(explEl) : null,
      price: FC.parsePrice(priceText),
      imageUrls: imgs.length ? imgs : ogImage ? [ogImage] : [],
      conditionText: FC.dom.specValue(["商品の状態", "状態"]),
      categoryText: categoryFromDom() || FC.dom.specValue(["カテゴリー", "カテゴリ"]),
      shippingText: FC.dom.specValue(["送料", "配送", "発送"]),
      shippingMethod: shipInfo.method,
      shippingBurden: shipInfo.burden,
      shipFrom: shipInfo.from,
      shipDays: shipInfo.days,
    };
  }

  async function handleCopy() {
    let jsonData = null;
    try {
      jsonData = extractFromJsonLd();
    } catch (e) {
      console.warn("[FurimaCopy] JSON-LD の解析に失敗", e);
    }
    const domData = extractFromDom();
    const data = FC.mergeData(domData, jsonData);
    // JSON-LD の説明は切断された要約のことがあるため、DOM 側が長ければ DOM を正とする。
    if (
      domData.description &&
      (!data.description || domData.description.length > data.description.length)
    ) {
      data.description = domData.description;
    }
    if (domData.descriptionHtml) data.descriptionHtml = domData.descriptionHtml;
    // ページ状態 JSON に全文の説明 HTML と配送方法があれば、それを正とする
    // （表示ブロックと JSON-LD は末尾が切れた要約しか持っていないため）。
    const state = extractFromPageState();
    if (state.descHtml) {
      const stateText = htmlToReadableText(state.descHtml);
      const cleanHtml = sanitizeHtmlString(state.descHtml);
      if (stateText) data.description = stateText;
      if (cleanHtml) data.descriptionHtml = cleanHtml;
    }
    if (state.shipMethod) data.shippingMethod = state.shipMethod;
    if (state.categoryPath) data.categoryText = state.categoryPath;
    // 価格は状態 JSON を正とする: 開始価格は initPrice（入札があると
    // DOM の現在価格とずれる）。開始価格より高い winPrice がある場合だけ
    // 「即決ありのオークション」として buyNowPrice を立てる。定額出品は
    // initPrice == winPrice なので従来どおり単一価格のまま（実測 2026-11-23:
    // オークション initPrice 1180 / winPrice 1200、定額は両方 6800）。
    if (state.startPrice != null) data.price = state.startPrice;
    if (
      state.winPrice != null &&
      state.startPrice != null &&
      state.winPrice > state.startPrice
    ) {
      data.buyNowPrice = state.winPrice;
    }
    const saved = await FC.save(
      Object.assign({}, data, { source: "yahoo", sourceUrl: location.href })
    );
    console.log("[FurimaCopy]", saved);
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
