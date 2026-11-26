// lib/fill.js
// フリマコピー（自作）の出品フォーム入力用 共通ライブラリ。
// lib/store.js（FurimaCopy）の後に読み込まれる前提。
// 役割:
//   - React 管理下の input / textarea にも効く値セット（native setter + input/change 発火）
//   - セレクタ / placeholder / ラベル の 3 段フォールバックでフィールドを探す
//   - 画像 URL を background 経由で取得し、File 化して input[type=file] に添付する
//   - ネイティブ <select> のテキスト一致選択
//   - 入力ボタン（フローティング）と結果パネルの表示
// 外部依存なし。送信・出品ボタンを押す処理は一切含まない。
(() => {
  "use strict";

  const LOG = "[FurimaCopy]";

  // ---- 値セット ---------------------------------------------------------------
  // React は input の value を独自に追跡しているため、単なる el.value = x では
  // 気付いてもらえないことがある。プロトタイプ側の native setter で入れてから
  // input / change を bubbles 付きで発火させる。
  function setNativeValue(el, value) {
    if (!el) return false;
    try {
      let proto = null;
      if (el instanceof HTMLTextAreaElement) proto = HTMLTextAreaElement.prototype;
      else if (el instanceof HTMLSelectElement) proto = HTMLSelectElement.prototype;
      else if (el instanceof HTMLInputElement) proto = HTMLInputElement.prototype;
      const desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch (e) {
      console.warn(LOG, "setNativeValue failed", e);
      return false;
    }
  }

  // ---- フィールド探索 -------------------------------------------------------------
  function isVisible(el) {
    if (!el) return false;
    try {
      if (!el.getClientRects().length) return false;
      const cs = window.getComputedStyle(el);
      return cs.display !== "none" && cs.visibility !== "hidden";
    } catch (e) {
      return false;
    }
  }

  function isFillable(el) {
    if (!el || el.disabled || el.readOnly) return false;
    // radio / checkbox / ボタン類は「値を入れる欄」ではないので常に対象外。
    // （Yahoo! の価格入力で salesmode の radio を掴んでしまった事故の対策）
    const t = (el.type || "").toLowerCase();
    if (["hidden", "file", "radio", "checkbox", "button", "submit", "reset", "image"].includes(t)) {
      return false;
    }
    return true;
  }

  // セレクタ配列を順に試し、最初に見つかった「見えている」要素を返す。
  function findField(selectorList) {
    for (const sel of selectorList || []) {
      let els;
      try {
        els = document.querySelectorAll(sel);
      } catch (e) {
        continue; // セレクタ不正は無視して次を試す
      }
      for (const el of els) {
        if (isVisible(el)) return el;
      }
    }
    return null;
  }

  // placeholder にキーワードを含む input / textarea を探す。
  function findByPlaceholder(keywords) {
    const els = document.querySelectorAll("input, textarea");
    for (const el of els) {
      const ph = el.getAttribute && el.getAttribute("placeholder");
      if (!ph) continue;
      if ((keywords || []).some((k) => ph.includes(k)) && isVisible(el) && isFillable(el)) {
        return el;
      }
    }
    return null;
  }

  // ラベルからフィールドを探す:
  //   1) <label for="id"> 2) aria-label 3) ラベル風要素の近傍（親を数段たどる）
  function findByLabel(keywords, tagNames) {
    const tags = tagNames || ["INPUT", "TEXTAREA", "SELECT"];
    const ok = (el) => {
      if (!el || !tags.includes(el.tagName)) return false;
      if (!isVisible(el) || !isFillable(el)) return false;
      // INPUT を探す場合はテキスト系 type のみ候補にする。
      if (el.tagName === "INPUT") {
        const t = (el.getAttribute("type") || "text").toLowerCase();
        if (!["text", "search", "number", "tel", "url", "email", "password", ""].includes(t)) return false;
      }
      return true;
    };

    // 1) <label for>
    const labels = document.querySelectorAll("label");
    for (const kw of keywords || []) {
      for (const lab of labels) {
        const t = (lab.textContent || "").trim();
        if (!t || !t.includes(kw)) continue;
        if (lab.htmlFor) {
          const el = document.getElementById(lab.htmlFor);
          if (ok(el)) return el;
        }
        const inner = lab.querySelector("input, textarea, select");
        if (ok(inner)) return inner;
      }
    }

    // 2) aria-label
    const fields = document.querySelectorAll("input, textarea, select");
    for (const kw of keywords || []) {
      for (const el of fields) {
        const al = el.getAttribute && el.getAttribute("aria-label");
        if (al && al.includes(kw) && ok(el)) return el;
      }
    }

    // 3) ラベル風の短いテキスト要素の近傍。
    //    容器内の最初のフィールドではなく「ラベルより後ろにある最初のフィールド」を優先する
    //    （前に別セクションの入力欄があっても誤爆しないため）。
    const labelLike = document.querySelectorAll("label, th, dt, span, div, p, h2, h3, h4");
    for (const kw of keywords || []) {
      for (const lab of labelLike) {
        const t = (lab.textContent || "").trim();
        if (!t || t.length > 40 || !t.includes(kw)) continue;
        let scope = lab.parentElement;
        for (let depth = 0; scope && depth < 5; depth++) {
          const fields = Array.from(scope.querySelectorAll("input, textarea, select")).filter(ok);
          if (fields.length) {
            const after = fields.find(
              (f) => lab.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING
            );
            return after || fields[0];
          }
          scope = scope.parentElement;
        }
      }
    }
    return null;
  }

  // セレクタ → placeholder → ラベル の順で探して値を入れる。成功で true。
  function fillText(selectors, keywords, value) {
    if (value == null || value === "") return false;
    let el = findField(selectors);
    let how = el ? "selector" : null;
    if (!el && keywords && keywords.length) {
      el = findByPlaceholder(keywords);
      if (el) how = "placeholder";
    }
    if (!el && keywords && keywords.length) {
      el = findByLabel(keywords);
      if (el) how = "label";
    }
    if (!el) {
      console.log(LOG, "fillText: field not found", { selectors, keywords, value });
      return false;
    }
    if (el.tagName === "SELECT") {
      return trySelectByText(el, [String(value)]);
    }
    const done = setNativeValue(el, String(value));
    console.log(LOG, "fillText via", how, "->", el, "=", String(value).slice(0, 60));
    return done;
  }

  // リッチテキスト編集欄（contenteditable）をラベル近傍から探して文章を入れる。
  // Yahoo! の説明欄のように、実体が contenteditable で textarea が隠れているフォーム用。
  function fillContentEditable(keywords, value) {
    if (value == null || value === "") return false;
    const editables = Array.from(
      document.querySelectorAll('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]')
    ).filter(isVisible);
    if (!editables.length) return false;
    let target = null;
    const labelLike = document.querySelectorAll("label, th, dt, span, div, p, h2, h3, h4");
    outer: for (const kw of keywords || []) {
      for (const lab of labelLike) {
        const t = (lab.textContent || "").trim();
        if (!t || t.length > 40 || !t.includes(kw)) continue;
        target =
          editables.find((e) => lab.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) ||
          null;
        if (target) break outer;
      }
    }
    if (!target) target = editables[0];
    try {
      target.focus();
      target.innerText = String(value);
      target.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(value) })
      );
      target.dispatchEvent(new Event("change", { bubbles: true }));
      console.log(LOG, "fillContentEditable ->", target);
      return true;
    } catch (e) {
      console.warn(LOG, "fillContentEditable failed", e);
      return false;
    }
  }

  // <select> 専用の探索（セレクタ → ラベル）。
  function findSelect(selectors, keywords) {
    const el = findField(selectors);
    if (el && el.tagName === "SELECT") return el;
    const byLabel = findByLabel(keywords || [], ["SELECT"]);
    return byLabel && byLabel.tagName === "SELECT" ? byLabel : null;
  }

  // ---- <select> のテキスト一致 ------------------------------------------------------
  function normalizeText(s) {
    return String(s || "").replace(/[\s・、,，/／]/g, "").toLowerCase();
  }

  // 候補テキストのいずれかに一致（包含関係含む）する option を選ぶ。
  function trySelectByText(selectEl, candidateTexts) {
    if (!selectEl || selectEl.tagName !== "SELECT") return false;
    const cands = (candidateTexts || []).map(normalizeText).filter(Boolean);
    if (!cands.length) return false;
    const opts = Array.from(selectEl.options)
      .filter((opt) => opt.value) // 「選択してください」等のプレースホルダは飛ばす
      .map((opt) => ({ opt, ot: normalizeText(opt.textContent) }))
      .filter((x) => x.ot);
    // 第 1 パス: 完全一致を全候補・全選択肢で最優先する。
    // 包含一致を先にやると、候補「未使用に近い」に対して先頭の選択肢
    // 「未使用」が部分一致で誤爆する（2026-11-26 実バグ）。
    for (const { opt, ot } of opts) {
      if (cands.some((c) => ot === c)) {
        setNativeValue(selectEl, opt.value);
        console.log(LOG, "trySelectByText matched (exact):", opt.textContent, "in", selectEl);
        return true;
      }
    }
    // 第 2 パス: 表記ゆれ吸収のための包含一致（クロスプラットフォーム用）。
    for (const { opt, ot } of opts) {
      if (cands.some((c) => ot.includes(c) || c.includes(ot))) {
        setNativeValue(selectEl, opt.value);
        console.log(LOG, "trySelectByText matched (partial):", opt.textContent, "in", selectEl);
        return true;
      }
    }
    console.log(LOG, "trySelectByText: no option matched", candidateTexts);
    return false;
  }

  // ---- 画像の添付 -------------------------------------------------------------------
  const EXT_BY_TYPE = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
  };

  // Blob と元 URL から File を作る（名前は URL 末尾 or 連番）。
  function fileFromBlob(blob, url, index) {
    const type = blob.type || "image/jpeg";
    let name = null;
    try {
      const tail = new URL(url).pathname.split("/").pop();
      if (tail && /\.(jpe?g|png|webp|gif)$/i.test(tail)) name = tail;
    } catch (e) {
      /* URL パース失敗時はデフォルト名 */
    }
    if (!name) name = "image-" + (index + 1) + (EXT_BY_TYPE[type] || ".jpg");
    return new File([blob], name, { type });
  }

  // コピー時に取り込み済みの base64 データから File を作る（CDN へは一切アクセスしない）。
  function fileFromBase64(base64, type, url, index) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return fileFromBlob(new Blob([bytes], { type: type || "image/jpeg" }), url, index);
  }

  // 画像を File にして返す。取得は2段構え:
  //   1) ページ文脈から直接 fetch（Origin / Referer がページ自身のものになる。
  //      Mercari の CDN は拡張文脈からの取得を 403 で弾くため、まずこれを試す）
  //   2) background 代理取得（Referer 指定などのフォールバック集）
  async function fetchImageFile(url, index, referrer) {
    try {
      const r = await fetch(url, {
        credentials: "omit",
        headers: { Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8" },
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const blob = await r.blob();
      console.log(LOG, "attachImages: direct fetch ok", url);
      return fileFromBlob(blob, url, index);
    } catch (e) {
      console.warn(LOG, "attachImages: direct fetch failed", url, String((e && e.message) || e));
    }
    const res = await chrome.runtime.sendMessage({ type: "FurimaCopyFetchImage", url, referrer });
    if (!res || !res.ok) {
      throw new Error((res && res.error) || "background fetch failed");
    }
    if (res.attempt) console.log(LOG, "attachImages: fetched via background attempt", res.attempt, url);
    const bin = atob(res.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: res.contentType || "image/jpeg" });
    return fileFromBlob(blob, url, index);
  }

  function setFilesOnInput(input, files) {
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // webp / avif 等は出品フォーム側の形式チェックで弾かれることがあるため、
  // jpeg / png 以外は canvas 経由で JPEG に変換してから添付する。
  async function normalizeImageFile(file) {
    if (file.type === "image/jpeg" || file.type === "image/png") return file;
    try {
      const bmp = await createImageBitmap(file);
      const canvas = document.createElement("canvas");
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      canvas.getContext("2d").drawImage(bmp, 0, 0);
      const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.92));
      if (!blob) return file;
      const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
      console.log(LOG, "attachImages: transcoded to jpeg:", file.name, file.type, "->", name);
      return new File([blob], name, { type: "image/jpeg" });
    } catch (e) {
      console.warn(LOG, "attachImages: transcode failed, using original", file.name, e);
      return file;
    }
  }

  function isVisible(el) {
    return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // 添付できたかの判定材料: ページ内の全 img の src 集合。
  // プレビューが blob: / data: とは限らず、サーバへ即アップロードして
  // その URL をプレビューするフォーム（PayPay 等）もあるため、src の新規出現を見る。
  function snapshotImgSrcs() {
    return new Set(
      Array.from(document.querySelectorAll("img")).map((i) => i.src).filter(Boolean)
    );
  }

  // 新しいプレビュー画像の出現 or アプリ側が入力の files を消費（クリア）したら成功とみなす。
  async function waitForAttachEvidence(beforeSrcs, input, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      for (const img of document.querySelectorAll("img")) {
        if (img.src && !beforeSrcs.has(img.src)) return true;
      }
      if (input && input.files && input.files.length === 0) return true;
      await sleep(350);
    }
    return false;
  }

  // 「画像を追加する」ボタン（見えているものだけ）を探す。
  function findAddImageButton() {
    const els = Array.from(
      document.querySelectorAll("button, [role='button'], a, label, div, span")
    ).filter((el) => {
      if (!isVisible(el)) return false;
      const t = (el.textContent || "").trim();
      return t.length <= 14 && (t.includes("画像を追加") || t.includes("写真を追加"));
    });
    els.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
    if (!els.length) return null;
    const el = els[0];
    return el.closest("button, a, [role='button'], label") || el;
  }

  // input[type=file] が DOM に無いフォーム向けの代替経路。
  // PayPayフリマのように「画像を追加する」ボタン → モーダル経由で初めて
  // ファイル入力が現れるフォームでは、モーダルを開いて入力を探す。
  // knownInputs に含まれない「開いたことで現れた入力」を優先して返す。
  async function tryModalInput(knownInputs) {
    const btn = findAddImageButton();
    if (!btn) {
      console.log(LOG, "attachImages: no add-image button found");
      return { opened: false, input: null };
    }
    console.log(LOG, "attachImages: clicking add-image button", btn);
    btn.click();
    await sleep(900);
    const modalSeen = Array.from(document.querySelectorAll("div, span, button")).some(
      (el) => isVisible(el) && (el.textContent || "").includes("アルバムから選択する")
    );
    console.log(LOG, "attachImages: modal appeared:", modalSeen);
    const inputs = Array.from(document.querySelectorAll('input[type="file"]:not([disabled])'));
    const fresh = inputs.find((el) => !knownInputs.has(el));
    if (fresh) {
      console.log(LOG, "attachImages: found new file input in modal", fresh);
      return { opened: true, input: fresh };
    }
    if (inputs.length) {
      console.log(LOG, "attachImages: no new input; using existing one after modal open", inputs[0]);
      return { opened: true, input: inputs[0] };
    }
    return { opened: true, input: null };
  }

  function closeImageModal() {
    const els = Array.from(document.querySelectorAll("button, [role='button'], a, div, span"));
    const close = els.find((el) => (el.textContent || "").trim() === "閉じる");
    if (close) close.click();
  }

  // ドロップゾーンらしき要素へ drop イベントを送って添付を試みる。
  // リスナは通常ゾーンのルート要素にあるので、ヒント文言を含む「一番小さい要素」に
  // 送ればバブリングで届く（大きい祖先に送ると子であるゾーンには届かない）。
  function dispatchDrop(files) {
    const all = Array.from(document.querySelectorAll("div, section, label, span, button"));
    const hinted = all
      .filter((el) => {
        const t = el.textContent || "";
        return t.length < 200 && /ドラッグ|画像を追加|写真を追加/.test(t);
      })
      .sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
    const classy = document.querySelector(
      '[class*="drop" i], [class*="upload" i], [data-testid*="drop" i], [data-testid*="upload" i]'
    );
    const zone = hinted[0] || classy;
    if (!zone) return false;
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    for (const type of ["dragenter", "dragover", "drop"]) {
      zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    }
    console.log(LOG, "attachImages: dispatched drop on", zone);
    return true;
  }

  // multiple 入力へ 1 枚ずつ入れる方式（v0.12.29、opts.incremental）。
  // 一括セットだとアプリ側が並行アップロードの完了順に並べてしまう
  // （Yahoo! で実測: 7 枚が元順序 [1,2,3,4,5,6,7] に対して
  // [5,3,2,7,6,4,1] に入れ替わった。読み取り側の順序は JSON-LD・
  // ギャラリー DOM とも正しいことを確認済み）。
  // 1 枚入れる → 取り込み痕跡（プレビュー出現 / 入力の消費）を確認 → 次、
  // を繰り返して順番を確定させる。1 枚目で痕跡が無ければ handled:false
  // を返し、呼び出し側が従来の一括方式に切り替える。
  async function attachIncrementally(input, files) {
    // v0.12.32 改修: 初版は最初に掴んだ input を全枚で使い回していたが、
    // Yahoo! では 1 枚目の取り込み後に input 要素が作り直されるらしく、
    // 2 枚目以降が空振りして 1 枚しか付かなかった（2026-11-22 実測）。
    // そこで毎回 input を引き直し、プレビュー src の累積集合で痕跡を
    // 数える（前の枚の遅れて出たプレビューを次の枚の痕跡と誤認しない）。
    // 痕跡が無い枚は input を引き直して 1 回だけ再試行する。
    const findCurrentMulti = () =>
      Array.from(document.querySelectorAll('input[type="file"]')).find(
        (el) => el.multiple
      ) || input;
    let failed = 0;
    let attachedCount = 0;
    let missed = 0;
    const seen = snapshotImgSrcs();
    for (let i = 0; i < files.length; i++) {
      let ok = false;
      for (let attempt = 0; attempt < 2 && !ok; attempt++) {
        const target = findCurrentMulti();
        try {
          setFilesOnInput(target, [files[i]]);
        } catch (e) {
          failed++;
          console.warn(LOG, "attachImages: incremental setFiles failed for file", i, e);
          break;
        }
        ok = await waitForAttachEvidence(seen, target, 10000);
        console.log(
          LOG, "attachImages: incremental file", i, "attempt", attempt, "evidence:", ok
        );
        if (ok) {
          snapshotImgSrcs().forEach((src) => seen.add(src));
        }
      }
      if (!ok) {
        if (i === 0 && failed === 0) {
          return { handled: false, attached: 0, failed: 0, unverified: false };
        }
        missed++;
      } else {
        attachedCount++;
        await sleep(700); // アップローダの後処理を待ってから次へ
      }
    }
    return {
      handled: true,
      attached: attachedCount,
      failed,
      unverified: missed > 0,
    };
  }

  // 画像 URL 群をページの input[type=file] に添付する。
  // multiple な入力があればそこに一括（opts.incremental 指定時は 1 枚ずつ
  // 順番を確定させながら）、なければ各入力に 1 枚ずつ配る。
  async function attachImages(imageUrls, opts) {
    const urls = (imageUrls || []).filter(Boolean);
    if (!urls.length) return { attached: 0, failed: 0 };
    const modalFirst = !!(opts && opts.modalFirst);

    // コピー元ページ URL を Referer として background に渡す（取れなければ null）。
    let referrer = null;
    try {
      const staged = window.FurimaCopy ? await window.FurimaCopy.load() : null;
      if (staged && staged.sourceUrl) referrer = staged.sourceUrl;
    } catch (e) {
      /* Referer は取れなくても致命的ではない */
    }

    // コピー時に取り込み済みの画像データ（あれば最優先で使う。CDN への再取得をしない）。
    const capturedByKey = {};
    try {
      const ci = window.FurimaCopy ? await window.FurimaCopy.loadCapturedImages() : null;
      if (ci && ci.sourceUrl && ci.sourceUrl === referrer) {
        (ci.items || []).forEach((it) => {
          if (it && it.base64) capturedByKey[it.key] = it;
        });
      }
    } catch (e) {
      /* 取り込み済みデータが無ければネットワーク取得にフォールバック */
    }

    const files = [];
    let failed = 0;
    for (let i = 0; i < urls.length; i++) {
      const cap = capturedByKey[urls[i]];
      if (cap) {
        try {
          files.push(fileFromBase64(cap.base64, cap.type, urls[i], i));
          console.log(LOG, "attachImages: used captured image data (via " + (cap.via || "?") + ")", urls[i]);
          continue;
        } catch (e) {
          console.warn(LOG, "attachImages: captured data broken, fallback to fetch", urls[i], e);
        }
      }
      try {
        files.push(await fetchImageFile(urls[i], i, referrer));
        console.log(LOG, "attachImages: fetched", urls[i]);
      } catch (e) {
        failed++;
        console.warn(LOG, "attachImages: fetch failed", urls[i], e);
      }
    }
    if (!files.length) return { attached: 0, failed };

    // 形式チェックで弾かれないよう、添付前に画像形式を正規化する。
    const normalized = [];
    for (const f of files) normalized.push(await normalizeImageFile(f));
    files.length = 0;
    normalized.forEach((f) => files.push(f));

    // モーダル経由でないと入力が現れないフォーム（PayPayフリマ）は、
    // 先に「画像を追加する」を開いて、その入力へ入れる。
    // 一度セットしたら、プレビュー確認が取れなくても二重添付を避けるため
    // 汎用経路での再添付はしない（確認は画面とログに委ねる）。
    if (modalFirst) {
      const before = snapshotImgSrcs();
      const known = new Set(document.querySelectorAll('input[type="file"]'));
      const res = await tryModalInput(known);
      if (res.input) {
        try {
          setFilesOnInput(res.input, files);
          const ok = await waitForAttachEvidence(before, res.input, 5000);
          console.log(LOG, "attachImages: modal-first result, attach evidence:", ok);
          if (res.opened) closeImageModal();
          return { attached: files.length, failed, unverified: !ok };
        } catch (e) {
          console.warn(LOG, "attachImages: modal-first setFiles failed", e);
          if (res.opened) closeImageModal();
        }
      } else if (res.opened) {
        closeImageModal();
      }
      console.log(LOG, "attachImages: modal-first did not attach; falling back to generic path");
    }

    let fileInputs = Array.from(document.querySelectorAll('input[type="file"]')).filter(
      (el) => !el.disabled
    );
    if (!fileInputs.length) {
      // DOM にファイル入力が無いフォームは、画像追加モーダルを開いて入力を探す。
      const known = new Set();
      const res = await tryModalInput(known);
      if (res.input) {
        try {
          const before = snapshotImgSrcs();
          setFilesOnInput(res.input, files);
          console.log(LOG, "attachImages: set", files.length, "files on modal input", res.input);
          const ok = await waitForAttachEvidence(before, res.input, 4000);
          if (res.opened) closeImageModal();
          return { attached: files.length, failed, unverified: !ok };
        } catch (e) {
          console.warn(LOG, "attachImages: modal input setFiles failed", e);
          if (res.opened) closeImageModal();
        }
      } else if (res.opened) {
        closeImageModal();
      }
      // 最後の手段としてドロップを試す。
      if (dispatchDrop(files)) return { attached: files.length, failed };
      console.log(LOG, "attachImages: no file input found");
      return { attached: 0, failed: failed + files.length };
    }

    let attached = 0;
    let unverified = false;
    const multi = fileInputs.find((el) => el.multiple);
    let multiHandled = false;
    if (multi && opts && opts.incremental) {
      const inc = await attachIncrementally(multi, files);
      if (inc.handled) {
        attached = inc.attached;
        failed += inc.failed;
        unverified = inc.unverified;
        multiHandled = true;
      }
    }
    if (multi && !multiHandled) {
      // セットしただけで成功にしない（v0.7.14）: アプリ側が実際に受け取った
      // 痕跡（プレビューの出現 / 入力の files が消費される）を確認する。
      // 痕跡が無く、入力にファイルが手つかずで残っている場合は、アプリの
      // 初期化前に change が流れた可能性が高いので 1 回だけセットし直す。
      const before = snapshotImgSrcs();
      try {
        setFilesOnInput(multi, files);
        console.log(LOG, "attachImages: set", files.length, "files on multiple input", multi);
        let ok = await waitForAttachEvidence(before, multi, 5000);
        if (!ok && multi.files && multi.files.length === files.length) {
          console.log(LOG, "attachImages: input untouched (not consumed); retrying once");
          setFilesOnInput(multi, files);
          ok = await waitForAttachEvidence(before, multi, 5000);
        }
        if (ok) {
          attached = files.length;
        } else {
          // 渡してはいるが画面反映を確認できない。モーダル経路と同じく
          // attached は渡した数、unverified で区別して報告する。
          attached = files.length;
          unverified = true;
          console.warn(LOG, "attachImages: files set but no attach evidence");
        }
      } catch (e) {
        failed += files.length;
        console.warn(LOG, "attachImages: setFiles failed", e);
      }
    } else if (!multi) {
      const before = snapshotImgSrcs();
      const n = Math.min(files.length, fileInputs.length);
      for (let i = 0; i < n; i++) {
        const beforeEach = snapshotImgSrcs();
        try {
          setFilesOnInput(fileInputs[i], [files[i]]);
          attached++;
          console.log(LOG, "attachImages: set file", i, "on input", fileInputs[i]);
        } catch (e) {
          failed++;
          console.warn(LOG, "attachImages: setFiles failed for file", i, e);
          continue;
        }
        // 順番を確定させるため 1 枚ずつ反映を確認してから次を入れる（v0.12.27）。
        // 全部を一括で入れると、アプリ側の取り込み完了順で表示順が入れ替わる
        // ことがある（Yahoo! の単体 input が並ぶフォームで順番が乱れた実績）。
        if (i < n - 1) {
          const okEach = await waitForAttachEvidence(beforeEach, fileInputs[i], 4000);
          console.log(LOG, "attachImages: file", i, "attach evidence:", okEach);
        }
      }
      if (files.length > n) {
        failed += files.length - n;
        console.log(LOG, "attachImages:", files.length - n, "files had no input left");
      }
      if (attached > 0) {
        const ok = await waitForAttachEvidence(before, fileInputs[0], 4000);
        if (!ok) unverified = true;
      }
    }
    return { attached, failed, unverified };
  }

  // ---- 入力ボタン ---------------------------------------------------------------------
  const FILL_BTN_ID = "furimacopy-fill-btn";

  // 出品ページ用のフローティングボタン。store.js のコピーボタンの上に置く。
  // isActive（任意）: SPA 遷移対策。スクリプト自体はサイト全体で読み込まれ、
  // 現在の URL が対象ページのときだけボタンを出し、離れたら取り除く。
  function mountFillButton(onClick, isActive, autoTarget) {
    // 商品ページで「コピー先」を選んだ場合の自動入力（v0.7.6）。
    // autoFillRequest が自分のプラットフォーム宛で ready になっていたら、
    // フォームの出現を待って一度だけ onClick（＝入力処理）を実行する。
    if (autoTarget && window.top === window && !window.__furimaAutoFillWatch) {
      window.__furimaAutoFillWatch = true;
      const startedAt = Date.now();
      let stablePasses = 0;
      const timer = setInterval(async () => {
        try {
          if (Date.now() - startedAt > 3 * 60 * 1000) {
            clearInterval(timer);
            return;
          }
          if (isActive && !isActive()) return;
          const FC = window.FurimaCopy;
          if (!FC || !FC.readAutoFillRequest) return;
          const req = await FC.readAutoFillRequest();
          // 管理プログラムの Mercari タスクは background から対象タブへ直接送る。
          // グローバル要求を残した旧バージョンのタスクも別タブで消費しない。
          if (req && req.managerTaskId && req.target === "mercari") return;
          if (!req || req.target !== autoTarget || req.status !== "ready") return;
          if (Date.now() - (req.at || 0) > 3 * 60 * 1000) return;
          // 「ユーザーが入力ボタンを押せる状態」まで待つ（v0.7.15）。
          // 手動の入力ボタンは元々うまくいくのに自動入力だけ画像が消えたのは、
          // ページ初期化の途中で実行し、初期化や画面遷移に画像を取りこぼして
          // いたため。読込完了＋主要要素の存在が 2 回連続で確認できてから、
          // ボタンと同じ処理を実行する。
          const formReady =
            document.readyState === "complete" &&
            !!document.querySelector("input, textarea") &&
            (autoTarget === "paypay" ||
              !!document.querySelector('input[type="file"]'));
          if (!formReady) {
            stablePasses = 0;
            return;
          }
          stablePasses++;
          if (stablePasses < 2) return;
          clearInterval(timer);
          await FC.clearAutoFillRequest();
          console.log(LOG, "auto-fill from copy-target request:", req);
          await Promise.resolve().then(onClick);
          // 自動入力の完了をプラットフォーム側へ通知する（v0.9.0）。
          // 管理プログラムのタスク（managerTaskId + autoSubmit）のときだけ、
          // filler 側がこのイベントを受けて出品まで進める。通常の自動入力では
          // 誰も受け取らないので何も起きない。
          try {
            window.dispatchEvent(
              new CustomEvent("furimacopy-autofill-done", { detail: req })
            );
          } catch (e) {
            /* noop */
          }
        } catch (e) {
          console.warn(LOG, "auto-fill failed", e);
        }
      }, 1000);
    }

    const ensure = () => {
      if (!document.body) return;
      if (isActive && !isActive()) {
        const old = document.getElementById(FILL_BTN_ID);
        if (old) old.remove();
        return;
      }
      if (document.getElementById(FILL_BTN_ID)) return;
      const btn = document.createElement("button");
      btn.id = FILL_BTN_ID;
      btn.type = "button";
      btn.textContent = "📥 コピー内容を入力";
      btn.style.cssText = [
        "position:fixed",
        "right:16px",
        "bottom:76px",
        "z-index:2147483647",
        "background:#0a7ea4",
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
        Promise.resolve()
          .then(onClick)
          .catch((err) => {
            console.error(LOG, "fill failed", err);
            if (window.FurimaCopy && window.FurimaCopy.ui) {
              window.FurimaCopy.ui.showToast("入力に失敗しました（コンソールを確認してください）");
            }
          });
      });
      document.body.appendChild(btn);
    };

    ensure();

    // SPA 対策（store.js と同じ方式）: DOM 変化を監視してボタンの欠落を検知する。
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
    setInterval(ensure, 2500);
  }

  // ---- 結果パネル ----------------------------------------------------------------------
  const PANEL_ID = "furimacopy-panel";
  const STATUS_ICON = { ok: "✅", manual: "✋", fail: "⚠️" };

  // 診断用：いま表示されているページの実 DOM（操作後の状態）をファイルに保存する。
  // view-source の初期 HTML と違い、その瞬間のフォーム値や開いたピッカーまで含まれる。
  function savePageSnapshot() {
    try {
      const html = "<!DOCTYPE html>\n" + document.documentElement.outerHTML;
      const blob = new Blob([html], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      a.href = url;
      a.download =
        "furimacopy-page-" + location.hostname + "-" + ts + ".html";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      console.warn(LOG, "savePageSnapshot failed", e);
    }
  }

  // lines: [{ label, status: 'ok'|'manual'|'fail', note }]
  function showPanel(title, lines, reportMeta) {
    console.log(LOG, "fill panel:", title, lines);
    try {
      const old = document.getElementById(PANEL_ID);
      if (old) old.remove();

      const panel = document.createElement("div");
      panel.id = PANEL_ID;
      panel.style.cssText = [
        "position:fixed",
        "top:16px",
        "right:16px",
        "width:330px",
        "max-height:72vh",
        "overflow-y:auto",
        "z-index:2147483647",
        "background:#fff",
        "color:#222",
        "border:1px solid #ddd",
        "border-radius:10px",
        "box-shadow:0 8px 28px rgba(0,0,0,0.28)",
        "padding:12px 14px",
        "font-size:13px",
        "line-height:1.55",
        'font-family:"Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif',
      ].join(";");

      const head = document.createElement("div");
      head.style.cssText =
        "display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;";
      const titleEl = document.createElement("strong");
      titleEl.style.fontSize = "14px";
      titleEl.textContent = title;
      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.textContent = "×";
      closeBtn.setAttribute("aria-label", "閉じる");
      closeBtn.style.cssText =
        "border:none;background:#f0f0f0;border-radius:6px;width:26px;height:26px;font-size:15px;cursor:pointer;line-height:1;";
      closeBtn.addEventListener("click", () => panel.remove());
      head.appendChild(titleEl);
      head.appendChild(closeBtn);
      panel.appendChild(head);

      (lines || []).forEach((line) => {
        const row = document.createElement("div");
        row.style.cssText = "padding:3px 0;border-top:1px solid #f2f2f2;";
        const icon = STATUS_ICON[line.status] || "•";
        row.textContent = icon + " " + line.label + (line.note ? "：" + line.note : "");
        panel.appendChild(row);
      });

      const foot = document.createElement("div");
      foot.style.cssText =
        "margin-top:10px;border-top:1px solid #f2f2f2;padding-top:8px;";
      const snapBtn = document.createElement("button");
      snapBtn.type = "button";
      snapBtn.textContent = "🔍 ページ状態を保存（診断用）";
      snapBtn.style.cssText =
        "border:1px solid #ccc;background:#fafafa;border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;";
      snapBtn.addEventListener("click", savePageSnapshot);
      foot.appendChild(snapBtn);
      panel.appendChild(foot);

      document.body.appendChild(panel);

      // 入力結果を storage にも残す（v0.9.0）。管理プログラム連携の実行役
      // （background）が、入力の成否と手動項目をプログラムへ返すために読む。
      try {
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({
            lastFillReport: {
              at: Date.now(),
              url: location.href,
              title,
              lines: (lines || []).map((l) => ({
                label: l.label,
                status: l.status,
                note: l.note || null,
              })),
              ...(reportMeta || {}),
            },
          });
        }
      } catch (e) {
        /* noop */
      }
    } catch (e) {
      console.warn(LOG, "showPanel failed", e);
    }
  }

  // ---- カスタムドロップダウン操作（同プラットフォーム複写用、v0.7.0） ----
  // Mercari などの独自ドロップダウンは「開いて、選択肢をクリック」で操作する。
  // 同プラットフォーム同士なら分類体系が同じなので、コピー元の表示テキストで
  // そのまま選択できる。失敗したら false を返し、呼び出し側が手動に倒す。

  function clickLikeUser(el) {
    if (!el) return false;
    try {
      el.scrollIntoView({ block: "center" });
      ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((t) => {
        el.dispatchEvent(
          new MouseEvent(t, { bubbles: true, cancelable: true, view: window })
        );
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  async function waitFor(fn, timeoutMs, intervalMs) {
    const start = Date.now();
    for (;;) {
      let v = null;
      try {
        v = fn();
      } catch (e) {
        v = null;
      }
      if (v) return v;
      if (Date.now() - start > (timeoutMs || 2000)) return null;
      await sleep(intervalMs || 150);
    }
  }

  // ラベル文言から、その入力コントロールを含む最小のコンテナを探す。
  function fieldContainer(labelTexts) {
    const keys = labelTexts.map((k) => normalizeText(k));
    const all = Array.from(
      document.querySelectorAll("label, h2, h3, span, p, div")
    );
    let labelEl = null;
    for (const el of all) {
      const t = normalizeText(el.textContent);
      if (!t || t.length > 40) continue;
      if (keys.some((k) => t === k || t.startsWith(k))) {
        labelEl = el;
        break;
      }
    }
    if (!labelEl) return null;
    let node = labelEl;
    for (let i = 0; i < 6 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      if (
        node.querySelector(
          'button, [role="combobox"], [role="listbox"], select, [aria-haspopup], a[href]'
        )
      ) {
        return node;
      }
    }
    return labelEl.parentElement || labelEl;
  }

  function findClickableByText(text) {
    const target = normalizeText(text);
    if (!target) return null;
    const cands = Array.from(
      document.querySelectorAll(
        '[role="option"], [role="treeitem"], [role="menuitem"], li, button, a'
      )
    ).filter(isVisible);
    let best = null;
    for (const el of cands) {
      const t = normalizeText(el.textContent);
      if (!t || t.length > target.length + 14) continue;
      if (t === target) return el;
      if (t.includes(target)) {
        if (!best || t.length < normalizeText(best.textContent).length) best = el;
      }
    }
    return best;
  }

  // ラベルで特定したカスタムドロップダウンを開き、optionText を選ぶ。
  async function selectCustomByLabel(labelTexts, optionText) {
    if (!optionText) return false;
    const target = normalizeText(optionText);
    const container = fieldContainer(labelTexts);
    if (!container) return false;
    if (normalizeText(container.textContent).includes(target)) return true;
    const trigger = container.querySelector(
      'button, [role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="true"], select'
    );
    if (!trigger) return false;
    if (trigger.tagName === "SELECT") {
      return trySelectByText(trigger, [optionText]);
    }
    clickLikeUser(trigger);
    const found = await waitFor(() => {
      const opts = Array.from(
        document.querySelectorAll(
          '[role="option"], [role="menuitem"], [role="listbox"] li, [role="listbox"] div, ul li'
        )
      ).filter(isVisible);
      return (
        opts.find((o) => {
          const t = normalizeText(o.textContent);
          return t === target || (t && t.length <= target.length + 12 && t.includes(target));
        }) || null
      );
    }, 2500, 150);
    if (!found) return false;
    clickLikeUser(found);
    await sleep(500);
    const after = fieldContainer(labelTexts);
    return !!(after && normalizeText(after.textContent).includes(target));
  }

  // カテゴリ: パス（「A > B > C」）があれば階層を辿り、葉だけなら検索を先に試す。
  async function pickCategoryPath(labelTexts, categoryText) {
    if (!categoryText) return false;
    const segments = String(categoryText)
      .split(/[>＞›»/／]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!segments.length) return false;
    const leaf = segments[segments.length - 1];
    const container = fieldContainer(labelTexts);
    if (!container) return false;
    const trigger = container.querySelector(
      'button, [role="combobox"], [aria-haspopup], input, [tabindex]'
    );
    if (!trigger) return false;
    clickLikeUser(trigger);
    await sleep(600);

    // 検索ボックスがあるピッカーなら葉カテゴリ名で検索して結果を選ぶ。
    const searchInput = await waitFor(() => {
      const inputs = Array.from(
        document.querySelectorAll(
          'input[type="search"], input[placeholder*="検索"], input[placeholder*="カテゴリ"]'
        )
      ).filter(isVisible);
      return inputs[0] || null;
    }, 1200, 150);
    if (searchInput) {
      setNativeValue(searchInput, leaf);
      searchInput.dispatchEvent(new Event("change", { bubbles: true }));
      const hit = await waitFor(() => findClickableByText(leaf), 2500, 200);
      if (hit) {
        clickLikeUser(hit);
        await sleep(600);
        const after = fieldContainer(labelTexts);
        if (after && normalizeText(after.textContent).includes(normalizeText(leaf))) {
          return true;
        }
      }
    }
    // 階層ドリル: セグメントごとに可視リストから探してクリック。
    for (const seg of segments) {
      const hit = await waitFor(() => findClickableByText(seg), 2500, 200);
      if (!hit) return false;
      clickLikeUser(hit);
      await sleep(700);
    }
    const after = fieldContainer(labelTexts);
    return !!(
      after && normalizeText(after.textContent).includes(normalizeText(leaf))
    );
  }

  window.FurimaFill = {
    setNativeValue,
    isVisible,
    findField,
    findByPlaceholder,
    findByLabel,
    findSelect,
    fillText,
    fillContentEditable,
    attachImages,
    trySelectByText,
    selectCustomByLabel,
    pickCategoryPath,
    normalizeText,
    waitFor,
    clickLikeUser,
    findClickableByText,
    fieldContainer,
    mountFillButton,
    showPanel,
    savePageSnapshot,
  };
})();
