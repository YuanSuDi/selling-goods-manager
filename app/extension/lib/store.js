// lib/store.js
// フリマコピー（自作）の共通ライブラリ。
// 役割:
//   - コピーデータの保存 / 読込 / 削除（chrome.storage.local、キー "copyData"）
//   - 各サイト共通の DOM ヘルパー、フローティングボタン、トースト表示
// 外部依存なし。外部サーバーへの通信は一切しない。
(() => {
  "use strict";

  const STORAGE_KEY = "copyData";
  const IMAGES_KEY = "copyImages";

  // ---- データモデル ---------------------------------------------------------
  // { source, sourceUrl, title, description, price(number|null),
  //   imageUrls[], conditionText, categoryText, shippingText, copiedAt }
  function emptyData() {
    return {
      source: null, // 'mercari' | 'rakuma' | 'paypay' | 'yahoo'
      sourceUrl: null,
      title: null,
      description: null,
      price: null,
      imageUrls: [],
      conditionText: null,
      categoryText: null,
      shippingText: null,
      shippingMethod: null, // 配送方法名（Yahoo! の構造化データから取得）
      shippingMethodId: null, // 配送方法 ID（PayPay の deliveryMethod.id、出品フォームの radio name と一致）
      shippingBurden: null, // 'seller' | 'buyer' | null
      shipFrom: null, // 発送元の地域（都道府県名）
      shipDays: null, // 発送までの日数（例 "2〜3日"）
      inventoryCode: null, // 管理No（管理プログラムの商品番号、出品時に説明末尾へ引き継ぐ）
      imageHash: null, // 先頭画像の知覚ハッシュ（v0.6.0）
      copiedAt: null, // ISO 文字列（save 時に自動で入る）
    };
  }

  async function save(data) {
    const payload = Object.assign(emptyData(), data || {}, {
      copiedAt: new Date().toISOString(),
    });
    payload.imageUrls = collectImages(payload.imageUrls);
    await chrome.storage.local.set({ [STORAGE_KEY]: payload });
    return payload;
  }

  async function load() {
    const res = await chrome.storage.local.get(STORAGE_KEY);
    return res[STORAGE_KEY] || null;
  }

  async function clear() {
    await chrome.storage.local.remove([STORAGE_KEY, IMAGES_KEY]);
  }

  // base の欠けた項目を override の値で補う（override の非空項目を優先）。
  function mergeData(base, override) {
    const out = Object.assign({}, base || {});
    Object.entries(override || {}).forEach(([k, v]) => {
      if (v == null) return;
      if (Array.isArray(v) && v.length === 0) return;
      if (typeof v === "string" && !v.trim()) return;
      out[k] = v;
    });
    return out;
  }

  // ---- 画像 URL ---------------------------------------------------------------
  // サムネイル用のサイズ指定パラメータだけを取り除いて大きめの画像を狙う。
  // パス自体の書き換えはしない（壊れた URL を作らないため）。
  const SIZE_PARAMS = ["w", "h", "width", "height", "quality", "q", "fit", "crop", "fm", "format"];

  function normalizeImageUrl(url) {
    if (!url || typeof url !== "string") return null;
    if (url.startsWith("data:") || url.startsWith("blob:")) return null;
    try {
      const u = new URL(url, location.href);
      SIZE_PARAMS.forEach((p) => u.searchParams.delete(p));
      return u.toString();
    } catch (e) {
      return null;
    }
  }

  // 正規化 + 重複除去した画像 URL 配列を返す。
  function collectImages(urls) {
    const seen = new Set();
    const out = [];
    (urls || []).forEach((raw) => {
      const u = normalizeImageUrl(raw);
      if (u && !seen.has(u)) {
        seen.add(u);
        out.push(u);
      }
    });
    return out;
  }

  // ---- 価格パース ---------------------------------------------------------------
  // "¥1,234" / "1234円" のような文字列や数値から数値を取り出す。取れなければ null。
  function parsePrice(text) {
    if (text == null) return null;
    if (typeof text === "number") return Number.isFinite(text) ? text : null;
    const m = String(text).replace(/,/g, "").match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
  }

  // ---- DOM ヘルパー ---------------------------------------------------------------
  const dom = {
    // セレクタ配列を順に試し、最初に見つかった要素のテキストを返す。
    text(selectors, root) {
      const scope = root || document;
      for (const sel of selectors || []) {
        try {
          const el = scope.querySelector(sel);
          if (el && el.textContent && el.textContent.trim()) return el.textContent.trim();
        } catch (e) {
          /* セレクタ不正などは無視して次を試す */
        }
      }
      return null;
    },

    // og: などの meta タグの content を返す。
    meta(name) {
      const el = document.querySelector(
        'meta[property="' + name + '"], meta[name="' + name + '"]'
      );
      return el && el.content ? el.content : null;
    },

    // ページ内の JSON-LD を全部パースしてオブジェクトの配列で返す（失敗分は捨てる）。
    jsonLdList() {
      const out = [];
      document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
        try {
          const parsed = JSON.parse(s.textContent);
          (Array.isArray(parsed) ? parsed : [parsed]).forEach((x) => {
            if (x && typeof x === "object") out.push(x);
          });
        } catch (e) {
          /* パースできない JSON-LD は無視 */
        }
      });
      return out;
    },

    // 「商品の状態： 新品」のような定義リスト / 表から、ラベルに対応する値を探す。
    specValue(labels) {
      const labelEls = document.querySelectorAll("th, dt");
      for (const el of labelEls) {
        const labelText = (el.textContent || "").trim();
        if (!labels.some((l) => labelText.includes(l))) continue;
        const row = el.closest("tr");
        if (row) {
          const cells = row.querySelectorAll("td");
          for (const c of cells) {
            const t = (c.textContent || "").trim();
            if (t && t !== labelText) return t;
          }
        }
        const next = el.nextElementSibling;
        if (next && next.textContent && next.textContent.trim()) {
          return next.textContent.trim();
        }
        if (el.parentElement) {
          const t = el.parentElement.textContent.replace(labelText, "").trim();
          if (t) return t;
        }
      }
      return null;
    },
  };

  // ---- UI（フローティングボタン / トースト） ---------------------------------------
  const BTN_ID = "furimacopy-btn";
  const TOAST_ID = "furimacopy-toast";

  function showToast(message) {
    try {
      const old = document.getElementById(TOAST_ID);
      if (old) old.remove();
      const el = document.createElement("div");
      el.id = TOAST_ID;
      el.textContent = message;
      el.style.cssText = [
        "position:fixed",
        "left:50%",
        "bottom:76px",
        "transform:translateX(-50%)",
        "z-index:2147483647",
        "background:rgba(20,20,20,0.88)",
        "color:#fff",
        "padding:10px 16px",
        "border-radius:8px",
        "font-size:14px",
        "line-height:1.4",
        "max-width:82vw",
        "box-shadow:0 4px 16px rgba(0,0,0,0.3)",
        "pointer-events:none",
      ].join(";");
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 3600);
    } catch (e) {
      /* トースト表示の失敗は致命的ではない */
    }
  }

  // ---- コピー先を選んで出品ページで自動入力（v0.7.6） -------------------------
  // 商品ページのボタンにホバーするとコピー先プラットフォームを選べる。
  // 選んだら対象の出品ページを新しいタブで開き（ポップアップブロック回避のため
  // 同期的に開く）、コピーが完了したら autoFillRequest を ready にする。
  // 出品ページ側の filler がそれを見て一度だけ自動入力する（lib/fill.js）。
  const SELL_URLS = {
    mercari: "https://jp.mercari.com/sell/create",
    rakuma: "https://fril.jp/item/new",
    paypay: "https://paypayfleamarket-sec.yahoo.co.jp/item/add?from=sellTop",
    yahoo: "https://auctions.yahoo.co.jp/jp/show/submit?category=0",
  };
  const PLATFORM_NAMES = {
    mercari: "メルカリ",
    rakuma: "ラクマ",
    paypay: "PayPayフリマ",
    yahoo: "Yahoo!オークション",
  };
  const AUTOFILL_KEY = "autoFillRequest";

  function storageLocal() {
    return typeof chrome !== "undefined" && chrome.storage && chrome.storage.local
      ? chrome.storage.local
      : null;
  }
  function setAutoFillRequest(req) {
    return new Promise((resolve) => {
      const s = storageLocal();
      if (!s) return resolve(false);
      try {
        s.set({ [AUTOFILL_KEY]: req }, () => resolve(true));
      } catch (e) {
        resolve(false);
      }
    });
  }
  function readAutoFillRequest() {
    return new Promise((resolve) => {
      const s = storageLocal();
      if (!s) return resolve(null);
      try {
        s.get([AUTOFILL_KEY], (items) => resolve((items && items[AUTOFILL_KEY]) || null));
      } catch (e) {
        resolve(null);
      }
    });
  }
  function clearAutoFillRequest() {
    return new Promise((resolve) => {
      const s = storageLocal();
      if (!s) return resolve(false);
      try {
        s.remove([AUTOFILL_KEY], () => resolve(true));
      } catch (e) {
        resolve(false);
      }
    });
  }

  // フローティングボタンを 1 つだけ設置する。
  // SPA の画面遷移でボタンが消えても、監視して自動で復活させる（二重設置はしない）。
  // isActive（任意）: スクリプト自体はサイト全体で読み込まれ、現在の URL が
  // 対象ページのときだけボタンを出し、離れたら取り除く（SPA 遷移対策）。
  function mountButton(onClick, isActive) {
    const runCopy = () =>
      Promise.resolve()
        .then(onClick)
        .catch((err) => {
          console.error("[FurimaCopy] copy failed", err);
          showToast("コピーに失敗しました（コンソールを確認してください）");
          throw err;
        });

    const pickTarget = (target) => {
      const url = SELL_URLS[target];
      if (!url) return;
      // 先に保存してから遷移する（v0.7.14、ユーザー指定の順序）。
      // ポップアップブロック回避のため、クリックの同期コンテキストでは
      // 空タブだけを開いておき、コピー（保存）が完了してからそのタブを
      // 出品ページへ遷移させる。コピーが終わる前に出品ページが開くと、
      // 画像取り込みと自動入力が競合して不安定になるため。
      const win = window.open("", "_blank");
      (async () => {
        await setAutoFillRequest({ target, at: Date.now(), status: "pending" });
        showToast(
          "コピー中…完了したら " + (PLATFORM_NAMES[target] || target) + " の出品ページを開いて自動入力します"
        );
        try {
          await runCopy();
        } catch (e) {
          await clearAutoFillRequest();
          if (win && !win.closed) win.close();
          return;
        }
        await setAutoFillRequest({ target, at: Date.now(), status: "ready" });
        if (win && !win.closed) {
          win.location.href = url;
        } else {
          window.open(url, "_blank");
        }
      })();
    };

    const ensure = () => {
      if (!document.body) return;
      if (isActive && !isActive()) {
        const old = document.getElementById(BTN_ID);
        if (old) old.remove();
        return;
      }
      if (document.getElementById(BTN_ID)) return;

      const wrap = document.createElement("div");
      wrap.id = BTN_ID;
      wrap.style.cssText = [
        "position:fixed",
        "right:16px",
        "bottom:16px",
        "z-index:2147483647",
        "display:flex",
        "flex-direction:column",
        "align-items:flex-end",
        "gap:8px",
        "font-family:sans-serif",
      ].join(";");

      const menu = document.createElement("div");
      menu.style.cssText = [
        "display:none",
        "background:#fff",
        "border-radius:12px",
        "box-shadow:0 6px 24px rgba(0,0,0,0.3)",
        "padding:10px",
        "min-width:210px",
      ].join(";");
      const head = document.createElement("div");
      head.textContent = "コピーして出品ページへ：";
      head.style.cssText = "font-size:12px;color:#555;margin:2px 4px 8px;";
      menu.appendChild(head);
      Object.keys(SELL_URLS).forEach((key) => {
        const item = document.createElement("button");
        item.type = "button";
        item.textContent = "→ " + PLATFORM_NAMES[key] + " に出品";
        item.style.cssText = [
          "display:block",
          "width:100%",
          "text-align:left",
          "background:#f5f5f5",
          "border:none",
          "border-radius:8px",
          "padding:9px 10px",
          "font-size:13px",
          "font-weight:600",
          "cursor:pointer",
          "margin-top:6px",
          "color:#222",
        ].join(";");
        item.addEventListener("click", () => {
          menu.style.display = "none";
          pickTarget(key);
        });
        menu.appendChild(item);
      });
      wrap.appendChild(menu);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "📋 この商品をコピー";
      btn.style.cssText = [
        "background:#e60023",
        "color:#fff",
        "border:none",
        "border-radius:999px",
        "padding:12px 18px",
        "font-size:14px",
        "font-weight:700",
        "cursor:pointer",
        "box-shadow:0 4px 14px rgba(0,0,0,0.35)",
      ].join(";");
      btn.addEventListener("click", () => {
        menu.style.display = "none";
        runCopy().catch(() => {});
      });
      wrap.appendChild(btn);

      let hideTimer = null;
      wrap.addEventListener("mouseenter", () => {
        if (hideTimer) clearTimeout(hideTimer);
        menu.style.display = "block";
      });
      wrap.addEventListener("mouseleave", () => {
        hideTimer = setTimeout(() => {
          menu.style.display = "none";
        }, 350);
      });

      document.body.appendChild(wrap);
    };

    ensure();

    // SPA 対策: DOM 変化をスロットル付きで監視し、ボタンの欠落を検知する。
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        ensure();
      }, 300);
    });
    if (document.documentElement) {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    // URL 遷移だけのケースに備えた保険。
    setInterval(ensure, 2500);
  }

  // ---- 画像データの取り込み（コピー時にページ文脈で実施） -------------------------
  // 背景: Mercari の CDN は fetch / XHR による取得を 403 で弾くが、ページが <img> として
  // 表示する通常の画像リクエストは通る。そこでコピー時点（商品ページ）で画像を読み込み、
  // バイト列を base64 化して chrome.storage.local に保存しておく。
  // 出品ページ側は保存済みデータから File を作るので、CDN への再取得が不要になる。
  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  // <img> として読み込む。成功したら img 要素、失敗/タイムアウトは null。
  function loadImageElement(url, cors, timeoutMs) {
    return new Promise((resolve) => {
      const img = new Image();
      const timer = setTimeout(() => resolve(null), timeoutMs || 10000);
      img.onload = () => { clearTimeout(timer); resolve(img); };
      img.onerror = () => { clearTimeout(timer); resolve(null); };
      if (cors) img.crossOrigin = "anonymous";
      img.src = url;
    });
  }

  async function fetchBlobAsBase64(url, init) {
    try {
      const r = await fetch(url, init);
      if (!r.ok) {
        console.warn("[FurimaCopy] fetchBlob HTTP", r.status, url);
        return null;
      }
      const blob = await r.blob();
      if (!blob.size) return null;
      return { base64: arrayBufferToBase64(await blob.arrayBuffer()), type: blob.type || "image/jpeg" };
    } catch (e) {
      console.warn("[FurimaCopy] fetchBlob error", String((e && e.message) || e), url);
      return null;
    }
  }

  async function imageElementToBase64(img) {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      if (!canvas.width || !canvas.height) return null;
      canvas.getContext("2d").drawImage(img, 0, 0);
      const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.92));
      if (!blob) return null;
      return { base64: arrayBufferToBase64(await blob.arrayBuffer()), type: "image/jpeg" };
    } catch (e) {
      return null; // taint されている場合はここで失敗する
    }
  }

  // ブラウザが画像読み込み時に送る Accept。これを付けないと CDN の Vary 判定で
  // HTTP キャッシュにヒットせず、ネットワークへ出て 403 になる（実測）。
  const IMAGE_ACCEPT = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";

  // 1 枚分の取り込み。候補 URL を順に試し、URL ごとに
  // (a) <img> で読み込み → HTTP キャッシュから force-cache / default で取り出す
  // (b) 通常 fetch
  // (c) CORS 付き <img> → canvas
  // の順でバイト列の取得を試みる。
  async function captureFromUrl(url) {
    const headers = { Accept: IMAGE_ACCEPT };
    const img = await loadImageElement(url, false);
    if (img) {
      for (const cacheMode of ["force-cache", "default"]) {
        const got = await fetchBlobAsBase64(url, { cache: cacheMode, headers });
        console.log("[FurimaCopy] capture try cache=" + cacheMode, url, got ? "OK" : "miss");
        if (got) return Object.assign(got, { via: "cache-" + cacheMode });
      }
    } else {
      console.log("[FurimaCopy] capture img load failed", url);
    }
    const direct = await fetchBlobAsBase64(url, { headers });
    if (direct) return Object.assign(direct, { via: "fetch" });
    const corsImg = await loadImageElement(url, true);
    if (corsImg) {
      const fromCanvas = await imageElementToBase64(corsImg);
      if (fromCanvas) return Object.assign(fromCanvas, { via: "canvas" });
    }
    return null;
  }

  // entries: [{key, urls:[候補URL...]}] を取り込んで copyImages キーに保存する。
  // key は出品データ側の imageUrls と一致させる（fill 側で突き合わせるため）。
  async function captureImages(entries, sourceUrl) {
    const items = [];
    for (const ent of entries || []) {
      let got = null;
      for (const url of ent.urls || []) {
        if (!url) continue;
        got = await captureFromUrl(url);
        if (got) { got.capturedUrl = url; break; }
      }
      items.push({
        key: ent.key,
        base64: got ? got.base64 : null,
        type: got ? got.type : null,
        via: got ? got.via : null,
        capturedUrl: got ? got.capturedUrl : null,
      });
      console.log("[FurimaCopy] capture", ent.key, got ? "ok via " + got.via : "FAILED");
    }
    try {
      await chrome.storage.local.set({
        [IMAGES_KEY]: { sourceUrl: sourceUrl || null, at: new Date().toISOString(), items },
      });
    } catch (e) {
      console.warn("[FurimaCopy] capture store failed", e);
    }
    return items;
  }

  async function loadCapturedImages() {
    const res = await chrome.storage.local.get(IMAGES_KEY);
    return res[IMAGES_KEY] || null;
  }

  window.FurimaCopy = {
    save,
    load,
    clear,
    captureImages,
    loadCapturedImages,
    setAutoFillRequest,
    readAutoFillRequest,
    clearAutoFillRequest,
    emptyData,
    mergeData,
    parsePrice,
    normalizeImageUrl,
    collectImages,
    dom,
    ui: { mountButton, showToast },
  };
})();
