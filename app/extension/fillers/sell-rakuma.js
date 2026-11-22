// fillers/sell-rakuma.js
// ラクマ出品ページ（https://fril.jp/item/new*）に、ステージング中の
// コピーデータをフォームへ入力する。
// 従来型フォームなので、テキスト項目に加えてネイティブ <select> の
// 商品の状態・配送料の負担もテキスト一致で自動選択を試みる。
// カテゴリは手動。送信・出品ボタンは絶対に押さない。
(() => {
  "use strict";
  const FC = window.FurimaCopy;
  const FF = window.FurimaFill;
  if (!FC || !FF) return;

  console.log("[FurimaCopy] rakuma sell filler active:", location.href);

  // コピー元の送料テキストから、負担区分の候補を作る。
  function shippingCandidates(text) {
    const t = String(text || "");
    const out = [];
    if (t) out.push(t);
    if (/送料込|出品者負担/.test(t)) out.push("送料込み（出品者負担）", "送料込み", "送料込", "出品者負担");
    if (/着払い|購入者負担/.test(t)) out.push("着払い（購入者負担）", "着払い", "購入者負担");
    return out;
  }

  // カテゴリ候補パスを階層に分解する（区切りは › / > のどちらにも対応）。
  function splitCategoryPath(text) {
    return String(text || "")
      .split(/[›>＞]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function dialogRoot() {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    return (
      dialogs.find((d) => (d.textContent || "").includes("カテゴリから探す")) ||
      dialogs[0] ||
      null
    );
  }

  // オプション要素の表示テキスト（矢印などの装飾を除いたもの）。
  function cleanOptionText(el) {
    return (el.textContent || "")
      .replace(/[⌄^＞>›]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function findDialogButton(root, segment) {
    const target = FF.normalizeText(segment);
    const btns = Array.from(root.querySelectorAll("button"));
    return (
      btns.find((b) => FF.normalizeText(cleanOptionText(b)) === target) ||
      btns.find((b) => FF.normalizeText(cleanOptionText(b)).startsWith(target)) ||
      null
    );
  }

  function findDialogLeaf(root, segment) {
    const target = FF.normalizeText(segment);
    const els = Array.from(root.querySelectorAll("li, div, span, a, button"));
    let best = null;
    for (const el of els) {
      if (FF.normalizeText(cleanOptionText(el)) !== target) continue;
      if (!best || best.contains(el)) best = el; // 最も深い要素を採る
    }
    return best;
  }

  // カテゴリの自動選択（同プラットフォーム複写のみ、v0.8.1）。
  // フォームのカテゴリボタン（初期表示「指定なし」）→ モーダル
  // 「カテゴリから探す」内のアコーディオンを階層どおりに開き、葉を選ぶ。
  // 成功判定はフォームのカテゴリボタンの表示にパス全体が含まれること。
  async function pickRakumaCategory(categoryText) {
    const parts = splitCategoryPath(categoryText);
    if (parts.length < 2) return false;
    const openBtn = Array.from(document.querySelectorAll("button")).find((b) =>
      (b.textContent || "").includes("指定なし")
    );
    if (!openBtn) return false;
    FF.clickLikeUser(openBtn);
    const dlg = await FF.waitFor(() => dialogRoot(), 4000);
    if (!dlg) return false;
    for (let i = 0; i < parts.length - 1; i++) {
      const btn = findDialogButton(dlg, parts[i]);
      if (!btn) return false;
      FF.clickLikeUser(btn);
      const next = parts[i + 1];
      const appeared = await FF.waitFor(
        () => findDialogButton(dlg, next) || findDialogLeaf(dlg, next),
        3500
      );
      if (!appeared) return false;
    }
    const leaf = findDialogLeaf(dlg, parts[parts.length - 1]);
    if (!leaf) return false;
    FF.clickLikeUser(leaf);
    const shown = await FF.waitFor(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) =>
        parts.every((p) => (b.textContent || "").includes(p))
      );
      return btn || null;
    }, 4000);
    return !!shown;
  }

  async function handleFill() {
    const data = await FC.load();
    if (!data) {
      FC.ui.showToast("コピー済みの商品がありません");
      return;
    }
    console.log("[FurimaCopy] rakuma fill with:", data);
    const lines = [];

    // 商品名
    const titleOk = FF.fillText(
      [
        'input[name="item[name]"]',
        'input[name*="name"]',
        'input[name*="title"]',
        'input[placeholder*="商品名"]',
      ],
      ["商品名", "商品の名前"],
      data.title
    );
    lines.push({
      label: "商品名",
      status: titleOk ? "ok" : "fail",
      note: titleOk ? undefined : data.title ? "入力欄が見つかりませんでした" : "コピー元にタイトルがありません",
    });

    // 商品の説明
    const descOk = FF.fillText(
      [
        'textarea[name="item[detail]"]',
        'textarea[name*="detail"]',
        'textarea[name*="description"]',
        'textarea[placeholder*="説明"]',
        "textarea",
      ],
      ["商品の説明", "説明"],
      data.description
    );
    lines.push({
      label: "商品の説明",
      status: descOk ? "ok" : "fail",
      note: descOk ? undefined : data.description ? "入力欄が見つかりませんでした" : "コピー元に説明がありません",
    });

    // 価格
    const priceOk = FF.fillText(
      ['input[name="item[price]"]', 'input[name*="price"]', 'input[placeholder*="価格"]', 'input[inputmode="numeric"]'],
      ["価格", "販売価格"],
      data.price != null ? String(data.price) : null
    );
    lines.push({
      label: "価格",
      status: priceOk ? "ok" : "fail",
      note: priceOk ? "¥" + Number(data.price).toLocaleString("ja-JP") : data.price != null ? "入力欄が見つかりませんでした" : "コピー元に価格がありません",
    });

    // 商品の状態（ネイティブ select をテキスト一致で試す）
    const condSel = FF.findSelect(
      ['select[name*="condition"]', 'select[name*="state"]'],
      ["商品の状態", "状態"]
    );
    const condOk = condSel && data.conditionText
      ? FF.trySelectByText(condSel, [data.conditionText])
      : false;
    lines.push({
      label: "商品の状態",
      status: condOk ? "ok" : "manual",
      note: condOk ? data.conditionText : "手動" + (data.conditionText ? "（候補： " + data.conditionText + "）" : "で選択してください"),
    });

    // 配送料の負担（ネイティブ select をテキスト一致で試す）
    const shipSel = FF.findSelect(
      ['select[name*="shipping"]', 'select[name*="carriage"]', 'select[name*="delivery"]'],
      ["配送料の負担", "送料の負担", "配送料", "送料"]
    );
    const shipCands = shippingCandidates(data.shippingText);
    const shipOk = shipSel && shipCands.length ? FF.trySelectByText(shipSel, shipCands) : false;
    lines.push({
      label: "配送料の負担",
      status: shipOk ? "ok" : "manual",
      note: shipOk ? undefined : "手動" + (data.shippingText ? "（候補： " + data.shippingText + "）" : "で選択してください"),
    });

    // カテゴリ: 同プラットフォーム複写のときだけ自動選択を試みる（v0.8.1）。
    // 他プラットフォームからは分類体系が違うため候補提示のみ。
    const samePlatform = data.source === "rakuma";
    if (samePlatform && data.categoryText) {
      let ok = false;
      try {
        ok = await pickRakumaCategory(data.categoryText);
      } catch (e) {
        console.warn("[FurimaCopy] rakuma category pick failed", e);
      }
      lines.push({
        label: "カテゴリ",
        status: ok ? "ok" : "manual",
        note: ok
          ? data.categoryText
          : "自動選択できませんでした（候補： " + data.categoryText + "）",
      });
    } else {
      lines.push({
        label: "カテゴリ",
        status: "manual",
        note: "手動" + (data.categoryText ? "（候補： " + data.categoryText + "）" : "で選択してください"),
      });
    }

    // 画像は最後に入れる（カテゴリのモーダル操作などをすべて終えてから）。
    if (data.imageUrls && data.imageUrls.length) {
      const r = await FF.attachImages(data.imageUrls);
      let note =
        r.attached + "枚添付" + (r.failed ? " / " + r.failed + "枚失敗" : "");
      if (r.unverified) note += "（画面への反映を確認できず）";
      lines.push({
        label: "画像",
        status: r.attached && !r.unverified ? "ok" : r.attached ? "manual" : "fail",
        note,
      });
    } else {
      lines.push({ label: "画像", status: "fail", note: "コピー元に画像がありません" });
    }

    lines.push({
      label: "送信前確認",
      status: "manual",
      note: "内容を確認してから出品してください（自動送信はしません）",
    });

    FF.showPanel("ラクマ 出品フォーム入力結果", lines);
  }

  FF.mountFillButton(handleFill, null, "rakuma");
})();
