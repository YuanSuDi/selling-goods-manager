// fillers/sell-paypay.js
// PayPayフリマ（Yahoo!フリマ）出品ページ
// （https://paypayfleamarket.yahoo.co.jp/item/add* ほか）に、
// ステージング中のコピーデータをフォームへ入力する。
// Next.js SPA のため、テキスト項目は native setter 経由（lib/fill.js）で入れる。
// カテゴリ / 商品の状態は、同プラットフォーム複写時のみ自動選択を試みる（v0.7.0）。
// 結果パネルに「手動（候補： …）」として表示するだけにする。
// 送信・出品ボタンは絶対に押さない。
(() => {
  "use strict";
  const FC = window.FurimaCopy;
  const FF = window.FurimaFill;
  if (!FC || !FF) return;

  console.log("[FurimaCopy] paypay sell filler active:", location.href);

  // ---- PayPay のカテゴリ / 商品の状態の選択（v0.7.5） ----------------------
  // フォームの各行は「ラベル＋値ボックス（選択してください（必須） >）」で、
  // 値ボックスを押すとピッカー（モーダル/別画面）が開く構造。
  // v0.7.0 の汎用ドロップダウン方式は「ラベルと値を含む大きな要素がある」だけで
  // 成功判定してしまい、実際は未選択なのに ✅ になる誤判定があった。
  // ここでは成功判定を「フォームの値ボックスに実際に値が表示されたこと」に限定する。
  const norm = (s) => FF.normalizeText(s || "");
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  const PLACEHOLDER = "選択してください";

  function findLabelEls(labelText) {
    return Array.from(document.querySelectorAll("label, h2, h3, span, p, div"))
      .filter(FF.isVisible)
      .filter((el) => {
        const t = norm(el.textContent);
        return (
          t === labelText ||
          (t.startsWith(labelText) && t.length <= labelText.length + 3)
        );
      });
  }

  // ラベルを含む最小のセクションを探し、表示中の値を読み取る。
  // セクションのテキストからラベルと「必須」を除いた残りが値（未選択時は
  // プレースホルダ）。祖先が大きくなり過ぎたらそのラベルは諦める。
  function fieldSection(labelText) {
    for (const labelEl of findLabelEls(labelText)) {
      let node = labelEl;
      for (let i = 0; i < 6 && node; i++) {
        node = node.parentElement;
        if (!node) break;
        const rest = norm(node.textContent)
          .split(labelText)
          .join("")
          .replace(/必須/g, "")
          .replace(/[（）()]/g, "")
          .trim();
        if (!rest) continue;
        if (rest.length > 80) break;
        return {
          section: node,
          value: rest.startsWith(PLACEHOLDER) ? null : rest,
        };
      }
    }
    return null;
  }

  // 文書順フォールバック（v0.7.8）: ラベルの後ろに現れる最初の
  // 「選択してください」ボックスを探す。セクション辿りが外れた場合の保険。
  // 返すのは一致要素の中で一番深いもの（クリックを最下層からバブリングさせるため）。
  function valueBoxAfterLabel(labelText) {
    const all = Array.from(
      document.querySelectorAll("div, span, button, a, label, p, h2, h3")
    );
    let start = -1;
    for (let i = 0; i < all.length; i++) {
      if (norm(all[i].textContent) === labelText) {
        start = i;
        break;
      }
    }
    if (start < 0) return null;
    const limit = Math.min(all.length, start + 60);
    const found = [];
    for (let i = start + 1; i < limit; i++) {
      const el = all[i];
      if (!FF.isVisible(el)) continue;
      const t = norm(el.textContent);
      if (!t || t === labelText || t === "必須") continue;
      if (t.startsWith(PLACEHOLDER) && t.length <= 16) found.push(el);
    }
    if (!found.length) return null;
    return (
      found.filter((b) => !found.some((o) => o !== b && b.contains(o)))[0] ||
      found[0]
    );
  }

  // 未選択の行について、クリックすべき値ボックスを返す。
  // ボックスは div の入れ子で、表示テキストは最下層の <p> にある（実物ソースで確認）。
  // 外側のラッパーをクリックすると内側のハンドラに届かないため、最下層の要素を返す。
  function fieldRow(labelText) {
    const sec = fieldSection(labelText);
    if (sec && !sec.value) {
      const boxes = Array.from(sec.section.querySelectorAll("button, a, div, span, p"))
        .filter(FF.isVisible)
        .filter((el) => norm(el.textContent).startsWith(PLACEHOLDER));
      if (boxes.length) {
        const innermost = boxes.filter(
          (b) => !boxes.some((o) => o !== b && b.contains(o))
        );
        return { row: sec.section, valueBox: innermost[0] || boxes[0] };
      }
    }
    const box = valueBoxAfterLabel(labelText);
    if (box) return { row: box.parentElement || box, valueBox: box };
    return null;
  }

  const OTHER_LABELS = ["カテゴリ", "商品の状態", "配送", "配送方法", "発送までの日数", "発送元の地域", "送料", "価格", "商品名", "商品説明", "商品の説明"];

  // フォームの値ボックスに表示されている値。未選択なら null。
  function fieldValue(labelText) {
    const sec = fieldSection(labelText);
    if (sec && sec.value) return sec.value;
    if (sec) return null;
    // セクションが特定できない場合の緩い読み取り:
    // プレースホルダのボックスがあれば未選択、無ければラベル直後の短い表示を値とみなす。
    if (valueBoxAfterLabel(labelText)) return null;
    const all = Array.from(
      document.querySelectorAll("div, span, button, a, label, p, h2, h3")
    );
    let start = -1;
    for (let i = 0; i < all.length; i++) {
      if (norm(all[i].textContent) === labelText) {
        start = i;
        break;
      }
    }
    if (start < 0) return null;
    const limit = Math.min(all.length, start + 60);
    for (let i = start + 1; i < limit; i++) {
      const el = all[i];
      if (!FF.isVisible(el) || inPicker(el)) continue;
      const t = norm(el.textContent);
      if (!t || t === labelText || t === "必須") continue;
      if (OTHER_LABELS.some((l) => l !== labelText && t === l)) return null;
      if (t.length <= 60) return t;
    }
    return null;
  }

  function fieldValueIncludes(labelText, needle) {
    const v = fieldValue(labelText);
    return !!(v && v.includes(norm(needle)));
  }

  // ピッカー（モーダル）内の要素かどうか。ピッカーは PC / SP の2変種が
  // 閉じた状態でも DOM に常駐するため、フォーム行の読み取りから除外する。
  function inPicker(el) {
    try {
      return !!(
        el.closest &&
        el.closest('#sell-category-pc, #sell-category-sp, [class*="sc-e18220f2-"]')
      );
    } catch (e) {
      return false;
    }
  }

  // フォーム行に値が表示されているかの堅牢な判定（v0.7.11）。
  // 旧 fieldValue は選択後のボックス構造（2行表示＋×ボタン）を取りこぼし、
  // 実際は選択できているのに「自動選択できませんでした」になる誤判定があった。
  // こちらは「ラベルの直後の範囲（ピッカー内を除く）で、プレースホルダより
  // 先に needle が現れる」ことを成功条件にする。
  function formRowShows(labelText, needle) {
    const target = norm(needle);
    if (!target) return false;
    if (fieldValueIncludes(labelText, target)) return true;
    const all = Array.from(
      document.querySelectorAll("div, span, button, a, label, p, h2, h3")
    );
    let start = -1;
    for (let i = 0; i < all.length; i++) {
      if (norm(all[i].textContent) === labelText && !inPicker(all[i])) {
        start = i;
        break;
      }
    }
    if (start < 0) return false;
    const limit = Math.min(all.length, start + 80);
    for (let i = start + 1; i < limit; i++) {
      const el = all[i];
      if (!FF.isVisible(el) || inPicker(el)) continue;
      const t = norm(el.textContent);
      if (!t || t === labelText || t === "必須") continue;
      if (OTHER_LABELS.some((l) => l !== labelText && t === l)) break;
      if (t.startsWith(PLACEHOLDER)) return false; // この行はまだ未選択
      if (t.includes(target) && t.length <= 120) return true;
    }
    return false;
  }

  // ピッカーは PC / SP の2変種が閉じた状態（画面外へ transform）で常時 DOM に
  // ある（実物ソースで確認）。isVisible では画面外も「見える」扱いになるため、
  // 実際に画面内にあるかを別途判定する。
  function onScreen(el) {
    try {
      const r = el.getBoundingClientRect();
      return (
        r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth
      );
    } catch (e) {
      return false;
    }
  }

  // カテゴリ名は span[data-category-id]、状態名は <p> に入っている（実物ソースで確認）。
  // クリックは一番深い要素そのものに行う（イベントは上位へバブリングするので、
  // ハンドラがどの階層にあっても届く。逆に外側ラッパーを押すと内側のハンドラに届かない）。
  const OPTION_SELECTOR =
    'span[data-category-id], a, button, li, [role="button"], [role="option"], div, span, p';

  // ピッカー内の選択肢（完全一致・最深要素）を探す。フォーム行自身は除外する。
  // root が渡された場合はその範囲内だけを探す（カテゴリの階層辿り用）。
  function findOption(text, excludeRow, screenOnly, root) {
    const target = norm(text);
    let best = null;
    for (const el of (root || document).querySelectorAll(OPTION_SELECTOR)) {
      if (!FF.isVisible(el)) continue;
      if (excludeRow && excludeRow.contains(el)) continue;
      if (norm(el.textContent) !== target) continue;
      if (screenOnly && !onScreen(el)) continue;
      if (!best || best.contains(el)) best = el;
    }
    return best;
  }

  // 残りのパス文字列の「前方一致」になる選択肢を探す（最長一致・最深を優先）。
  // コピー元のカテゴリパスが区切りなしで連結されている場合
  // （例「スマホ、タブレット、パソコンその他」）でも階層を辿れるようにするため。
  function findOptionPrefix(rest, excludeRow, screenOnly, root) {
    if (!rest) return null;
    let best = null;
    let bestTextLen = -1;
    for (const el of (root || document).querySelectorAll(OPTION_SELECTOR)) {
      if (!FF.isVisible(el)) continue;
      if (excludeRow && excludeRow.contains(el)) continue;
      const t = norm(el.textContent);
      if (!t || t.length > rest.length) continue;
      if (!rest.startsWith(t)) continue;
      if (screenOnly && !onScreen(el)) continue;
      if (t.length > bestTextLen || (t.length === bestTextLen && best && best.contains(el))) {
        bestTextLen = t.length;
        best = el;
      }
    }
    return best;
  }

  // 開いたまま失敗したピッカーを閉じる。
  // 閉じるボタンはテキストなしの画像ボタン（img[alt="閉じるボタン"]、実物ソースで確認）。
  function closePaypayPicker() {
    try {
      const imgs = Array.from(document.querySelectorAll('img[alt="閉じるボタン"]'));
      for (const img of imgs) {
        if (!onScreen(img)) continue;
        const btn = img.closest("button") || img;
        FF.clickLikeUser(btn);
        return;
      }
      const btns = Array.from(
        document.querySelectorAll('button, [role="button"], a')
      ).filter(FF.isVisible);
      const close =
        btns.find((el) => {
          const t = norm(el.textContent);
          const al = (el.getAttribute && el.getAttribute("aria-label")) || "";
          return t === "×" || t === "✕" || al === "閉じる";
        }) || null;
      if (close) {
        FF.clickLikeUser(close);
        return;
      }
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })
      );
    } catch (e) {
      /* 閉じられなくても致命的ではない（ユーザーが手で閉じられる） */
    }
  }

  async function pickPaypayCondition(conditionText) {
    const target = norm(conditionText);
    if (!target) return false;
    if (fieldValueIncludes("商品の状態", target)) return true;
    const fr = fieldRow("商品の状態");
    console.log("[FurimaCopy] paypay condition: value box found:", !!fr, "target:", target);
    if (!fr) return false;
    FF.clickLikeUser(fr.valueBox);
    let opt = await FF.waitFor(
      () => findOption(target, fr.row, true),
      4000,
      250
    );
    if (!opt) opt = findOption(target, fr.row, false);
    if (!opt) {
      closePaypayPicker();
      return false;
    }
    FF.clickLikeUser(opt);
    const ok = await FF.waitFor(
      () =>
        fieldValueIncludes("商品の状態", target) ||
        formRowShows("商品の状態", target),
      4000,
      200
    );
    if (!ok) closePaypayPicker();
    return !!ok;
  }

  async function pickPaypayCategory(categoryText) {
    const segments = String(categoryText)
      .split(/[>＞›»]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!segments.length) return false;
    const leaf = segments[segments.length - 1];
    if (fieldValueIncludes("カテゴリ", leaf) || formRowShows("カテゴリ", leaf))
      return true;
    const fr = fieldRow("カテゴリ");
    console.log("[FurimaCopy] paypay category: value box found:", !!fr, "segments:", segments);
    if (!fr) return false;
    FF.clickLikeUser(fr.valueBox);

    // v0.8.7: ピッカーが実際に開いたことを確認してから辿り、クリック対象は
    // 開いているピッカーの中だけに限定する。旧実装はページ全体から選択肢を
    // 探していたため、ピッカーが開いていない/ずれた状態でフォーム側の無関係な
    // 要素を押してしまう余地があった（タイトル欄に葉カテゴリ名が混入した疑い）。
    const openPicker = () => {
      for (const c of document.querySelectorAll("#sell-category-pc, #sell-category-sp")) {
        if (onScreen(c)) return c;
      }
      return null;
    };
    const picker = await FF.waitFor(openPicker, 3000, 250);
    if (!picker) {
      console.log("[FurimaCopy] paypay category: picker did not open");
      return false;
    }

    // 区切りありパスはセグメント完全一致で、区切りなし（連結）パスは
    // 前方一致で消費しながら辿る。どちらでも進めるよう両対応にする。
    const queue = segments.slice();
    let rest = norm(categoryText)
      .replace(/[>＞›»]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    // 前方一致用には区切りを除いた連結形も用意する。
    let restJoined = norm(categoryText).replace(/[>＞›»\s]+/g, "");
    // v0.8.6: 完了判定は「フォーム行に葉が表示されていること」だけにする。
    // 旧実装は中間階層をクリックした直後にその階層名で formRowShows を確認して
    // 早期 return していたため、ピッカー内の表示が判定に漏れると 1 階層目で
    // 「選択完了」と誤判定し、フォーム未選択のまま ✅ を出した（4階層の商品で実測）。
    // ここでは成功判定を一切せず、キューを消費し切るまで階層を辿る。
    for (let step = 0; step < 8; step++) {
      if (!queue.length && !restJoined) break;
      const pk = openPicker();
      if (!pk) break; // ピッカーが閉じた（末端選択で自動クローズ等）→ 最終検証へ
      const want = queue.length ? queue[0] : null;
      let opt = await FF.waitFor(() => {
        if (want) {
          const exact = findOption(want, fr.row, true, pk);
          if (exact) return exact;
        }
        return (
          findOptionPrefix(restJoined, fr.row, true, pk) ||
          findOptionPrefix(rest, fr.row, true, pk)
        );
      }, 3500, 250);
      if (!opt) {
        opt =
          (want && findOption(want, fr.row, false, pk)) ||
          findOptionPrefix(restJoined, fr.row, false, pk) ||
          findOptionPrefix(rest, fr.row, false, pk);
      }
      if (!opt) break;
      const optText = norm(opt.textContent);
      console.log("[FurimaCopy] paypay category: clicking option:", optText);
      FF.clickLikeUser(opt);
      if (want && optText === norm(want)) queue.shift();
      const joined = optText.replace(/\s+/g, "");
      if (restJoined.startsWith(joined)) {
        restJoined = restJoined.slice(joined.length);
      }
      if (rest.startsWith(optText)) {
        rest = rest.slice(optText.length).replace(/^[>＞›»\s]+/, "").trim();
      }
      await sleepMs(400);
    }
    // 末端まで選ばれていればピッカーは自動で閉じ、行にパスが表示される。
    // 開いたまま残っている場合は閉じてから検証し、ピッカー内の表示を
    // フォームの値と取り違えないようにする。
    closePaypayPicker();
    await sleepMs(600);
    const ok = await FF.waitFor(() => formRowShows("カテゴリ", leaf), 3000, 250);
    return !!ok;
  }

  // ---- 配送（v0.12.8） ---------------------------------------------------
  // フォームには配送方法（おてがる配送（日本郵便））、発送までの日数（2~3日）、
  // 発送元の地域（東京都）が既定で選択済みのため、「未選択のときだけ埋める」
  // 方式ではコピー元の値に直らない。値が入っていても必ずコピー元へ合わせ、
  // 成功判定は実際の選択状態（radio の checked / select の選択中 option）で行う。
  const tildeNorm = (s) => norm(s).replace(/[〜～]/g, "~");

  // 配送方法の選択肢は <li><label>…<input type="radio" name="YAMATO">…<h3>方法名</h3>
  // という構造（実ページのスナップショットで確認）。radio の name がそのまま
  // コピー元の deliveryMethod.id なので、第一候補は name で直接引く。
  // v0.12.8 の実装は候補要素に「画面内にあること」を要求したため、展開しても
  // 折り目より下にある選択肢を拾えず失敗した。ここでは可視性（display/rect）の
  // みで判定し、画面外は clickLikeUser の scrollIntoView に任せる。
  function paypayShippingRadio(data) {
    const id = data && data.shippingMethodId;
    if (id) {
      const byId = document.querySelector(
        'input[type="radio"][name="' + id + '"]'
      );
      if (byId) return byId;
    }
    const target = norm((data && (data.shippingMethod || data.shippingText)) || "");
    if (!target) return null;
    for (const h of document.querySelectorAll("h3, h2")) {
      if (norm(h.textContent) !== target) continue;
      const box = h.closest("label, li") || h.parentElement;
      const r = box && box.querySelector('input[type="radio"]');
      if (r) return r;
    }
    return null;
  }

  async function pickPaypayShippingMethod(data) {
    const radio0 = paypayShippingRadio(data);
    if (!radio0) return false;
    if (radio0.checked) return true;
    const boxOf = (r) => r && (r.closest("label") || r.closest("li") || r.parentElement);
    const verified = (ms) =>
      FF.waitFor(
        () => {
          const r = paypayShippingRadio(data);
          return !!(r && r.checked);
        },
        ms || 2000,
        200
      );
    // v0.12.10: 合成イベント（dispatchEvent）ではこのフォームの radio が
    // 反応しないことが実測で判明した（展開はするが checked にならない。
    // 本物のクリックでは即座に切り替わる）。要素のネイティブ click() は
    // ブラウザの activation behavior を通るため、まずそれを使う。
    const nativeClick = (el) => {
      if (!el) return;
      try {
        el.click();
      } catch (e) {
        /* 次の手段へ */
      }
    };
    // 1) radio 自体のネイティブ click（閉じた状態でも効くことがある）。
    nativeClick(radio0);
    if (await verified()) return true;
    // 2) 選択肢が見えていなければ行を押して展開し、label のネイティブ click。
    let radio = paypayShippingRadio(data) || radio0;
    if (!FF.isVisible(boxOf(radio) || radio)) {
      const sec = fieldSection("配送方法");
      if (sec) {
        const inner = Array.from(
          sec.section.querySelectorAll("div, span, p, button, a")
        )
          .filter(FF.isVisible)
          .filter((el) => norm(el.textContent).includes("おてがる配送"))
          .sort((a, b) => a.textContent.length - b.textContent.length)[0];
        FF.clickLikeUser(inner || sec.section);
        await FF.waitFor(
          () => {
            const r = paypayShippingRadio(data);
            return r && FF.isVisible(boxOf(r) || r) ? r : null;
          },
          3000,
          250
        );
        radio = paypayShippingRadio(data) || radio;
        if (radio.checked) return true;
      }
    }
    nativeClick(boxOf(radio));
    if (await verified()) return true;
    nativeClick(paypayShippingRadio(data));
    if (await verified()) return true;
    // 3) 最後の保険として従来の合成イベント。
    FF.clickLikeUser(boxOf(paypayShippingRadio(data)) || radio);
    if (await verified(1500)) return true;
    FF.clickLikeUser(paypayShippingRadio(data) || radio);
    return !!(await verified(1500));
  }

  // 発送までの日数 / 発送元の地域（ネイティブ select）。選択後の option で検証する。
  async function pickPaypaySelect(labelText, valueText, extraCandidates) {
    if (!valueText) return false;
    const sel = FF.findSelect([], [labelText]);
    if (!sel) return false;
    const cands = [valueText].concat(extraCandidates || []);
    if (!FF.trySelectByText(sel, cands)) return false;
    const cur = sel.options[sel.selectedIndex];
    return !!(cur && tildeNorm(cur.textContent) === tildeNorm(valueText));
  }

  async function handleFill() {
    const data = await FC.load();
    if (!data) {
      FC.ui.showToast("コピー済みの商品がありません");
      return;
    }
    console.log("[FurimaCopy] paypay fill with:", data);
    const lines = [];

    // 商品名
    const titleOk = FF.fillText(
      [
        'input[name="title"]',
        'input[name="name"]',
        'input[placeholder*="商品の名前"]',
        'input[placeholder*="商品名"]',
      ],
      ["商品の名前", "商品名"],
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
        'textarea[name="description"]',
        'textarea[placeholder*="商品の説明"]',
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
      label: "価格",
      status: priceOk ? "ok" : "fail",
      note: priceOk ? "¥" + Number(data.price).toLocaleString("ja-JP") : data.price != null ? "入力欄が見つかりませんでした" : "コピー元に価格がありません",
    });

    // 画像（PayPay はモーダルを開かないとファイル入力が現れないので modalFirst）
    if (data.imageUrls && data.imageUrls.length) {
      const r = await FF.attachImages(data.imageUrls, { modalFirst: true });
      lines.push({
        label: "画像",
        status: r.attached ? "ok" : "fail",
        note: r.attached + "枚添付" + (r.failed ? " / " + r.failed + "枚失敗" : "") +
          (r.unverified ? "（反映は画面で確認してください）" : ""),
      });
    } else {
      lines.push({ label: "画像", status: "fail", note: "コピー元に画像がありません" });
    }

    // カテゴリ / 商品の状態は同プラットフォーム複写のときだけ自動選択を試みる
    // （v0.7.5 でカテゴリも実装。成功判定はフォームの表示値で行う）。
    const samePlatform = data.source === "paypay";
    if (samePlatform && data.categoryText) {
      let ok = false;
      try {
        ok = await pickPaypayCategory(data.categoryText);
      } catch (e) {
        console.warn("[FurimaCopy] category pick failed", e);
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
    if (samePlatform && data.conditionText) {
      let ok = false;
      try {
        ok = await pickPaypayCondition(data.conditionText);
      } catch (e) {
        console.warn("[FurimaCopy] condition select failed", e);
      }
      lines.push({
        label: "商品の状態",
        status: ok ? "ok" : "manual",
        note: ok
          ? data.conditionText
          : "自動選択できませんでした（候補： " + data.conditionText + "）",
      });
    } else {
      lines.push({
        label: "商品の状態",
        status: "manual",
        note: "手動" + (data.conditionText ? "（候補： " + data.conditionText + "）" : "で選択してください"),
      });
    }
    // 配送まわり: 同プラットフォーム複写ではコピー元の値に必ず合わせる
    // （フォームの既定値が入っていても上書きする。v0.12.8）。
    // 実行順は select（日数・地域）→ 配送方法の順にする: 配送方法の選択後に
    // 別の再描画が走って radio の状態が巻き戻る事故を避けるため（v0.12.10）。
    if (samePlatform) {
      const method = data.shippingMethod || data.shippingText;
      let daysOk = null;
      let fromOk = null;
      let methodOk = null;
      if (data.shipDays) {
        try {
          daysOk = await pickPaypaySelect("発送までの日数", data.shipDays, [
            data.shipDays.replace(/〜/g, "~"),
            data.shipDays.replace(/〜/g, "～"),
          ]);
        } catch (e) {
          console.warn("[FurimaCopy] ship days select failed", e);
          daysOk = false;
        }
      }
      if (data.shipFrom) {
        try {
          fromOk = await pickPaypaySelect("発送元の地域", data.shipFrom);
        } catch (e) {
          console.warn("[FurimaCopy] ship from select failed", e);
          fromOk = false;
        }
      }
      if (method) {
        try {
          methodOk = await pickPaypayShippingMethod(data);
        } catch (e) {
          console.warn("[FurimaCopy] shipping method pick failed", e);
          methodOk = false;
        }
      }
      if (method) {
        lines.push({
          label: "配送方法",
          status: methodOk ? "ok" : "manual",
          note: methodOk ? method : "自動選択できませんでした（候補： " + method + "）",
        });
      } else {
        lines.push({ label: "配送方法", status: "manual", note: "手動で選択してください" });
      }
      if (data.shipDays) {
        lines.push({
          label: "発送までの日数",
          status: daysOk ? "ok" : "manual",
          note: daysOk ? data.shipDays : "自動選択できませんでした（候補： " + data.shipDays + "）",
        });
      }
      if (data.shipFrom) {
        lines.push({
          label: "発送元の地域",
          status: fromOk ? "ok" : "manual",
          note: fromOk ? data.shipFrom : "自動選択できませんでした（候補： " + data.shipFrom + "）",
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
      note: "内容を確認してから出品してください（自動送信はしません）",
    });

    FF.showPanel("PayPayフリマ 出品フォーム入力結果", lines);
  }

  // SPA 対策（v0.7.4）: スクリプトはドメイン全体で読み込まれるため、
  // 出品ページ（/item/add）のときだけボタンを出す。
  const onSellPage = () => /^\/item\/add(?:\/|$)/.test(location.pathname);
  FF.mountFillButton(handleFill, onSellPage, "paypay");
})();
