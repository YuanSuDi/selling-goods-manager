// readers/mercari.js
// メルカリ商品ページ（https://jp.mercari.com/item/*）から出品情報を読み取る。
// 第一候補: ページ埋め込みの __NEXT_DATA__ JSON を再帰的に探索する。
// 第二候補: DOM（h1、価格要素、ギャラリー画像など）。
// どの項目も取れなければ null / 空配列にし、例外は投げない。
(() => {
  "use strict";
  const FC = window.FurimaCopy;
  if (!FC) return;

  // JSON 内を再帰的に探し、「商品らしい」オブジェクトをスコアリングで選ぶ。
  // 現在の URL の商品IDと一致するオブジェクトを最優先する（SPA 遷移で複数商品の
  // データが混在しても、表示中ではない商品を掴まないため。v0.8.11）。
  function findItemObject(root) {
    let best = null;
    let bestScore = -1;
    const seen = new Set();
    const idm = location.pathname.match(/\/item\/([A-Za-z0-9]+)/);
    const urlItemId = idm ? idm[1] : null;
    const walk = (node, depth) => {
      if (!node || typeof node !== "object" || depth > 14) return;
      if (seen.has(node)) return;
      seen.add(node);
      if (!Array.isArray(node)) {
        let score = 0;
        if (urlItemId && node.id != null && String(node.id) === urlItemId) score += 100;
        if (typeof node.name === "string" && node.name.trim()) score += 2;
        if (typeof node.price === "number" && node.price > 0) score += 2;
        if (typeof node.description === "string" && node.description) score += 1;
        if (Array.isArray(node.photos) && node.photos.length) score += 2;
        if (Array.isArray(node.thumbnails) && node.thumbnails.length) score += 1;
        if (score >= 5 && score > bestScore) {
          best = node;
          bestScore = score;
        }
      }
      Object.values(node).forEach((v) => walk(v, depth + 1));
    };
    walk(root, 0);
    return best;
  }

  // photos / thumbnails 配列から URL 文字列を取り出す（文字列 or {uri|url|...} 両対応）。
  function photoUrls(item) {
    const raw = [];
    const push = (v) => {
      if (typeof v === "string") raw.push(v);
      else if (v && typeof v === "object") {
        raw.push(v.uri || v.url || v.src || v.thumbnailUri || v.thumbnail_uri);
      }
    };
    (Array.isArray(item.photos) ? item.photos : []).forEach(push);
    if (!raw.filter(Boolean).length) {
      (Array.isArray(item.thumbnails) ? item.thumbnails : []).forEach(push);
    }
    return raw.filter(Boolean);
  }

  // Mercari の配送方法の語彙。商品ページの「配送の方法」セルには方法名の
  // 後ろに受取方法などの補足行がぶら下がり、DOM 読み取りでは連結した
  // 塊になることがある（A351: ゆうゆうメルカリ便+郵便局/コンビニ受取+
  // 匿名配送）。語彙に照らして方法名だけを取り出す（最長一致）。
  const MERCARI_METHODS = [
    "ゆうパケットポストmini",
    "ゆうパケットポスト",
    "らくらくメルカリ便",
    "ゆうゆうメルカリ便",
    "レターパックプラス",
    "レターパックライト",
    "郵便（定形、定形外、書留など）",
    "普通郵便（定形、定形外）",
    "たのメル便",
    "クロネコヤマト",
    "クリックポスト",
    "ゆうパケット",
    "レターパック",
    "ゆうメール",
    "ゆうパック",
    "普通郵便",
    "未定",
  ];

  // 選択ページの表記と商品ページの表記が違う方法の正規化。
  // 郵便: 選択ページは「郵便(定形、定形外、書留など)」（半角括弧）、
  // 商品ページは「普通郵便（定形、定形外）」。レターパックは選択ページ
  // では 1 本化されている。ゆうパケットポスト系はゆうゆう便の子方法。
  const METHOD_CANONICAL = {
    "郵便（定形、定形外、書留など）": "普通郵便（定形、定形外）",
    "普通郵便": "普通郵便（定形、定形外）",
    "レターパックプラス": "レターパック",
    "レターパックライト": "レターパック",
    "ゆうパケットポストmini": "ゆうゆうメルカリ便",
    "ゆうパケットポスト": "ゆうゆうメルカリ便",
  };
  function normalizeMercariMethod(text) {
    if (!text) return null;
    const flat = String(text).replace(/\s+/g, "").replace(/（/g, "(").replace(/）/g, ")");
    // 最も早く現れる語彙を採る。同位置で重なる名前（ゆうパケット /
    // ゆうパケットポスト / ゆうパケットポストmini）は最長を優先。
    // カード内には自方法名の後ろに子方法名も並ぶため、最長一致だけでは
    // ゆうゆう便カードから ゆうパケットポストmini を誤って拾う。
    let best = null;
    let bestIdx = Infinity;
    let bestLen = -1;
    for (const name of MERCARI_METHODS) {
      const n = name.replace(/\s+/g, "").replace(/（/g, "(").replace(/）/g, ")");
      const idx = flat.indexOf(n);
      if (idx < 0) continue;
      if (idx < bestIdx || (idx === bestIdx && n.length > bestLen)) {
        best = name;
        bestIdx = idx;
        bestLen = n.length;
      }
    }
    if (best) return METHOD_CANONICAL[best] || best;
    // 語彙に無い名前（新設の方法など）は元の文字列をそのまま返す。
    return String(text).trim() || null;
  }

  function extractFromNextData() {
    const el = document.getElementById("__NEXT_DATA__");
    if (!el || !el.textContent) return null;
    let json;
    try {
      json = JSON.parse(el.textContent);
    } catch (e) {
      return null;
    }
    const item = findItemObject(json);
    if (!item) return null;

    const payer = item.shippingPayer && item.shippingPayer.name;
    const method = item.shippingMethod && item.shippingMethod.name;
    const shipping = [payer, method].filter(Boolean).join(" / ") || null;

    return {
      title: typeof item.name === "string" ? item.name : null,
      description: typeof item.description === "string" ? item.description : null,
      price: typeof item.price === "number" ? item.price : FC.parsePrice(item.price),
      imageUrls: photoUrls(item),
      conditionText: conditionFromItem(item),
      categoryText: categoryFromItem(item),
      shippingText: shipping,
      shippingPayer: payer || null,
      shippingMethodName: method ? normalizeMercariMethod(method) : null,
    };
  }

  const CONDITION_NAMES = [
    "新品、未使用",
    "未使用に近い",
    "目立った傷や汚れなし",
    "やや傷や汚れあり",
    "傷や汚れあり",
    "全体的に状態が悪い",
  ];

  function conditionFromItem(item) {
    const c = item.itemCondition || item.condition;
    if (c && typeof c === "object") {
      if (typeof c.name === "string" && c.name) return c.name;
      if (typeof c.id === "number" && CONDITION_NAMES[c.id - 1]) {
        return CONDITION_NAMES[c.id - 1];
      }
    }
    if (typeof c === "number" && CONDITION_NAMES[c - 1]) {
      return CONDITION_NAMES[c - 1];
    }
    for (const k of Object.keys(item)) {
      const v = item[k];
      if (typeof v === "string" && CONDITION_NAMES.includes(v)) return v;
    }
    return null;
  }

  function categoryFromItem(item) {
    const c = item.category || item.itemCategory;
    if (c && typeof c === "object" && typeof c.name === "string" && c.name) {
      return c.name;
    }
    if (typeof c === "string" && c) return c;
    if (Array.isArray(item.categories)) {
      const names = item.categories
        .map((x) => (typeof x === "string" ? x : x && x.name))
        .filter(Boolean);
      if (names.length) return names.join(" > ");
    }
    return null;
  }

  // th/dt 以外のレイアウトでも「ラベル: 値」の行から値を取る（Mercari の現行デザイン用）。
  function specByLabelAny(labels) {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const isCategory = labels.some((l) => /カテゴリ/.test(l));
    // 値が複数の要素（パンくずの各階層など）で構成される場合、textContent の
    // 単純連結だと区切りが消える。末端要素のテキストを集めて組み立てる。
    const valueFromLeaves = (node) => {
      const leaves = Array.from(node.querySelectorAll("*"))
        .filter((e) => e.children.length === 0)
        .map((e) => norm(e.textContent))
        .filter(Boolean)
        .filter((v) => !labels.includes(v) && !/^[>＞›»]+$/.test(v));
      const dedup = leaves.filter((v, i) => i === 0 || v !== leaves[i - 1]);
      if (!dedup.length) return null;
      return dedup.join(isCategory ? " > " : "");
    };
    const els = document.querySelectorAll(
      "div, span, p, li, dt, th, td, label, h2, h3"
    );
    for (const el of els) {
      const t = norm(el.textContent);
      if (!t) continue;
      const label = labels.find((l) => t === l || t === l + "：" || t === l + ":");
      if (!label) continue;
      let node = el;
      for (let i = 0; i < 4 && node; i++) {
        node = node.parentElement;
        if (!node) break;
        const full = norm(node.textContent);
        if (full.length > label.length && full.length < 300) {
          const fromLeaves = valueFromLeaves(node);
          if (fromLeaves) return fromLeaves;
          const v = full.replace(label, "").replace(/^[：:]/, "").trim();
          if (v) return v;
        }
      }
      const next = el.nextElementSibling;
      if (next && norm(next.textContent)) return norm(next.textContent);
    }
    return null;
  }

  // ラベル行の「全文からラベルを除いた文字列」を返す。配送の方法では
  // 方法名が子要素を持つ要素の直下テキストになっていて、末端要素だけを
  // 集める specByLabelAny では方法名が落ち、補足行（郵便局/コンビニ受取
  // 匿名配送）だけが残ることがある（A351 v0.12.17 で実証）。全文なら
  // 方法名を含むので、語彙照合で取り出せる。
  function specRowFullText(labels) {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const els = document.querySelectorAll(
      "div, span, p, li, dt, th, td, label, h2, h3"
    );
    for (const el of els) {
      const t = norm(el.textContent);
      if (!t) continue;
      const label = labels.find((l) => t === l || t === l + "：" || t === l + ":");
      if (!label) continue;
      let node = el;
      for (let i = 0; i < 4 && node; i++) {
        node = node.parentElement;
        if (!node) break;
        const full = norm(node.textContent);
        if (full.length > label.length && full.length < 300) {
          const v = full.replace(label, "").replace(/^[：:]/, "").trim();
          if (v) return v;
        }
      }
      const next = el.nextElementSibling;
      if (next && norm(next.textContent)) return norm(next.textContent);
    }
    return null;
  }

  function extractFromDom() {
    const imgs = [];
    document
      .querySelectorAll('img[src*="static.mercdn.net"]')
      .forEach((img) => imgs.push(img.getAttribute("src")));
    return {
      title: FC.dom.text(["h1"]) || FC.dom.meta("og:title"),
      description: FC.dom.text(['[data-testid="description"]', '[class*="description"]']),
      price: FC.parsePrice(
        FC.dom.text(['[data-testid="price"]', '[class*="itemPrice"]', '[class*="Price"]'])
      ),
      imageUrls: imgs,
      conditionText:
        FC.dom.specValue(["商品の状態"]) || specByLabelAny(["商品の状態"]),
      categoryText:
        FC.dom.specValue(["カテゴリー", "カテゴリ"]) ||
        specByLabelAny(["カテゴリー", "カテゴリ"]),
      shippingText:
        FC.dom.specValue(["配送料の負担", "配送の方法"]) ||
        specByLabelAny(["配送料の負担", "配送の方法"]),
      // v0.12.12: 配送の内訳を構造化して保持する（出品フォームの自動選択用）。
      shippingPayer:
        FC.dom.specValue(["配送料の負担"]) || specByLabelAny(["配送料の負担"]),
      shippingMethodName: normalizeMercariMethod(
        FC.dom.specValue(["配送の方法"]) ||
          specRowFullText(["配送の方法"]) ||
          specByLabelAny(["配送の方法"])
      ),
      shipFrom:
        FC.dom.specValue(["発送元の地域"]) || specByLabelAny(["発送元の地域"]),
      shipDays:
        FC.dom.specValue(["発送までの日数"]) || specByLabelAny(["発送までの日数"]),
    };
  }

  // この商品自身の写真だけに絞る。
  // Mercari の商品写真 URL は <商品ID>_<連番>.jpg 形式（orig / thumb 両方）。
  // DOM 兜底が拾う他商品の写真・メンバーのアイコン画像などを除外し、
  // 同じ連番は orig（/item/detail/orig/photos/）を優先して dedupe する。
  function filterItemPhotos(urls) {
    const m = location.pathname.match(/\/item\/([A-Za-z0-9]+)/);
    const itemId = m ? m[1] : null;
    const list = (urls || []).filter((u) => typeof u === "string" && u);
    if (!itemId) return list.filter((u) => !/\/(members|user)\//.test(u));
    const byIndex = new Map();
    for (const u of list) {
      const mm = u.match(new RegExp(itemId + "_(\\d+)\\.(?:jpe?g|png|webp)", "i"));
      if (!mm) continue;
      const isOrig = u.includes("/item/detail/orig/photos/");
      const prev = byIndex.get(mm[1]);
      if (!prev || (isOrig && !prev.isOrig)) byIndex.set(mm[1], { url: u, isOrig });
    }
    const out = Array.from(byIndex.entries())
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([, v]) => v.url);
    // パターンに合うものが無ければ、明らかな非商品画像だけ落として元の集合を使う。
    return out.length ? out : list.filter((u) => !/\/(members|user)\//.test(u));
  }

  // ページに実際に表示されている写真の URL を連番ごとに拾う。
  // CDN は orig URL へのプログラム取得を弾くが、表示済み画像はブラウザが取得済みなので、
  // 取り込み（captureImages）はこちらを第一候補にする。実際に読み込まれた URL は
  // currentSrc で取る（srcset 選択後の実 URL）。orig パスのものでも除外しない。
  function renderedPhotoUrls() {
    const m = location.pathname.match(/\/item\/([A-Za-z0-9]+)/);
    const itemId = m ? m[1] : null;
    const map = new Map();
    if (!itemId) return map;
    const re = new RegExp(itemId + "_(\\d+)\\.", "i");
    document.querySelectorAll('img[src*="static.mercdn.net"]').forEach((img) => {
      const url = img.currentSrc || img.getAttribute("src") || "";
      const mm = url.match(re);
      if (!mm) return;
      const prev = map.get(mm[1]);
      if (!prev || (img.naturalWidth || 0) > prev.w) {
        map.set(mm[1], { url, w: img.naturalWidth || 0 });
      }
    });
    // currentSrc で拾えなかった連番は srcset の候補から補う。
    document.querySelectorAll('img[srcset*="static.mercdn.net"]').forEach((img) => {
      (img.getAttribute("srcset") || "").split(",").forEach((part) => {
        const url = part.trim().split(/\s+/)[0];
        const mm = url && url.match(re);
        if (mm && !map.has(mm[1])) map.set(mm[1], { url, w: 0 });
      });
    });
    return map;
  }

  async function handleCopy() {
    let jsonData = null;
    try {
      jsonData = extractFromNextData();
    } catch (e) {
      console.warn("[FurimaCopy] NEXT_DATA の解析に失敗", e);
    }
    // JSON で取れた項目を優先し、欠けた項目だけ DOM で補う。
    const data = FC.mergeData(extractFromDom(), jsonData);
    data.imageUrls = filterItemPhotos(data.imageUrls);
    let saved = await FC.save(
      Object.assign({}, data, { source: "mercari", sourceUrl: location.href })
    );
    console.log("[FurimaCopy]", saved);
    // 画像データもこの場で取り込んで保存する（出品ページで CDN に再取得しないため）。
    FC.ui.showToast("コピーしました。画像を取り込み中…");
    const rendered = renderedPhotoUrls();
    const entries = (saved.imageUrls || []).map((u) => {
      const mm = u.match(/_(\d+)\.(?:jpe?g|png|webp)/i);
      const r = mm ? rendered.get(mm[1]) : null;
      return { key: u, urls: [r && r.url, u].filter(Boolean) };
    });
    let okCount = 0;
    let capItems = [];
    try {
      capItems = await FC.captureImages(entries, saved.sourceUrl);
      okCount = capItems.filter((x) => x.base64).length;
    } catch (e) {
      console.warn("[FurimaCopy] captureImages failed", e);
    }
    FC.ui.showToast(
      "コピーしました：" + (saved.title || "（タイトル不明）") +
      "（画像" + saved.imageUrls.length + "枚 / 取込" + okCount + "枚）"
    );
    return {
      title: saved.title || null,
      price: saved.price != null ? saved.price : null,
      imageCount: (saved.imageUrls || []).length,
      captured: okCount,
      sourceUrl: saved.sourceUrl,
    };
  }

  // sell 側と同じ SPA 対策: スクリプトは jp.mercari.com 全体で読み込まれ、
  // URL が商品ページのときだけコピーボタンを出す。
  const onItemPage = () => /^\/(?:[a-z]{2}\/)?item(?:\/|$)/.test(location.pathname);
  FC.ui.mountButton(handleCopy, onItemPage);

  // リモート指令（v0.5.0）: バックグラウンドからの指示でコピーを実行する。
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.type !== "FurimaRemoteCopy") return false;
      if (!onItemPage()) {
        sendResponse({ ok: false, error: "商品ページではありません: " + location.pathname });
        return false;
      }
      handleCopy()
        .then((summary) => sendResponse({ ok: true, summary }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    });
  }
})();
