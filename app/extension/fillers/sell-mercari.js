// fillers/sell-mercari.js
// メルカリ出品ページ（https://jp.mercari.com/sell/*）に、ステージング中の
// コピーデータをフォームへ入力する。
// React SPA のため、テキスト項目は native setter 経由（lib/fill.js）で入れる。
// カテゴリ / 商品の状態は、同プラットフォーム複写時のみ自動選択を試みる（v0.7.0）。
// 結果パネルに「手動（候補： …）」として表示するだけにする。
// 手動入力では送信しない。管理タスクで autoSubmit=true の場合だけ自動出品する。
(() => {
  "use strict";
  const FC = window.FurimaCopy;
  const FF = window.FurimaFill;
  if (!FC || !FF) return;

  console.log("[FurimaCopy] mercari sell filler loaded:", location.href);

  // ---- Mercari のカテゴリ選択（v0.7.1） -----------------------------------
  // Mercari のカテゴリはフォーム内モーダルではなく /sell/categories という
  // 別ページ（SPA 遷移）で選ぶ構造:
  //   検索 input「カテゴリー名を検索」+「こちらのカテゴリーですか？」の候補
  //   + 大カテゴリのリンク一覧（/sell/categories?category_id=... を辿る）。
  // 選択すると自動でフォームへ戻る。SPA 遷移なのでこのスクリプトは生き続ける。
  const norm = (s) => FF.normalizeText(s || "");
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

  // 説明の末尾へ「管理No：<code>」を引き継ぐ（管理プログラムの商品番号）。
  // 既に同じ番号が末尾にあればそのまま、別の番号があれば付け替える。
  // Mercari の説明は 1000 文字まで。足すと超える場合は本文の末尾を削って
  // 管理No の行を優先する（実測で 1007/1000 になり出品が止まったため）。
  const DESC_MAX = 1000;
  let codeLineTrimmed = false;
  function ensureCodeLine(text, code) {
    codeLineTrimmed = false;
    const base = text == null ? "" : String(text);
    if (!code) return base;
    const tail = base.match(/\n*\s*管理\s*No[:：]?\s*(\S+)\s*$/);
    if (tail && tail[1] === code && base.length <= DESC_MAX) return base;
    const cleaned = base
      .replace(/\n*\s*管理\s*No[:：]?\s*\S+\s*$/, "")
      .replace(/\s+$/g, "");
    const suffix = "\n\n管理No：" + code;
    const room = DESC_MAX - suffix.length;
    let body = cleaned;
    if (body.length > room) {
      body = body.slice(0, room).replace(/\s+$/g, "");
      codeLineTrimmed = true;
    }
    return body + suffix;
  }

  // 誤クリック防止（v0.7.3）: ファイル入力を含む要素や「画像を選択」系の
  // ボタンは絶対に押さない。カテゴリ選択のつもりで画像選択ダイアログが
  // 開いてしまう事故が実測で起きたため。
  function isSafeTrigger(el) {
    if (!el) return false;
    if (el.querySelector && el.querySelector('input[type="file"]')) return false;
    if (/画像|写真/.test(norm(el.textContent))) return false;
    return true;
  }

  // フォーム上の専用ページへのリンク（/sell/categories 等）を直接探す。
  function findPageLink(hrefPart) {
    return (
      Array.from(document.querySelectorAll('a[href*="' + hrefPart + '"]'))
        .filter(FF.isVisible)
        .find(isSafeTrigger) || null
    );
  }

  // コンテナ内から安全なトリガーを選ぶ（専用ページへのリンクを最優先）。
  function pickTrigger(container, hrefPart) {
    if (!container) return null;
    const cands = Array.from(
      container.querySelectorAll('a, button, [role="button"], [role="combobox"]')
    ).filter((el) => FF.isVisible(el) && isSafeTrigger(el));
    return (
      cands.find(
        (el) => el.tagName === "A" && (el.getAttribute("href") || "").includes(hrefPart)
      ) ||
      cands.find((el) => /選択/.test(norm(el.textContent))) ||
      cands[0] ||
      null
    );
  }

  // フォームに実際に表示されているカテゴリが、目的のパスと一致するか厳密に見る。
  // 判定方式の変遷（いずれも実測）:
  //   - 「葉の文字列を含むか」: 親セグメント（ライト・ランタン）に葉（ランタン）が
  //     含まれるため、同階層の別カテゴリでも成功と誤判定した。
  //   - 「表示末尾＝パス全体」: 値コンテナにラベル等の混入があると、正しく選べて
  //     いても失敗と誤判定した。
  //   - 「区切りで割ってセグメント列照合」: フォームの区切りはアイコン表示で
  //     テキストに現れないため分割できず、またも誤判定した。
  // v0.8.9: パス全体を正規化した連結文字列として、フォーム表示に含まれるかで見る。
  // 葉だけの判定と違い、連結文字列では「親の直後に葉が続く」ことまで固定される
  // ため、同階層の別カテゴリ（…ライト・ランタン＞ヘッドライト・ヘッドランプ）では
  // 一致しない。区切り文字の有無やラベル・ボタンの混入にも左右されない。
  function categorySelected(leaf, segments) {
    if (/categories/.test(location.pathname)) return null;
    const c = FF.fieldContainer(["カテゴリー", "カテゴリ"]);
    if (!c) return null;
    const raw = (c.textContent || "").trim();
    if (!raw) return null;
    const wantSegs = segments && segments.length ? segments : [leaf];
    const wantCat = wantSegs.map(norm).join("");
    if (wantCat && norm(raw).includes(wantCat)) {
      return wantSegs.join(" > ");
    }
    return null;
  }

  // 葉カテゴリ名を含む最小のクリック候補。親セグメントも含むものを優先する。
  // パス形式の候補は末尾セグメントが葉と完全一致するものだけを対象にする
  // （親セグメント内に葉の文字列を含むだけの兄弟カテゴリを除外するため）。
  // 区切りなしの候補は、葉そのものか、親セグメントも含む連結パスだけを対象に
  // する（葉が「その他」のとき「キッチン・日用品・その他」を掴んだ実測があるため）。
  function findSuggestion(leaf, parentSeg) {
    const target = norm(leaf);
    const parent = parentSeg ? norm(parentSeg) : null;
    const cands = Array.from(
      document.querySelectorAll('a, button, li, [role="button"], div')
    ).filter(FF.isVisible);
    let best = null;
    let bestScore = Infinity;
    for (const el of cands) {
      const rawText = el.textContent || "";
      const t = norm(rawText);
      if (!t || !t.includes(target) || t.length > 160) continue;
      if (/[>＞›»]/.test(rawText)) {
        const segs = rawText.split(/[>＞›»]+/).map((s) => s.trim()).filter(Boolean);
        if (segs.length && norm(segs[segs.length - 1]) !== target) continue;
      } else if (t !== target && !(parent && t.includes(parent))) {
        continue;
      }
      const score = t.length - (parent && t.includes(parent) ? 1000 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    if (!best) return null;
    return best.closest('a, button, li, [role="button"]') || best;
  }

  // カテゴリ/状態の選択ページに留まっている場合、履歴を戻って出品フォームへ帰る。
  // 失敗時に別ページで後続の入力（状態・画像）が空振りするのを防ぐ。
  async function backToSellForm() {
    for (let i = 0; i < 4; i++) {
      if (!/\/(categories|conditions|shipping_methods)/.test(location.pathname)) return true;
      history.back();
      await sleepMs(1200);
    }
    return !/\/(categories|conditions|shipping_methods)/.test(location.pathname);
  }

  // 戻り値: 成功したらフォームに実際に表示されたカテゴリパス、失敗したら false。
  async function pickMercariCategory(categoryText) {
    const segments = String(categoryText)
      .split(/[>＞›»]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!segments.length) return false;
    const leaf = segments[segments.length - 1];
    const parentSeg = segments.length > 1 ? segments[segments.length - 2] : null;
    const done = () => categorySelected(leaf, segments);
    if (done()) return done();
    const nav = findPageLink("/sell/categories");
    if (nav) {
      FF.clickLikeUser(nav);
    } else {
      const container = FF.fieldContainer(["カテゴリー", "カテゴリ"]);
      if (!container) return false;
      const trigger = pickTrigger(container, "/sell/categories") || container;
      if (!isSafeTrigger(trigger)) return false;
      FF.clickLikeUser(trigger);
    }
    // カテゴリページへの遷移（検索 input かカテゴリリンクの出現）を待つ。
    await FF.waitFor(
      () =>
        document.querySelector(
          'input[placeholder*="カテゴリー名を検索"], input[placeholder*="カテゴリ"], a[href*="/sell/categories?category_id="]'
        ),
      4000,
      200
    );
    // 1) パスを階層ごとに辿る（完全一致のみ）。
    //    おすすめ候補や検索は、葉が「その他」のような汎用名だと別カテゴリを
    //    掴みやすい（実測: キッチン・日用品・その他 へ遷移して停止した）。
    //    階層辿りは各段が完全一致なので取り違えが起きない。
    for (const seg of segments) {
      if (done()) return done();
      const link = await FF.waitFor(() => {
        const links = Array.from(
          document.querySelectorAll('a[href*="/sell/categories"], li, button')
        ).filter(FF.isVisible);
        return links.find((el) => norm(el.textContent) === norm(seg)) || null;
      }, 2500, 250);
      if (!link) break;
      FF.clickLikeUser(link);
      if (await FF.waitFor(done, 2500, 250)) return done();
      await sleepMs(400);
    }
    if (done()) return done();
    // 2) 検索ボックスに葉カテゴリ名を入れて、結果から選ぶ。
    const searchInput = document.querySelector(
      'input[placeholder*="カテゴリー名を検索"], input[placeholder*="カテゴリ"]'
    );
    if (searchInput) {
      FF.setNativeValue(searchInput, leaf);
      searchInput.dispatchEvent(new Event("change", { bubbles: true }));
      const hit = await FF.waitFor(() => findSuggestion(leaf, parentSeg), 3000, 250);
      if (hit) {
        FF.clickLikeUser(hit);
        if (await FF.waitFor(done, 4000, 250)) return done();
      }
    }
    // 3) おすすめ候補（こちらのカテゴリーですか？）から選ぶ。
    const hit2 = findSuggestion(leaf, parentSeg);
    if (hit2) {
      FF.clickLikeUser(hit2);
      if (await FF.waitFor(done, 4000, 250)) return done();
    }
    // 失敗時はカテゴリページに留まらずフォームへ戻る（後続入力の空振り防止）。
    await backToSellForm();
    return done() || false;
  }

  // ---- Mercari の商品の状態選択（v0.7.2） ---------------------------------
  // 商品の状態もカテゴリと同じく独立ページ /sell/conditions で選ぶ構造
  // （view-source の canonical と i18n 辞書で確認済み。ドロップダウンではない）。
  // ページには状態名そのままの選択肢が並ぶので、完全一致の行をクリックし、
  // フォームへ戻って値が入ったか検証する。
  function conditionSelected(target) {
    if (/conditions/.test(location.pathname)) return null;
    const c = FF.fieldContainer(["商品の状態"]);
    if (c && norm(c.textContent).includes(target)) return c;
    return null;
  }

  function findConditionOption(target) {
    const cands = Array.from(
      document.querySelectorAll('a, button, li, [role="button"], [role="option"], div, span')
    ).filter(FF.isVisible);
    let best = null;
    let bestLen = Infinity;
    for (const el of cands) {
      const t = norm(el.textContent);
      if (t !== target) continue;
      if (t.length < bestLen) {
        bestLen = t.length;
        best = el;
      }
    }
    if (best) return best.closest('a, button, li, [role="button"], [role="option"]') || best;
    // 完全一致が無い場合の包含一致：状態の行は「名前＋説明文」の形で、対象が
    // 説明文（例「新品で購入し、一度も使用していない」）だと名前だけの要素とは
    // 一致しない。各行は自 grade の名前と説明だけを含むため、対象を含む最小の
    // 要素を選べば取り違えは起きにくい（成否は最後にフォーム表示で検証する）。
    let best2 = null;
    let best2Len = Infinity;
    for (const el of cands) {
      const t = norm(el.textContent);
      if (!t || !t.includes(target)) continue;
      if (t.length > target.length + 90) continue;
      if (t.length < best2Len) {
        best2Len = t.length;
        best2 = el;
      }
    }
    if (!best2) return null;
    return best2.closest('a, button, li, [role="button"], [role="option"]') || best2;
  }

  async function pickMercariCondition(conditionText) {
    const target = norm(conditionText);
    if (!target) return false;
    if (conditionSelected(target)) return true;
    const nav = findPageLink("/sell/conditions");
    if (nav) {
      FF.clickLikeUser(nav);
    } else {
      const container = FF.fieldContainer(["商品の状態"]);
      if (!container) return false;
      const trigger = pickTrigger(container, "/sell/conditions") || container;
      if (!isSafeTrigger(trigger)) return false;
      FF.clickLikeUser(trigger);
    }
    // 状態ページ（または選択肢リスト）の出現を待って完全一致の行を選ぶ。
    const opt = await FF.waitFor(() => findConditionOption(target), 4000, 200);
    if (opt) {
      FF.clickLikeUser(opt);
      if (await FF.waitFor(() => conditionSelected(target), 5000, 250)) return true;
    }
    // 旧来のドロップダウン形式だった場合のフォールバック。
    // 汎用判定は誤判定があり得るので、最後は必ずフォーム側の表示で確認する。
    try {
      await FF.selectCustomByLabel(["商品の状態"], conditionText);
    } catch (e) {
      console.warn("[FurimaCopy] condition fallback failed", e);
    }
    const ok = !!conditionSelected(target);
    if (!ok) await backToSellForm();
    return ok;
  }

  // ---- 配送まわり（v0.12.12） ---------------------------------------------
  // 従来は配送・送料を「手動」扱いにしていたため、管理タスクの自動出品が
  // フォーム未選択（配送の方法・発送元の地域）に阻まれて失敗した（A351）。
  // 同プラットフォーム複写では、読み取り側が保持した内訳（負担 / 方法 /
  // 地域 / 日数）をそのまま再現する。成功は常にフォームの実表示で確認する。
  // 括弧の全角・半角ゆれを吸収する比較用正規化。
  const normShip = (s) =>
    norm(s).replace(/（/g, "(").replace(/）/g, ")");

  function selectValueOk(labelTexts, valueText) {
    const sel = FF.findSelect(null, labelTexts);
    if (!sel) return false;
    const opt = sel.options[sel.selectedIndex];
    return !!opt && normShip(opt.textContent) === normShip(valueText);
  }

  async function pickMercariSelect(labelTexts, valueText) {
    if (!valueText) return false;
    if (selectValueOk(labelTexts, valueText)) return true;
    const sel = FF.findSelect(null, labelTexts);
    if (!sel) return false;
    try {
      FF.trySelectByText(sel, [
        valueText,
        String(valueText).replace(/\(/g, "（").replace(/\)/g, "）"),
        String(valueText).replace(/（/g, "(").replace(/）/g, ")"),
      ]);
    } catch (e) {
      console.warn("[FurimaCopy] shipping select failed", e);
    }
    return selectValueOk(labelTexts, valueText);
  }

  // FF.isVisible はレイアウト寸法しか見ないため、高さ 0 のコンテナに
  // 折りたたまれた要素（寸法だけは残る）も「見える」と判定してしまう。
  // 中心点を elementFromPoint で突き合わせ、最前面に本当に現れている
  // 要素だけを可視とする（v0.12.20 の可視ゲートの強化）。
  function isReallyVisible(el) {
    if (!el || !FF.isVisible(el)) return false;
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return false;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight)
      return false;
    const top = document.elementFromPoint(cx, cy);
    return !!top && (top === el || el.contains(top) || top.contains(el));
  }

  function shippingMethodShown(target) {
    const c = FF.fieldContainer(["配送の方法"]);
    if (!c) return false;
    const raw = normShip(c.textContent || "");
    if (!raw || raw.includes(normShip("配送の方法を選択する"))) return false;
    if (raw.includes(normShip(target))) return true;
    // 郵便はフォーム側の表示表記が選択ページと違うことがあるため別表記も見る。
    if (target === "普通郵便（定形、定形外）") {
      return raw.includes(normShip("郵便（定形、定形外、書留など）"));
    }
    return false;
  }

  // 配送の方法ページのラジオを探す。カードには方法名のほかに料金や
  // バッジ（匿名配送・追跡・補償・おすすめ）が混ざり、1 行目の完全一致
  // では拾えないことがある（A351 v0.12.14 で未選択のまま失敗）。
  // 語彙照合で「方法名らしい部分」を取り出して比べる。
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
  function mercariMethodVocabMatch(text) {
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
    return best ? METHOD_CANONICAL[best] || best : null;
  }

  // 選択肢の実構造（ユーザーが開発者ツールで確認、2026-11-22）:
  //   <fieldset class="group inputField">
  //     <input type="radio" name="selectedShippingMethod" value="8">
  //     <div><div><p>レターパック</p></div></div>
  //   </fieldset>
  // label では包まれておらず、input と名称は兄弟。行（fieldset/label/li）
  // 単位でテキスト照合し、その行の input を返す。見えている行を優先し、
  // 無ければ不可視の input も最後の手段として返す（click() は不可視でも
  // 効くことをユーザーがコンソールで実証: checked=true）。
  function findShippingMethodRadio(target) {
    const radios = Array.from(
      document.querySelectorAll(
        'input[name="selectedShippingMethod"], input[type="radio"]'
      )
    );
    let hiddenHit = null;
    for (const r of radios) {
      const row = r.closest("fieldset, label, li") || r.parentElement;
      if (!row) continue;
      const name =
        mercariMethodVocabMatch(row.textContent || "") ||
        normShip((row.textContent || "").trim());
      if (name !== target) continue;
      if (isReallyVisible(row)) return r;
      if (!hiddenHit) hiddenHit = r;
    }
    return hiddenHit;
  }

  // 「その他」展開行を探す。展開行のテキストは「その他 ゆうメール、
  // レターパック、普通郵便…など」と長く、汎用の findClickableByText は
  // 長さ制限で弾いてしまい、そもそも展開できていなかった（レターパック
  // 未選択の原因）。先頭が「その他」の最も短い要素を専用に探す。
  function findShippingOtherExpander() {
    // 実ページの展開ボタン（data-testid で特定可能。ユーザーが
    // コンソールで getElementById(...).click() の有効性を実証済み）。
    const triggers = Array.from(
      document.querySelectorAll(
        'button[data-testid="shipping-service-trigger-button"]'
      )
    ).filter(
      (el) =>
        FF.isVisible(el) &&
        el.getAttribute("aria-expanded") !== "true" &&
        norm(el.textContent || "").startsWith("その他")
    );
    if (triggers.length) return triggers[0];
    const matched = Array.from(
      document.querySelectorAll('button, a, li, [role="button"], div, span')
    )
      .filter((el) => FF.isVisible(el))
      .filter((el) => {
        const t = norm(el.textContent || "");
        return t.startsWith("その他") && t.length <= 60;
      });
    // 親コンテナを掴むとクリックがボタンに届かない（イベントは上にしか
    // 伝播しない）。候補を内包する候補は落とし、最も深い要素を選ぶ。
    const deepest = matched.filter(
      (el) => !matched.some((other) => other !== el && el.contains(other))
    );
    let best = null;
    for (const el of deepest) {
      const t = norm(el.textContent || "");
      if (!best || t.length <= norm(best.textContent || "").length) best = el;
    }
    return best;
  }

  // グループ展開: 合成イベントで開かなければ、要素自体の click()
  // （ユーザーがコンソールで実証した方法）に切り替える。
  async function expandShippingGroup(ex, target) {
    const opened = () => {
      if (ex.getAttribute("aria-expanded") === "true") return true;
      const h = findShippingMethodRadio(target);
      if (!h) return false;
      const row = h.closest("fieldset, label, li") || h.parentElement;
      return !!row && isReallyVisible(row);
    };
    FF.clickLikeUser(ex);
    if (await FF.waitFor(opened, 1200, 200)) return true;
    try {
      ex.click();
    } catch (e) {}
    return !!(await FF.waitFor(opened, 2000, 200));
  }

  async function pickMercariShippingMethod(methodName) {
    // 読み取り値が補足行と連結した塊でも、語彙照合で方法名に直してから探す。
    let resolved = mercariMethodVocabMatch(methodName);
    if (!resolved && methodName) {
      // 読み取りで方法名そのものが落ち、補足行だけが残った場合の救済。
      // 持込ネットワークは便ごとに排他（郵便局=ゆうゆう便、
      // セブン+ファミマ=らくらく便）なので、そこから一意に決まる。
      if (/郵便局/.test(methodName)) resolved = "ゆうゆうメルカリ便";
      else if (/セブン-イレブン/.test(methodName) && /ファミリーマート/.test(methodName))
        resolved = "らくらくメルカリ便";
    }
    const target = normShip(resolved || methodName || "");
    if (!target) return false;
    if (shippingMethodShown(target)) return true;
    const link = findPageLink("/sell/shipping_methods");
    if (link) {
      FF.clickLikeUser(link);
    } else {
      const container = FF.fieldContainer(["配送の方法"]);
      const trigger =
        container &&
        (pickTrigger(container, "/sell/shipping_methods") || container);
      if (!trigger || !isSafeTrigger(trigger)) return false;
      FF.clickLikeUser(trigger);
    }
    // 「その他」組の方法は、展開してからでないと押せない（ユーザー指摘）。
    // 対象がその他組なら、探す前に必ず「その他」を展開する。
    const OTHER_METHODS = [
      "ゆうメール",
      "レターパック",
      "普通郵便（定形、定形外）",
      "クロネコヤマト",
      "ゆうパック",
      "クリックポスト",
      "ゆうパケット",
      "未定",
    ];
    if (
      /shipping_methods/.test(location.pathname) &&
      OTHER_METHODS.includes(target)
    ) {
      const ex = findShippingOtherExpander();
      if (ex) await expandShippingGroup(ex, target);
    }
    const visibleHit = () => {
      const h = findShippingMethodRadio(target);
      if (!h) return null;
      const row = h.closest("fieldset, label, li") || h.parentElement;
      return row && isReallyVisible(row) ? h : null;
    };
    let hit = await FF.waitFor(visibleHit, 8000, 250);
    if (!hit && /shipping_methods/.test(location.pathname)) {
      const expander = findShippingOtherExpander();
      if (expander) {
        await expandShippingGroup(expander, target);
        hit = await FF.waitFor(visibleHit, 4000, 250);
      }
    }
    // 最後の手段: 不可視でも input があれば使う。
    if (!hit) hit = findShippingMethodRadio(target);
    if (!hit) {
      await backToSellForm();
      return false;
    }
    // 押し方: まず input 自体の click()（コンソールで checked=true を
    // 実証済み）。合成イベントの dispatch ではラジオは切り替わらない
    // ので、clickLikeUser は保険に回す。checked が実際に入るまで
    // 諦めない。
    const radioChecked = () => {
      for (const r of document.querySelectorAll('input[type="radio"]')) {
        const row = r.closest("fieldset, label, li") || r.parentElement;
        if (!row) continue;
        const name =
          mercariMethodVocabMatch(row.textContent || "") ||
          normShip((row.textContent || "").trim());
        if (name === target && r.checked) return true;
      }
      return false;
    };
    if (!radioChecked()) {
      try {
        hit.click();
      } catch (e) {}
      await FF.waitFor(radioChecked, 2000, 150);
    }
    if (!radioChecked()) {
      const rowEl = hit.closest
        ? hit.closest("fieldset, label, li")
        : null;
      const nameEl = rowEl
        ? Array.from(rowEl.querySelectorAll("p, div, span")).find(
            (el) => normShip(el.textContent || "") === target
          )
        : null;
      const tries = [];
      if (nameEl) tries.push(nameEl);
      if (rowEl) tries.push(rowEl);
      for (const el of tries) {
        FF.clickLikeUser(el);
        if (await FF.waitFor(radioChecked, 1500, 150)) break;
      }
    }
    if (!radioChecked()) {
      await backToSellForm();
      return false;
    }
    const upd = await FF.waitFor(
      () => FF.findClickableByText("更新する"),
      4000,
      250
    );
    if (upd) FF.clickLikeUser(upd);
    const ok = await FF.waitFor(
      () => shippingMethodShown(target),
      6000,
      250
    );
    if (!ok) await backToSellForm();
    return !!ok;
  }

  // 4 項目を試み、{ parts: 成功した表示, missing: 失敗・欠落した項目名 } を返す。
  async function fillMercariShipping(data) {
    const parts = [];
    const missing = [];
    const tries = [
      ["配送料の負担", data.shippingPayer, () => pickMercariSelect(["配送料の負担"], data.shippingPayer)],
      ["配送の方法", data.shippingMethodName, () => pickMercariShippingMethod(data.shippingMethodName)],
      ["発送元の地域", data.shipFrom, () => pickMercariSelect(["発送元の地域"], data.shipFrom)],
      ["発送までの日数", data.shipDays, () => pickMercariSelect(["発送までの日数"], data.shipDays)],
    ];
    for (const [label, value, fn] of tries) {
      if (!value) {
        missing.push(label + "（読み取りなし）");
        continue;
      }
      let ok = false;
      try {
        ok = await fn();
      } catch (e) {
        console.warn("[FurimaCopy] shipping pick failed: " + label, e);
      }
      if (ok) parts.push(label + ": " + value);
      else missing.push(label);
    }
    return { parts, missing };
  }

  async function handleFill() {
    const data = await FC.load();
    if (!data) {
      FC.ui.showToast("コピー済みの商品がありません");
      return null;
    }
    console.log("[FurimaCopy] mercari fill with:", data);
    const lines = [];

    // タイトル
    const titleOk = FF.fillText(
      [
        'input[name="name"]',
        'input[placeholder*="商品の名前"]',
        'input[placeholder*="商品名"]',
        'input[maxlength="40"]',
      ],
      ["商品の名前", "商品名"],
      data.title
    );
    lines.push({
      label: "タイトル",
      status: titleOk ? "ok" : "fail",
      note: titleOk ? undefined : data.title ? "入力欄が見つかりませんでした" : "コピー元にタイトルがありません",
    });

    // 商品の説明（管理Noがあれば末尾へ自動で引き継ぐ）
    let descText = data.description;
    if (data.inventoryCode) {
      descText = ensureCodeLine(descText, data.inventoryCode);
    }
    const descOk = FF.fillText(
      [
        'textarea[name="description"]',
        'textarea[placeholder*="商品の説明"]',
        'textarea[placeholder*="説明"]',
        "textarea",
      ],
      ["商品の説明", "説明"],
      descText
    );
    if (data.inventoryCode) {
      lines.push({
        label: "管理No",
        status: "ok",
        note:
          data.inventoryCode +
          "（説明の末尾に自動で入ります）" +
          (codeLineTrimmed
            ? " ※1000文字に収めるため本文末尾を少し削りました"
            : ""),
      });
    }
    lines.push({
      label: "商品の説明",
      status: descOk ? "ok" : "fail",
      note: descOk ? undefined : data.description ? "入力欄が見つかりませんでした" : "コピー元に説明がありません",
    });

    // 販売価格
    const priceOk = FF.fillText(
      [
        'input[name="price"]',
        'input[placeholder*="価格"]',
        'input[inputmode="numeric"]',
        'input[type="number"]',
      ],
      ["販売価格", "価格"],
      data.price != null ? String(data.price) : null
    );
    lines.push({
      label: "販売価格",
      status: priceOk ? "ok" : "fail",
      note: priceOk ? "¥" + Number(data.price).toLocaleString("ja-JP") : data.price != null ? "入力欄が見つかりませんでした" : "コピー元に価格がありません",
    });

    // 画像はカテゴリ/状態の後で入れる（v0.7.15）: カテゴリと状態の選択は
    // 別ページへ遷移して戻ってくるため、その前に画像を入れると、遷移・再描画の
    // 過程でアプリ側の状態に登録される前の画像が取りこぼされることがある。
    // 手動ボタン（ページが安定してから押す）でうまくいっていた条件にそろえ、
    // 画像は最後に回す。
    const fillImages = async () => {
    if (data.imageUrls && data.imageUrls.length) {
      let r = await FF.attachImages(data.imageUrls);
      let note =
        r.attached + "枚添付" + (r.failed ? " / " + r.failed + "枚失敗" : "");
      // 取込データが無い/別商品のものだと、CDN への直接取得は 403 で全滅し
      // 0 枚になる。その場合はコピー元ページを開き直して画像を取り直し、
      // もう一度だけ添付を試す（v0.7.13、background の FurimaRecaptureImages）。
      if (!r.attached && data.source === "mercari" && data.sourceUrl) {
        try {
          console.log(
            "[FurimaCopy] no images attached; requesting recapture:",
            data.sourceUrl
          );
          const rec = await chrome.runtime.sendMessage({
            type: "FurimaRecaptureImages",
            itemUrl: data.sourceUrl,
          });
          console.log("[FurimaCopy] recapture result:", rec);
          if (rec && rec.ok && rec.captured > 0) {
            r = await FF.attachImages(data.imageUrls);
            note =
              r.attached +
              "枚添付（商品ページから取り直し）" +
              (r.failed ? " / " + r.failed + "枚失敗" : "");
          }
        } catch (e) {
          console.warn("[FurimaCopy] recapture failed", e);
        }
      }
      if (r.unverified) note += "（画面への反映を確認できず）";
      lines.push({
        label: "画像",
        status: r.attached && !r.unverified ? "ok" : r.attached ? (data.managerTask ? "fail" : "manual") : "fail",
        note,
      });
    } else {
      lines.push({ label: "画像", status: "fail", note: "コピー元に画像がありません" });
    }
    };

    // カテゴリ / 商品の状態: 同プラットフォーム複写のときだけ自動選択を試みる
    // （分類体系が同じため、v0.7.0）。他プラットフォームからは候補提示のみ。
    const samePlatform = data.source === "mercari";
    if (samePlatform && data.categoryText) {
      let picked = false;
      try {
        picked = await pickMercariCategory(data.categoryText);
      } catch (e) {
        console.warn("[FurimaCopy] category pick failed", e);
      }
      lines.push({
        label: "カテゴリ",
        status: picked ? "ok" : data.managerTask ? "fail" : "manual",
        // 成功時はコピー元の文字列ではなく、フォームに実際に表示されたパスを出す。
        note: picked
          ? picked
          : "自動選択できませんでした（候補： " + data.categoryText + "）",
      });
    } else {
      lines.push({
        label: "カテゴリ",
        status: data.managerTask ? "fail" : "manual",
        note: "手動" + (data.categoryText ? "（候補： " + data.categoryText + "）" : "で選択してください"),
      });
    }
    if (samePlatform && data.conditionText) {
      let ok = false;
      try {
        ok = await pickMercariCondition(data.conditionText);
      } catch (e) {
        console.warn("[FurimaCopy] condition select failed", e);
      }
      lines.push({
        label: "商品の状態",
        status: ok ? "ok" : data.managerTask ? "fail" : "manual",
        note: ok
          ? data.conditionText
          : "自動選択できませんでした（候補： " + data.conditionText + "）",
      });
    } else {
      lines.push({
        label: "商品の状態",
        status: data.managerTask ? "fail" : "manual",
        note: "手動" + (data.conditionText ? "（候補： " + data.conditionText + "）" : "で選択してください"),
      });
    }
    await fillImages();

    if (
      samePlatform &&
      (data.shippingPayer || data.shippingMethodName || data.shipFrom || data.shipDays)
    ) {
      const ship = await fillMercariShipping(data);
      if (!ship.missing.length) {
        lines.push({
          label: "配送・送料",
          status: "ok",
          note: ship.parts.join(" / "),
        });
      } else {
        lines.push({
          label: "配送・送料",
          // 管理タスクでは未設定を fail にして自動送信ガードに止めさせる。
          status: data.managerTask ? "fail" : "manual",
          note:
            (ship.parts.length ? ship.parts.join(" / ") + " / " : "") +
            "未設定: " +
            ship.missing.join(", ") +
            (ship.missing.some((mm) => mm.includes("配送の方法")) && data.shippingMethodName
              ? "（方法候補: " + data.shippingMethodName + "）"
              : data.shippingText
                ? "（候補: " + data.shippingText + "）"
                : ""),
        });
      }
    } else {
      lines.push({
        label: "配送・送料",
        status: "manual",
        note: "手動" + (data.shippingText ? "（候補： " + data.shippingText + "）" : "で選択してください"),
      });
    }

    lines.push({
      label: "送信前確認",
      status: "manual",
      note:
        data.managerTask && data.managerTask.autoSubmit
          ? "管理プログラムのタスクのため、この後自動で出品します"
          : "内容を確認してから出品してください（自動送信はしません）",
    });

    FF.showPanel(
      "メルカリ 出品フォーム入力結果",
      lines,
      data.managerTask ? { taskId: data.managerTask.id } : undefined
    );
    if (data.managerTask) {
      await chrome.storage.local.set({
        lastFillReport: {
          at: Date.now(),
          url: location.href,
          title: "メルカリ 出品フォーム入力結果",
          lines: lines.map((line) => ({
            label: line.label,
            status: line.status,
            note: line.note || null,
          })),
          taskId: data.managerTask.id,
        },
      });
    }
    return lines;
  }

  // Mercari は SPA なので、サイト内リンクから /sell/* へ遷移してもページ再読込が
  // 起きず、content script は注入されない。そのためスクリプトは jp.mercari.com
  // 全体で読み込ませ、URL が出品ページのときだけボタンを出す方式にする。
  const onSellPage = () => /^\/(?:[a-z]{2}\/)?sell(?:\/|$)/.test(location.pathname);
  FF.mountFillButton(handleFill, onSellPage, "mercari");

  // リモート指令（v0.5.0）: バックグラウンドからの指示で入力を実行する。
  let managerFillInProgress = false;
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === "FurimaManagerAutoFill") {
        if (!onSellPage()) {
          sendResponse({ ok: false, error: "Mercari 出品ページではありません" });
          return false;
        }
        if (managerFillInProgress) {
          sendResponse({ ok: false, error: "このタブでは既に自動入力を実行中です" });
          return false;
        }
        managerFillInProgress = true;
        (async () => {
          const req = msg.request || {};
          if (!req.managerTaskId) {
            throw new Error("管理タスクの自動出品情報が不正です");
          }
          const ready = await FF.waitFor(
            () =>
              document.readyState === "complete" &&
              !!document.querySelector("input, textarea") &&
              !!document.querySelector('input[type="file"]'),
            30000,
            500
          );
          if (!ready || !onSellPage()) {
            throw new Error("出品フォームの準備ができませんでした");
          }
          const data = await FC.load();
          const managerTask = data && data.managerTask;
          if (!data || !managerTask || managerTask.id !== req.managerTaskId) {
            throw new Error("このタブの商品データが管理タスクと一致しません");
          }
          const actualSourceId =
            String(data.sourceUrl || "").match(/\/item\/(m[A-Za-z0-9]+)/) || [];
          if (req.sourceItemId && actualSourceId[1] !== req.sourceItemId) {
            throw new Error("コピー済み商品 URL が管理タスクの参照元と一致しません");
          }
          if (
            req.sourceItemId &&
            managerTask.sourceItemId !== req.sourceItemId
          ) {
            throw new Error("参照元商品 ID が管理タスクと一致しません");
          }
          if (req.productNo && managerTask.productNo !== req.productNo) {
            throw new Error("商品番号が管理タスクと一致しません");
          }
          const lines = await handleFill();
          if (!lines) throw new Error("コピー済みの商品がありません");
          window.dispatchEvent(
            new CustomEvent("furimacopy-autofill-done", { detail: req })
          );
          return { ok: true };
        })()
          .then(sendResponse)
          .catch((e) =>
            sendResponse({ ok: false, error: String((e && e.message) || e) })
          )
          .finally(() => {
            managerFillInProgress = false;
          });
        return true;
      }
      if (!msg || msg.type !== "FurimaRemoteFill") return false;
      if (!onSellPage()) {
        sendResponse({ ok: false, error: "出品ページではありません: " + location.pathname });
        return false;
      }
      handleFill()
        .then((lines) => {
          if (lines) sendResponse({ ok: true, lines });
          else sendResponse({ ok: false, error: "コピー済みの商品がありません" });
        })
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    });
  }

  // ---- 管理プログラムの自動出品タスク（v0.9.0） -----------------------------
  // 対象タブへの管理タスク指令（または他プラットフォームの共通指令）で
  // 自動入力が完了した場合だけ、「出品する」まで進める。
  // 通常のコピー＆入力・Gist リモート再出品では絶対に発火しない。
  // 結果は storage の lastSubmitReport に残し、background が拾って
  // 管理プログラムへ返す。
  window.addEventListener("furimacopy-autofill-done", (ev) => {
    const req = (ev && ev.detail) || {};
    console.log(
      "[FurimaCopy][auto-submit] autofill-done received:",
      "managerTaskId=" + (req.managerTaskId || "(none)"),
      "autoSubmit=" + !!req.autoSubmit
    );
    if (!req.managerTaskId || !req.autoSubmit) return;
    submitMercariListing(req).catch((e) =>
      console.warn("[FurimaCopy] auto submit failed", e)
    );
  });

  // 「出品する」ボタンを探す（v0.10.1 で強化）。
  // Mercari のボタンは button 要素とは限らないため、要素種を広げて探し、
  // テキストが完全一致する候補の中から「最も小さい要素」（＝ボタン本体で
  // ある可能性が最も高いもの）を選ぶ。ラッパ要素を押すと React の
  // ハンドラに届かないため、深い要素を優先するのが肝。
  function findSubmitButton() {
    const norm = (s) => (s || "").replace(/\s+/g, "");
    const els = Array.from(
      document.querySelectorAll('button, [role="button"], a, div, span')
    );
    const cands = els.filter(
      (el) =>
        FF.isVisible(el) &&
        !el.disabled &&
        norm(el.textContent) === "出品する"
    );
    if (!cands.length) return null;
    const area = (el) => {
      const r = el.getBoundingClientRect();
      return Math.max(1, r.width) * Math.max(1, r.height);
    };
    const tagRank = (el) =>
      el.tagName === "BUTTON" || el.getAttribute("role") === "button" ? 0 : 1;
    cands.sort((a, b) => tagRank(a) - tagRank(b) || area(a) - area(b));
    return cands[0];
  }

  function findCompletionListingUrl() {
    const links = Array.from(
      document.querySelectorAll('a[href], [role="link"][href], button[href]')
    )
      .filter(FF.isVisible)
      .map((el) => ({
        label: norm(el.textContent).replace(/\s+/g, ""),
        href: el.href || el.getAttribute("href"),
      }))
      .filter((link) => link.label.includes("出品した商品"))
      .sort((a, b) => {
        const aExact = a.label.includes("出品した商品を見る") ? 0 : 1;
        const bExact = b.label.includes("出品した商品を見る") ? 0 : 1;
        return aExact - bExact;
      });

    for (const link of links) {
      try {
        const url = new URL(link.href, location.href);
        if (url.hostname !== "jp.mercari.com") continue;
        const itemMatch = url.pathname.match(/\/item\/(m[A-Za-z0-9]+)/);
        if (itemMatch) return "https://jp.mercari.com/item/" + itemMatch[1];
      } catch (e) {
        console.warn("[FurimaCopy][auto-submit] invalid completion link:", link.href);
      }
    }
    return null;
  }

  async function submitMercariListing(req) {
    const LOG = "[FurimaCopy][auto-submit]";
    const report = async (patch) => {
      try {
        await chrome.storage.local.set({
          lastSubmitReport: Object.assign(
            { at: Date.now(), taskId: req.managerTaskId, url: location.href },
            patch
          ),
        });
      } catch (e) {
        /* noop */
      }
      // 結果パネルにも自動出品の結果行を足して、画面上で分かるようにする。
      try {
        const st = await chrome.storage.local.get("lastFillReport");
        const fr = st.lastFillReport;
        if (fr && Array.isArray(fr.lines)) {
          FF.showPanel(fr.title || "メルカリ 出品フォーム入力結果", [
            ...fr.lines.filter((l) => l.label !== "自動出品"),
            {
              label: "自動出品",
              status: patch.ok ? "ok" : "fail",
              note: patch.ok
                ? "出品しました"
                : (patch.message || "失敗しました"),
            },
          ]);
        }
      } catch (e) {
        /* noop */
      }
    };
    const reportListingUrl = async (listingUrl) => {
      const itemMatch = String(listingUrl || "").match(/\/item\/(m[A-Za-z0-9]+)/);
      if (!itemMatch) {
        await report({
          ok: false,
          stage: "verify",
          message: "出品完了ページから新しい Mercari 商品 ID を取得できませんでした。",
        });
        return;
      }
      if (req.sourceItemId && itemMatch[1] === req.sourceItemId) {
        await report({
          ok: false,
          stage: "verify",
          message: "出品後も参照元と同じ商品 ID のままです。新規出品を確認できませんでした。",
        });
        return;
      }
      const codeMatch = ((document.body && document.body.textContent) || "").match(
        /管理\s*No[:：]?\s*([A-Za-z0-9_-]+)/
      );
      if (req.productNo && codeMatch && codeMatch[1] !== req.productNo) {
        await report({
          ok: false,
          stage: "verify",
          message:
            "出品ページの商品管理番号が task と一致しません（ページ: " +
            codeMatch[1] +
            "、task: " +
            req.productNo +
            "）。参照 URL は更新しませんでした。",
        });
        return;
      }
      console.log(LOG, "done, listing:", listingUrl);
      await report({ ok: true, stage: "done", listingUrl });
    };
    console.log(LOG, "start task=" + req.managerTaskId);
    // 入力結果に致命的な失敗（⚠️）やカテゴリ未選択があれば送信しない。
    try {
      const st = await chrome.storage.local.get("lastFillReport");
      const fr = st.lastFillReport;
      console.log(
        LOG,
        "fill report:",
        fr
          ? (fr.lines || []).map((l) => l.label + "=" + l.status).join(", ")
          : "(none)"
      );
      if (
        !fr ||
        fr.taskId !== req.managerTaskId ||
        Date.now() - fr.at >= 5 * 60 * 1000
      ) {
        await report({
          ok: false,
          stage: "fill",
          message: "現在の出品フォーム入力結果が管理タスクと一致しないため、送信しませんでした",
        });
        return;
      }
      if (fr && Date.now() - fr.at < 5 * 60 * 1000) {
        const lines = fr.lines || [];
        const fails = lines.filter((l) => l.status === "fail");
        // v0.12.13: 必須項目は fail ではなく manual の場合も送信しない
        // （商品の状態などがすり抜け、Mercari 側の検証で弾かれる事故があったため）。
        const REQUIRED = [
          "タイトル",
          "商品の説明",
          "販売価格",
          "画像",
          "カテゴリ",
          "商品の状態",
          "配送・送料",
        ];
        const reqBad = REQUIRED.filter(
          (r) => !lines.some((l) => (l.label || "").includes(r) && l.status === "ok")
        );
        if (fails.length || reqBad.length) {
          console.warn(LOG, "blocked by guard");
          await report({
            ok: false,
            stage: "fill",
            message:
              "入力が不完全なため出品しませんでした: " +
              lines
                .filter((l) => l.status !== "ok")
                .map((l) => l.label)
                .join(", "),
          });
          return;
        }
      }
    } catch (e) {
      console.warn(LOG, "guard check error", e);
    }
    console.log(LOG, "guard passed, looking for submit button");
    const btn = await FF.waitFor(findSubmitButton, 15000, 300);
    if (!btn) {
      console.warn(LOG, "submit button not found");
      await report({
        ok: false,
        stage: "submit",
        message: "出品するボタンが見つかりませんでした",
      });
      return;
    }
    console.log(
      LOG,
      "button found:",
      btn.tagName,
      (btn.className && String(btn.className).slice(0, 80)) || ""
    );
    btn.scrollIntoView({ block: "center" });
    await sleepMs(300);
    FF.clickLikeUser(btn);
    console.log(LOG, "clicked (synthetic events)");
    // 送信後の確認: 商品ページへ遷移した URL、または完了画面の
    // 「出品した商品を見る」リンクから新商品の URL を取得する。
    // 途中で確認モーダルの「出品する」が出たらそれも押す。
    // 反応が無ければ 6 秒後に素の click() で 1 回だけ再試行する。
    const startedAt = Date.now();
    let retried = false;
    let modalClicked = false;
    for (;;) {
      await sleepMs(1500);
      const m = location.href.match(/jp\.mercari\.com\/item\/(m[A-Za-z0-9]+)/);
      if (m) {
        await reportListingUrl(location.href);
        return;
      }
      // 完了の証拠は「出品した商品を見る」リンク（/item/<新しい ID>）か
      // 商品ページへの遷移だけとする。本文の「出品しました」「出品が完了」
      // といった文字列は未送信のフォーム上にも現れうるため証拠には使わない
      // （過去にそれで誤判定し、本物のクリック再試行前に終了した）。
      const listingUrl = findCompletionListingUrl();
      if (listingUrl) {
        await reportListingUrl(listingUrl);
        return;
      }
      if (!modalClicked) {
        const other = findSubmitButton();
        if (other && other !== btn) {
          console.log(LOG, "confirmation dialog button found, clicking it");
          modalClicked = true;
          FF.clickLikeUser(other);
          continue;
        }
      }
      if (!retried && Date.now() - startedAt > 6000) {
        retried = true;
        console.log(LOG, "no reaction, retrying with native click()");
        try {
          btn.click();
        } catch (e) {
          console.warn(LOG, "native click failed", e);
        }
        continue;
      }
      if (Date.now() - startedAt > 60000) {
        const errTexts = Array.from(
          document.querySelectorAll(
            '[role="alert"], [class*="error"], [class*="Error"]'
          )
        )
          .map((el) => (el.textContent || "").trim())
          .filter(Boolean)
          .slice(0, 2)
          .join(" / ");
        console.warn(LOG, "timeout waiting for completion", errTexts);
        await report({
          ok: false,
          stage: "submit",
          message:
            "出品完了を確認できませんでした" +
            (errTexts ? ": " + errTexts.slice(0, 120) : ""),
        });
        return;
      }
    }
  }
})();
