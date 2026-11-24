// fillers/sell-yahoo.js
// Yahoo!オークション出品ページ（https://auctions.yahoo.co.jp/jp/show/submit）に、
// ステージング中のコピーデータをフォームへ入力する。
// 従来型の長いフォーム:
//   - タイトル / 開始価格 は自動入力（希望落札価格は手動）
//   - 説明欄はリッチテキストエディタで、実体が子 iframe 内にあることがあるため、
//     トップフレームで見つからなければ各 iframe に入力を依頼する（下記 message 連携）
//   - 画像は単体 input[type=file] が複数並ぶ形式 → lib/fill.js が 1 枚ずつ配る
//   - 商品の状態はネイティブ <select> のテキスト一致を試す
//   - 配送（方法・負担・発送元・日数）は、コピー元が Yahoo! で構造化データが
//     取れている場合に自動選択を試す（v0.12.6）
//   - カテゴリは選択ページ（topsubmit）へ遷移して自動選択する（v0.12.6）:
//     フォーム側で保留データを置いて「選択する」を押し、topsubmit 側の
//     ドライバがパスを選んで確定する。主ルートは「リストから選択する」の
//     ツリー逐次選択（v0.12.28 で導入、v0.12.31 で実 DOM に合わせて改修）。
//     キーワード検索＋完全一致はフォールバック（Yahoo! の検索索引に
//     載らないカテゴリがあり、確率で失敗するため主ルートにしない）
//   - 説明文は入力後に編集欄を読み戻し、文字数で検証してから OK とする
// 送信・出品ボタンは絶対に押さない。
(() => {
  "use strict";
  const FC = window.FurimaCopy;
  const FF = window.FurimaFill;
  if (!FC || !FF) return;

  const VERSION = chrome.runtime.getManifest().version;
  console.log("[FurimaCopy] yahoo sell filler active: v" + VERSION, location.href);

  // ---- カテゴリ選択ページ（topsubmit）での自動選択ドライバ -------------------
  // 出品フォームの「選択する」を押すと topsubmit へ遷移する。フォーム側が
  // 保留データ（fcYahooCategoryPending）を置いてから遷移してくるので、ここでは
  // キーワード検索で完全一致するカテゴリパスを選んで「このカテゴリに出品」を押す。
  // 保留データが無い（手動で開いた）場合は何もしない。
  const CATEGORY_PENDING_KEY = "fcYahooCategoryPending";

  function pickerNote(msg) {
    try {
      const d = document.createElement("div");
      d.style.cssText =
        "position:fixed;top:16px;right:16px;z-index:2147483647;background:#fff;color:#222;" +
        "border:1px solid #ddd;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,0.28);" +
        "padding:12px 14px;font-size:13px;line-height:1.55;max-width:330px;";
      d.textContent = msg;
      document.body.appendChild(d);
    } catch (e) {
      /* 表示できなくても処理は止めない */
    }
  }

  async function runYahooCategoryPicker() {
    let pending = null;
    try {
      const res = await chrome.storage.local.get(CATEGORY_PENDING_KEY);
      pending = res[CATEGORY_PENDING_KEY] || null;
    } catch (e) {
      /* 読めなければ手動操作の邪魔をしない */
    }
    if (!pending || !Array.isArray(pending.segments) || !pending.segments.length) return;
    if (Date.now() - (pending.at || 0) > 10 * 60 * 1000) return; // 古い指示は無視
    const segments = pending.segments.map((s) => String(s).trim()).filter(Boolean);
    const leaf = segments[segments.length - 1];
    const savePending = async (patch) => {
      pending = Object.assign({}, pending, patch);
      try {
        await chrome.storage.local.set({ [CATEGORY_PENDING_KEY]: pending });
      } catch (e) {
        /* noop */
      }
    };
    const fail = async (msg) => {
      try {
        await chrome.storage.local.remove(CATEGORY_PENDING_KEY);
      } catch (e) {
        /* noop */
      }
      pickerNote("カテゴリの自動選択に失敗しました：" + msg + "（手動で選択してください）");
      console.warn("[FurimaCopy] yahoo category picker failed:", msg);
    };
    // 候補ラベルのパス文字列 → セグメント列。
    // 実ページの候補は「オークション > … > ケース（出品されている商品）」形式。
    const normSegs = (text) =>
      String(text || "")
        .replace(/（?出品されている商品）?/g, "")
        .split(">")
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((s) => s !== "オークション" && s !== "オークショントップ");
    const findHit = () => {
      for (const lab of Array.from(document.querySelectorAll("label"))) {
        const segs = normSegs(lab.textContent);
        if (
          segs.length === segments.length &&
          segs.every((s, i) => s === segments[i])
        ) {
          const radio =
            lab.querySelector('input[type="radio"]') ||
            (lab.htmlFor ? document.getElementById(lab.htmlFor) : null);
          if (radio) return { lab, radio };
        }
      }
      return null;
    };
    const hasResults = () =>
      Array.from(document.querySelectorAll("label")).some((lab) =>
        lab.querySelector('input[type="radio"]')
      );
    const labelsSignature = () =>
      Array.from(document.querySelectorAll("label"))
        .map((lab) => FF.normalizeText(lab.textContent || ""))
        .join("|")
        .slice(0, 400);
    // 「このカテゴリに出品」の探索（v0.12.32 で拡張）。このページは
    // タブもツリー行も全部 <a href="javascript:void(0)"> で作られており、
    // 確定ボタンも button/input ではなくリンク等の可能性がある。
    // v0.12.31 までは button/input しか探しておらず、葉まで辿れても
    // ボタンが見つからず押せなかった。文言はページ内で一意なので、
    // 可視要素全般から完全一致で探してよい。
    const findConfirmButton = () => {
      const els = Array.from(
        document.querySelectorAll(
          'a, button, input[type="submit"], input[type="button"], [role="button"], div, span'
        )
      ).filter((b) => {
        if (!FF.isVisible(b) || b.disabled) return false;
        const t = FF.normalizeText(b.textContent || b.value || "");
        return t === "このカテゴリに出品";
      });
      // 子要素（span 等）より操作要素そのものを優先する
      const direct = els.find((b) =>
        /^(A|BUTTON|INPUT)$/.test(b.tagName) || b.getAttribute("role") === "button"
      );
      return direct || els[0] || null;
    };
    const clickConfirmButton = async () => {
      const confirmBtn = await FF.waitFor(findConfirmButton, 6000, 250);
      if (!confirmBtn) return false;
      realClick(confirmBtn);
      // 押せていればボタンは消える（フォームへ戻る）。残っていたら
      // ネイティブ click でもう一度だけ試す。最終判定はフォーム側の
      // 照合に委ねる（従来どおり）。
      const gone = await FF.waitFor(
        () => (findConfirmButton() ? null : true),
        3000,
        250
      );
      if (!gone) {
        try { confirmBtn.click(); } catch (e) { /* フォーム側で検証する */ }
      }
      return true;
    };
    const selectHit = async (hit) => {
      FF.clickLikeUser(hit.lab);
      if (!hit.radio.checked) {
        try { hit.radio.click(); } catch (e) { /* 下で検証する */ }
      }
      if (!hit.radio.checked) return fail("カテゴリのラジオを選択できませんでした");
      if (!(await clickConfirmButton())) {
        return fail("確定ボタン（このカテゴリに出品）が見つかりませんでした");
      }
      // 成功時は保留データを残す。フォーム側が実際の選択と照合して消す。
    };
    // ---- 主ルート: 「リストから選択する」のツリーをパス通り辿る（v0.12.28） ----
    // 実測（2026-11-22）: 左→右に列が増える逐次展開 UI。葉を押すと
    // 「このカテゴリに出品」が出る。v0.12.31 で実 DOM に合わせて改修:
    // 行は <a>、座標付きクリック、成否は次列の出現で判定（詳細は下記）。
    // キーワード検索は Yahoo! 側の索引に載らないカテゴリがあり確率で失敗
    // するため、ツリーを主ルート、検索をフォールバックにする。
    // 行の実測（2026-11-22 夜、詰まったページの実 DOM 確認）:
    //   - 行は <a href="javascript:void(0)"> で、text は名前そのもの。
    //     「>」は CSS 等の別要素で text には入らない。「@」は text に含まれる。
    //   - 一部の行は同じ文言が 2 回繰り返された text を持つ
    //     （例「スマートフォン、携帯電話@ スマートフォン、携帯電話 @」）。
    //   - 座標なしの合成イベントでは 3 段目で止まった実績があるため、
    //     実マウス相当の座標付きイベントで押す（realClick）。
    //   - 成否判定は「次の段の列（または確定ボタン）が出たか」で行う。
    //     選択中パスの読み出し照合は使わない。同じ行の盲目的な再クリックは
    //     トグルで選択を外しかねないので、進展が無いときだけ 1 回まで。
    const cleanEntryText = (t) =>
      FF.normalizeText(t || "").replace(/[>＞@]\s*$/g, "").trim();
    const squash = (x) => String(x || "").replace(/[\s@]/g, "");
    const entryTextMatches = (raw, name) => {
      if (cleanEntryText(raw) === name) return true;
      const sq = squash(raw);
      const sn = squash(name);
      if (!sn) return false;
      if (sq === sn) return true; // @ や空白の装飾差のみ
      return sq.length === sn.length * 2 && sq === sn + sn; // 文言の繰り返し行
    };
    // 列スコープ必須（2026-11-23 実測の事故）: 「その他」のような名前は
    // 第1列を含む複数列に同時に出る。文書全体から最初に一致した行を押すと
    // 第1列の「その他」を押してしまい、選択パスが巻き戻って失敗する
    // （iPad用アクセサリー > その他、フォグランプ > 社外品 > その他 で再現）。
    // 対象は常に「前段を押した列より右」の列にあるので、minX で絞る。
    const findTreeEntry = (name, minX) => {
      // minX は数値か、呼び出し時点の閾値を返す関数（ライブ境界）。
      // 列コンテナは段を進めると自動で横スクロールして新しい列を見せる
      // ため、数値で固定した境界はスクロール後に腐る（2026-11-23 実測:
      // フォグランプ > 社外品 の次、その他 の列が境界の外に落ちて停滞）。
      // 要素参照から毎回 getBoundingClientRect() を読み直せば追随できる。
      const threshold = typeof minX === "function" ? minX() : minX;
      const inScope = (el) => {
        if (!FF.isVisible(el) || !entryTextMatches(el.textContent, name)) return false;
        if (threshold == null) return true;
        return el.getBoundingClientRect().left >= threshold;
      };
      // 行は <a>。まずアンカーだけから探し、無ければ他の要素も見る。
      const anchors = Array.from(document.querySelectorAll("a")).filter(inScope);
      if (anchors.length) return anchors[0];
      const others = Array.from(
        document.querySelectorAll('button, li, [role="button"], [role="option"]')
      ).filter(inScope);
      return others[0] || null;
    };
    // 要素の中心座標へ実マウス相当のイベント列を送る。座標なしの合成
    // イベント（FF.clickLikeUser）は座標で対象を決めるハンドラに届かない
    // ことがあるため、ツリー行とタブはこちらを使う。実際にその座標で
    // 最前面にある要素へ送る（行内の子要素が受けてもバブリングで届く）。
    const realClick = (el) => {
      if (!el) return false;
      try {
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const target = document.elementFromPoint(x, y) || el;
        const opts = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
          button: 0,
        };
        for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
          target.dispatchEvent(new MouseEvent(t, opts));
        }
        return true;
      } catch (e) {
        return false;
      }
    };
    const drillDown = async () => {
      const tab = await FF.waitFor(() => {
        const tabs = Array.from(document.querySelectorAll('a, button, li, [role="tab"]')).filter(
          (el) => FF.isVisible(el) && FF.normalizeText(el.textContent || "") === "リストから選択する"
        );
        return tabs[0] || null;
      }, 8000, 250);
      if (!tab) return false;
      realClick(tab);
      let prevEntry = null;
      for (let i = 0; i < segments.length; i++) {
        // 境界は前段の要素参照から毎回ライブに測る（自動横スクロール追随）。
        const scopeFromPrev = () =>
          prevEntry ? prevEntry.getBoundingClientRect().left + 10 : null;
        const entry = await FF.waitFor(() => findTreeEntry(segments[i], scopeFromPrev), 9000, 300);
        if (!entry) return false;
        const isLeaf = i === segments.length - 1;
        const progressed = () =>
          isLeaf
            ? !!findConfirmButton()
            : !!findTreeEntry(segments[i + 1], () => entry.getBoundingClientRect().left + 10);
        realClick(entry);
        let ok = await FF.waitFor(() => (progressed() ? true : null), 6000, 300);
        if (!ok) {
          // 進展が無いときだけ、ネイティブ click で 1 回だけ打ち直す
          try { entry.click(); } catch (e) { /* 次の判定に委ねる */ }
          ok = await FF.waitFor(() => (progressed() ? true : null), 6000, 300);
          if (!ok) return false;
        }
        prevEntry = entry;
      }
      // 葉まで辿れたら確定ボタンが出るはず
      return clickConfirmButton();
    };
    try {
      // まず現在表示中の検索候補から探す（検索済みの再実行・遷移後の継続）。
      let hit = findHit();
      if (hit) return selectHit(hit);

      // 主ルート: ツリー逐次選択
      if (await drillDown()) return;
      // ツリーで途中まで進んだ場合に備え、状態を検索モード側へ寄せ直すため
      // キーワードタブへ戻ってからフォールバックする。
      const kwTab = Array.from(document.querySelectorAll('a, button, li, [role="tab"]')).find(
        (el) => FF.isVisible(el) && FF.normalizeText(el.textContent || "").startsWith("キーワードから選択する")
      );
      if (kwTab) FF.clickLikeUser(kwTab);

      if (!hasResults()) {
        // キーワード検索の入力欄と「検 索」ボタンを、同じ塊の中から探す。
        // ページ上部のサイト内検索と取り違えないよう、タイトルがプリフィル
        // されている欄（＝カテゴリ検索）を最優先し、次にセレクトボックスを
        // 同じ塊に持つものを選ぶ。
        const pair = await FF.waitFor(() => {
          const btns = Array.from(
            document.querySelectorAll('button, input[type="submit"], input[type="button"]')
          ).filter(
            (b) => FF.isVisible(b) && FF.normalizeText(b.textContent || b.value || "") === "検索"
          );
          const found = [];
          for (const b of btns) {
            let box = b;
            for (let i = 0; i < 6 && box; i++) {
              box = box.parentElement;
              if (!box) break;
              const input = box.querySelector('input[type="text"], input:not([type])');
              if (input && FF.isVisible(input)) {
                found.push({ input, btn: b, box });
                break;
              }
            }
          }
          if (!found.length) return null;
          const prefilled = found.find((f) => (f.input.value || "").trim().length > 0);
          if (prefilled) return prefilled;
          const withSelect = found.find((f) => f.box.querySelector("select"));
          return withSelect || found[0];
        }, 8000, 250);
        if (!pair) return fail("カテゴリ検索欄が見つかりませんでした");
        // 大分類セレクトは触らない（v0.12.27 の絞り込みは、索引に無い
        // カテゴリを結果から消してしまう副作用が実測で判明したため廃止）。
        if ((pair.input.value || "").trim() !== leaf) {
          FF.setNativeValue(pair.input, leaf);
          pair.input.dispatchEvent(new Event("change", { bubbles: true }));
        }
        await savePending({ searched: true });
        FF.clickLikeUser(pair.btn);
        // 結果の出現を待つ。検索がページ遷移なら本実行はここで終わり、
        // 遷移先で再実行されたドライバが表示中の候補から続きを拾う。
        const ready = await FF.waitFor(() => (hasResults() ? true : null), 12000, 300);
        if (!ready) {
          if (pending.searched) {
            return fail("候補に一致するカテゴリがありませんでした（" + (pending.path || leaf) + "）");
          }
          return; // 遷移中とみなし、次回実行に委ねる
        }
        hit = findHit();
        if (hit) return selectHit(hit);
      }

      // 表示中の候補に無ければ「次の10件」でページを送りながら探す（最大10回）。
      for (let i = 0; i < 10; i++) {
        if ((pending.paged || 0) >= 10) break;
        const next = Array.from(document.querySelectorAll("a, button")).find(
          (a) => FF.isVisible(a) && FF.normalizeText(a.textContent || "") === "次の10件"
        );
        if (!next) break;
        const beforeSig = labelsSignature();
        await savePending({ paged: (pending.paged || 0) + 1 });
        FF.clickLikeUser(next);
        // AJAX 差し替えならラベル集合が変わる。ページ遷移なら再実行側が拾う。
        const changed = await FF.waitFor(
          () => (labelsSignature() !== beforeSig ? true : null),
          6000,
          300
        );
        if (!changed) break;
        hit = findHit();
        if (hit) return selectHit(hit);
      }
      return fail("候補に一致するカテゴリがありませんでした（" + (pending.path || leaf) + "）");
    } catch (e) {
      await fail(String((e && e.message) || e));
    }
  }

  if (/topsubmit/.test(location.pathname)) {
    runYahooCategoryPicker();
    return;
  }

  // ---- 説明文の入力 ---------------------------------------------------------------
  // Yahoo! の説明欄は RTE（リッチテキストエディタ）で、構造は実測で判明している:
  //   編集実体: #descriptionArea 内の iframe（id="rteEditorComposition*", about:blank）の body
  //   送信先:   hidden input 群（Description / Description_rte / Description_rte_work /
  //             Description_plain）。送信時にエディタ body から再同期される想定だが、
  //             保険として隠しフィールドにも同じ内容を入れておく。
  // 戻り値は入力経路のコード（false = 失敗）。パネルの注記に使う。
  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function syncHiddenDescription(html, plain) {
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.value = v == null ? "" : v;
    };
    set("Description_rte", html);
    set("Description_rte_work", html);
    set("Description", html);
    set("Description_plain", plain);
  }

  // html が渡された場合（Yahoo!→Yahoo! で書式ごとコピーできる場合）はそれをそのまま
  // 編集領域へ入れ、隠しフィールドの plain 側にはプレーンテキスト版を同期する。
  function fillDescriptionInEditorIframe(value, html) {
    if (window !== window.top) return false;
    const frames = Array.from(document.querySelectorAll("iframe"));
    const inDescArea = frames.filter((f) => f.closest("#descriptionArea"));
    const rteLike = frames.filter((f) => /rte|editor/i.test(f.id || ""));
    const targets = inDescArea.length ? inDescArea : rteLike;
    for (const f of targets) {
      let doc = null;
      try {
        doc = f.contentDocument;
      } catch (e) {
        doc = null; // クロスオリジンで触れないフレームは対象外
      }
      if (!doc || !doc.body) continue;
      try {
        const bodyHtml = html || escapeHtml(value).replace(/\n/g, "<br>");
        doc.body.innerHTML = bodyHtml;
        doc.body.dispatchEvent(new Event("input", { bubbles: true }));
        doc.body.dispatchEvent(new Event("keyup", { bubbles: true }));
        doc.dispatchEvent(new Event("input", { bubbles: true }));
        syncHiddenDescription(bodyHtml, value);
        console.log(
          "[FurimaCopy] description -> editor iframe body",
          f.id || "(no id)",
          html ? "(html)" : "(text)"
        );
        return true;
      } catch (e) {
        console.warn("[FurimaCopy] editor iframe write failed", e);
      }
    }
    return false;
  }

  // このフレーム内で説明文の入力を試す。汎用 fillText のラベル探索は
  // 別セクションの入力欄（製品検索など）を誤爆した実績があるため使わない。
  function fillDescriptionLocal(value, html) {
    if (!value && !html) return false;
    // 0) RTE の iframe 本体（Yahoo! の実構造）。HTML はこの経路でのみ使う。
    if (fillDescriptionInEditorIframe(value, html)) return html ? "editor-iframe-html" : "editor-iframe";
    // 1) 見えている textarea（name / id が説明系のものだけ）
    if (
      FF.fillText(
        [
          'textarea[name*="description" i]',
          'textarea[name*="detail" i]',
          'textarea[id*="description" i]',
          'textarea[id*="detail" i]',
        ],
        null,
        value
      )
    ) {
      return "textarea";
    }
    // 2) contenteditable の編集欄
    if (FF.fillContentEditable(["商品の説明", "説明"], value)) return "editable";
    // 3) エディタ iframe の body 自体が編集領域の場合
    try {
      if (document.body && document.body.isContentEditable) {
        document.body.focus();
        document.body.innerText = value;
        document.body.dispatchEvent(new InputEvent("input", { bubbles: true }));
        console.log("[FurimaCopy] description -> editable body", location.href);
        return "body";
      }
    } catch (e) {
      /* 次の手段へ */
    }
    // 4) 子フレーム内に textarea が 1 つだけならそれが編集欄とみなす
    if (window !== window.top) {
      const tas = Array.from(document.querySelectorAll("textarea")).filter((t) => FF.isVisible(t));
      if (tas.length === 1) {
        FF.setNativeValue(tas[0], value);
        console.log("[FurimaCopy] description -> sole textarea in frame", location.href);
        return "frame-textarea";
      }
    }
    // 5) 隠れている backing textarea（画面には出ないため、経路を呼び出し側へ返す）
    const ta = document.querySelector(
      'textarea[name*="description" i], textarea[name*="detail" i], textarea[id*="description" i], textarea[id*="detail" i]'
    );
    if (ta) {
      FF.setNativeValue(ta, value);
      console.log("[FurimaCopy] description -> hidden textarea", ta);
      return "hidden";
    }
    return false;
  }

  // 子フレーム（エディタ等）からの入力依頼を受ける。
  window.addEventListener("message", (ev) => {
    if (!ev.data || ev.data.type !== "FC_FILL_DESC" || (!ev.data.value && !ev.data.html)) return;
    const code = fillDescriptionLocal(ev.data.value, ev.data.html);
    console.log("[FurimaCopy] frame description fill:", location.href, code);
    if (code) {
      try {
        window.parent.postMessage({ type: "FC_DESC_RESULT", ok: true }, "*");
      } catch (e) {
        /* 親へ通知できなくても入力自体は済んでいる */
      }
    }
  });

  // トップフレームから子フレームへ説明文の入力を依頼し、成否を待つ。
  function requestFrameFillDescription(value, html) {
    return new Promise((resolve) => {
      const frames = Array.from(document.querySelectorAll("iframe"));
      if (!frames.length) return resolve(false);
      let settled = false;
      const onMsg = (ev) => {
        if (ev.data && ev.data.type === "FC_DESC_RESULT" && ev.data.ok) {
          settled = true;
          window.removeEventListener("message", onMsg);
          resolve(true);
        }
      };
      window.addEventListener("message", onMsg);
      frames.forEach((f) => {
        try {
          if (f.contentWindow)
            f.contentWindow.postMessage({ type: "FC_FILL_DESC", value, html }, "*");
        } catch (e) {
          /* 到達できないフレームは無視 */
        }
      });
      setTimeout(() => {
        window.removeEventListener("message", onMsg);
        resolve(settled);
      }, 1000);
    });
  }

  // フォームの実態調査: このドキュメント内の全フィールドと iframe 一覧を出す。
  function logFormCensus() {
    try {
      const fields = Array.from(document.querySelectorAll("input, textarea, select")).map((el) => ({
        tag: el.tagName,
        type: el.getAttribute("type") || "",
        name: el.getAttribute("name") || "",
        id: el.id || "",
        ph: el.getAttribute("placeholder") || "",
        visible: !!(el.offsetWidth || el.offsetHeight),
      }));
      console.log("[FurimaCopy] yahoo form census:", {
        url: location.href,
        inFrame: window !== window.top,
        fieldCount: fields.length,
        fields: fields.slice(0, 40),
        iframes: Array.from(document.querySelectorAll("iframe")).map((f) => f.src || "(no src)"),
      });
    } catch (e) {
      console.warn("[FurimaCopy] census failed", e);
    }
  }

  // 配送方法を名称で選ぶ。
  // 実フォームの実測（2026-11-22 夜）: おてがる配送のカードには <label> が
  // 無く radio とテキストが同居するだけ。ゆうパケット と ゆうパケット
  // ポスト は「1 カード = 1 radio」の合体カード（名義は先頭の
  // ゆうパケット）。ゆうパケットポストmini は別カード（誤選択防止に
  // 照合は 完全一致 → 合体カード → 前方一致 の順）。
  // v0.12.33 で radio 自身の native click を本命にしたが実機で未選択
  // だったため、v0.12.34（ローカル検証版）では複数手段を順に試し、
  // 各手段の成否と radio の属性を診断文字列として返す。
  async function selectShipMethod(method) {
    const norm = (s) =>
      String(s || "").replace(/[\s　]/g, "").replace(/（EAZY）|\(EAZY\)/gi, "");
    // 「おてがる配送ゆうパケット」のような接頭辞付きで渡ってきても
    // カード名（接頭辞なし）に一致させる（読み取り側でも正規化するが二重化）。
    const target = norm(method).replace(/^おてがる配送/, "");
    const diag = { radios: -1, dummy: -1, tier: "-", strat: [], radio: "-" };
    const done = (ok) => {
      const d =
        "radios=" + diag.radios + " dummy=" + diag.dummy +
        " tier=" + diag.tier + " radio=" + diag.radio +
        " strat=[" + diag.strat.join(" ") + "]";
      console.log("[FurimaCopy] selectShipMethod diag:", d, "ok:", ok);
      try {
        chrome.storage.local.set({
          fcLastShipDiag: { at: new Date().toISOString(), method, ok, diag: d },
        });
      } catch (e) { /* 診断の保存失敗は本処理に影響させない */ }
      return { ok, diag: d };
    };
    if (!target) return done(false);
    const namePartOf = (el) =>
      norm(
        ((el.innerText || el.textContent || "").replace(/\s+/g, " ").trim()).split(
          /全国一律|円/
        )[0]
      );
    const fullTextOf = (el) =>
      norm((el.innerText || el.textContent || "").replace(/\s+/g, " "));
    const singleRadioRow = (el) => {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (!n.querySelectorAll) continue;
        const rs = n.querySelectorAll('input[type="radio"]');
        if (rs.length === 1) return { row: n, radio: rs[0] };
        if (rs.length > 1) return null;
      }
      return null;
    };
    const coordClick = (el) => {
      try {
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const t = document.elementFromPoint(x, y) || el;
        const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
          t.dispatchEvent(new MouseEvent(type, opts));
        }
      } catch (e) { /* 次の手段へ */ }
    };
    const collectCandidates = () => {
      const els = Array.from(document.querySelectorAll("label, div, span, td, li, a, p"))
        .filter((el) => {
          if (!FF.isVisible(el)) return false;
          const t = (el.innerText || "").replace(/\s+/g, " ").trim();
          return t && t.length <= 90;
        })
        .sort((a, b) => (a.innerText || "").length - (b.innerText || "").length);
      const exact = els.filter((el) => namePartOf(el) === target);
      if (exact.length) { diag.tier = "exact/" + exact.length; return exact; }
      const combined = els.filter(
        (el) =>
          namePartOf(el) &&
          target.startsWith(namePartOf(el)) &&
          namePartOf(el).length < target.length &&
          fullTextOf(el).includes(target)
      );
      if (combined.length) { diag.tier = "combined/" + combined.length; return combined; }
      const prefix = els.filter((el) => namePartOf(el).startsWith(target));
      const distinct = new Set(prefix.map((el) => namePartOf(el)));
      if (distinct.size === 1) { diag.tier = "prefix/" + prefix.length; return prefix; }
      diag.tier = "none";
      return [];
    };
    // 本命ルート（実 DOM 2026-11-23、ユーザーが DevTools で提示）:
    // おてがる配送のカードは <label class="OfficialDelivery__item
    // js-ship-label"> で、中に name="shipmethod_dummy" の radio と
    // .OfficialDelivery__itemTitle > p の方法名が入る。合体カードは
    // 1 つの label の中に itemWrap が 2 つ（タイトル 2 つ）並ぶ。
    // 人が押すのは label そのものなので、タイトルが対象名と一致する
    // label を native click する（label の活性化で radio が切り替わり、
    // Yahoo! 側の js-ship-label ハンドラにも届く）。
    const labelRoute = async () => {
      const rsAll = document.querySelectorAll('input[type="radio"]');
      diag.radios = rsAll.length;
      diag.dummy = Array.from(rsAll).filter((r) => r.name === "shipmethod_dummy").length;
      const labels = Array.from(
        document.querySelectorAll("label.js-ship-label, label.OfficialDelivery__item")
      ).filter((el) => FF.isVisible(el));
      for (const label of labels) {
        const titles = Array.from(
          label.querySelectorAll(".OfficialDelivery__itemTitle")
        ).map((el) => norm(el.textContent || ""));
        if (!titles.length) continue;
        if (!titles.includes(target) && titles[0] !== target) continue;
        const radio = label.querySelector('input[type="radio"]');
        if (!radio) continue;
        diag.tier = "label";
        diag.radio =
          "name=" + (radio.name || "-") + " id=" + (radio.id || "-") +
          " value=" + (radio.value || "-") +
          " dis=" + (radio.disabled ? 1 : 0) +
          " vis=" + (FF.isVisible(radio) ? 1 : 0);
        const tries = [
          ["label", () => { try { label.click(); } catch (e) { /* noop */ } }],
          ["native", () => { try { radio.click(); } catch (e) { /* noop */ } }],
          ["labelcoord", () => coordClick(label)],
          ["coord", () => coordClick(radio)],
        ];
        for (const [name, act] of tries) {
          act();
          const immediate = radio.checked;
          let late = immediate;
          if (immediate) {
            await new Promise((r) => setTimeout(r, 600));
            late = radio.checked;
          }
          diag.strat.push(name + ":" + (immediate ? (late ? "OK" : "reverted") : "0"));
          if (immediate && late) return true;
          if (immediate && !late) return false;
        }
        return false;
      }
      return null; // 対象 label が無い → 汎用ルートへ
    };
    // 本命ルート2（実 DOM 2026-11-23、ユーザー提示）: 「その他の配送方法」
    // の radio は data-deliveryname に方法名そのものを持つ
    // （例 data-delivery-id="404" data-deliveryname="レターパックプラス"）。
    // 展開見出しは dt.js-expand-trigger、開状態は dl.js-expand-body の
    // is-open クラス。手順は「先に展開 → それから label を click」。
    const setRadioDiag = (radio) => {
      diag.radio =
        "name=" + (radio.name || "-") + " id=" + (radio.id || "-") +
        " value=" + (radio.value || "-") +
        " dis=" + (radio.disabled ? 1 : 0) +
        " vis=" + (FF.isVisible(radio) ? 1 : 0);
    };
    const findByDeliveryName = () =>
      Array.from(
        document.querySelectorAll('input[type="radio"][name="shipmethod_dummy"]')
      ).find((r) => norm(r.getAttribute("data-deliveryname") || "") === target) || null;
    const clickRadioHuman = async (radio) => {
      const label = radio.closest("label");
      const tries = [];
      if (label) tries.push(["label", () => { try { label.click(); } catch (e) { /* noop */ } }]);
      tries.push(["native", () => { try { radio.click(); } catch (e) { /* noop */ } }]);
      if (label) tries.push(["labelcoord", () => coordClick(label)]);
      tries.push(["coord", () => coordClick(radio)]);
      for (const [name, act] of tries) {
        act();
        const immediate = radio.checked;
        let late = immediate;
        if (immediate) {
          await new Promise((r) => setTimeout(r, 600));
          late = radio.checked;
        }
        diag.strat.push(name + ":" + (immediate ? (late ? "OK" : "reverted") : "0"));
        if (immediate && late) return true;
        if (immediate && !late) return false;
      }
      return false;
    };
    const ensureOtherExpanded = async () => {
      const isOpen = () => {
        const body = document.querySelector("dl.js-expand-body");
        if (body && body.classList.contains("is-open")) return true;
        return Array.from(
          document.querySelectorAll('input[name="shipmethod_dummy"][data-deliverytype="is_other_ship"]')
        ).some((r) => FF.isVisible(r));
      };
      if (isOpen()) return true;
      const trigger =
        document.querySelector("dt.js-expand-trigger") ||
        Array.from(
          document.querySelectorAll("a, button, div, span, dt, dd, summary, li, p, label")
        )
          .filter((el) => FF.isVisible(el))
          .find((el) => norm(el.innerText || el.textContent || "") === "その他の配送方法");
      if (!trigger) { diag.strat.push("expand:notfound"); return false; }
      coordClick(trigger);
      let ok = await FF.waitFor(() => isOpen() || null, 1500, 200);
      if (!ok) {
        try { trigger.click(); } catch (e) { /* noop */ }
        ok = await FF.waitFor(() => isOpen() || null, 3000, 200);
      }
      diag.strat.push("expand:" + (ok ? "ok" : "empty"));
      return !!ok;
    };
    let dRadio = findByDeliveryName();
    if (dRadio && !FF.isVisible(dRadio)) {
      await ensureOtherExpanded();
      dRadio = findByDeliveryName();
    }
    if (dRadio) {
      diag.tier = "dname";
      setRadioDiag(dRadio);
      if (await clickRadioHuman(dRadio)) return done(true);
    }
    const labelResult = await labelRoute();
    if (labelResult !== null) return done(labelResult);
    if (!dRadio) {
      await ensureOtherExpanded();
      const r2 = findByDeliveryName();
      if (r2) {
        diag.tier = "dname-after-expand";
        setRadioDiag(r2);
        if (await clickRadioHuman(r2)) return done(true);
      }
    }

    // 候補が描画されるまで最大 8 秒待つ（セクションの遅延描画対策）。
    let pool = await FF.waitFor(() => collectCandidates().length || null, 8000, 400)
      .then(() => collectCandidates())
      .catch(() => collectCandidates());
    if (!pool.length) {
      // 「その他の配送方法」の展開見出しは <dt>（実 DOM 2026-11-23、
      // ブラウザの読み取りで確認）。a/button/div/span だけを探す旧実装は
      // 見出し自体が見つからず、レターパックプラス等の非おてがる方法が
      // 一切選べなかった（diag: tier=none strat=[] の正体）。
      // 座標クリック → native click の順に試し、候補の出現で検証する。
      const expander = Array.from(
        document.querySelectorAll("a, button, div, span, dt, dd, summary, li, p, label")
      )
        .filter((el) => FF.isVisible(el))
        .find((el) => norm(el.innerText || el.textContent || "") === "その他の配送方法");
      if (expander) {
        coordClick(expander);
        const appeared = await FF.waitFor(
          () => collectCandidates().length || null, 1500, 250
        );
        if (!appeared) {
          try { expander.click(); } catch (e) { /* noop */ }
          await FF.waitFor(() => collectCandidates().length || null, 3000, 250);
        }
        pool = collectCandidates();
        diag.strat.push("expand:" + (pool.length ? "ok" : "empty"));
      } else {
        diag.strat.push("expand:notfound");
      }
    }
    const allRadios = Array.from(document.querySelectorAll('input[type="radio"]'));
    diag.radios = allRadios.length;
    diag.dummy = allRadios.filter((r) => r.name === "shipmethod_dummy").length;
    // 祖先辿りで掴めない場合の幾何フォールバック: radio がカードとは
    // 別コンテナに絶対配置されている UI では、祖先に radio が 0→全数と
    // 跳んで行方不明になる。その場合は「対象名を持つ要素の矩形に
    // 中心が入る radio」を幾何で対応付ける。
    const geometricRow = (el) => {
      let card = el;
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        const t = norm(n.innerText || n.textContent || "");
        if (t.length > 140) break;
        card = n;
      }
      const cr = card.getBoundingClientRect();
      if (!cr.width || !cr.height) return null;
      const hits = allRadios.filter((r) => {
        const rr = r.getBoundingClientRect();
        const cx = rr.left + rr.width / 2;
        const cy = rr.top + rr.height / 2;
        return cx >= cr.left - 4 && cx <= cr.right + 4 && cy >= cr.top - 4 && cy <= cr.bottom + 4;
      });
      return hits.length === 1 ? { row: card, radio: hits[0] } : null;
    };
    for (const el of pool.slice(0, 3)) {
      let found = singleRadioRow(el);
      if (!found) {
        found = geometricRow(el);
        if (!found) { diag.strat.push("row:null"); continue; }
        diag.strat.push("geo");
      }
      const { row, radio } = found;
      diag.radio =
        "name=" + (radio.name || "-") + " id=" + (radio.id || "-") +
        " value=" + (radio.value || "-") +
        " dis=" + (radio.disabled ? 1 : 0) +
        " vis=" + (FF.isVisible(radio) ? 1 : 0);
      const strategies = [
        ["native", () => { try { radio.click(); } catch (e) { /* noop */ } }],
        ["card", () => coordClick(row)],
        ["coord", () => coordClick(radio)],
        ["setter", () => {
          try {
            const setter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype, "checked"
            ).set;
            setter.call(radio, true);
            radio.dispatchEvent(new Event("input", { bubbles: true }));
            radio.dispatchEvent(new Event("change", { bubbles: true }));
          } catch (e) { /* noop */ }
        }],
        ["rowlike", () => FF.clickLikeUser(row)],
      ];
      for (const [name, act] of strategies) {
        act();
        const immediate = radio.checked;
        let late = immediate;
        if (immediate) {
          await new Promise((r) => setTimeout(r, 600));
          late = radio.checked;
        }
        diag.strat.push(name + ":" + (immediate ? (late ? "OK" : "reverted") : "0"));
        if (immediate && late) return done(true);
        if (immediate && !late) break; // 付いても戻されるなら次の候補でも同じ
      }
    }
    return done(false);
  }

  // 編集欄に実際に入った説明テキストを読み戻す（入力検証用）。
  function readBackDescriptionText() {
    const frames = Array.from(document.querySelectorAll("iframe"));
    const inDescArea = frames.filter((f) => f.closest("#descriptionArea"));
    const rteLike = frames.filter((f) => /rte|editor/i.test(f.id || ""));
    const targets = inDescArea.length ? inDescArea : rteLike;
    for (const f of targets) {
      try {
        const doc = f.contentDocument;
        if (doc && doc.body) {
          const t = (doc.body.innerText || doc.body.textContent || "").trim();
          if (t) return t;
        }
      } catch (e) {
        /* 触れないフレームは飛ばす */
      }
    }
    const plain = document.getElementById("Description_plain");
    if (plain && plain.value) return String(plain.value).trim();
    const flea = document.getElementById("fleaDescription");
    if (flea && flea.value) return String(flea.value).trim();
    return null;
  }

  async function handleFill() {
    logFormCensus();
    const data = await FC.load();
    if (!data) {
      FC.ui.showToast("コピー済みの商品がありません");
      return;
    }
    console.log("[FurimaCopy] yahoo fill with: v" + VERSION, data);
    const lines = [];

    // タイトル
    const titleOk = FF.fillText(
      ['input[name*="title" i]', 'input[id*="title" i]', 'input[placeholder*="タイトル"]'],
      ["タイトル", "商品名"],
      data.title
    );
    lines.push({
      label: "タイトル",
      status: titleOk ? "ok" : "fail",
      note: titleOk ? undefined : data.title ? "入力欄が見つかりませんでした" : "コピー元にタイトルがありません",
    });

    // 商品の説明: このフレームで試し、ダメなら子フレーム（エディタ）に依頼する。
    // Yahoo!→Yahoo! で説明の HTML が取れている場合は、書式ごとエディタへ入れる。
    const descHtml =
      data.source === "yahoo" && data.descriptionHtml ? data.descriptionHtml : null;
    let descText = data.description || null;
    if (!descText && descHtml) {
      const tmp = document.createElement("div");
      tmp.innerHTML = descHtml;
      descText = (tmp.textContent || "").trim() || null;
    }
    let descCode = false;
    if (descText || descHtml) {
      descCode = fillDescriptionLocal(descText, descHtml);
      if (!descCode && (await requestFrameFillDescription(descText, descHtml))) {
        descCode = descHtml ? "frame-message-html" : "frame-message";
      }
    }
    let descStatus = descCode ? "ok" : "fail";
    let descNote = !descText && !descHtml
      ? "コピー元に説明がありません"
      : !descCode
        ? "入力欄が見つかりませんでした"
        : descCode === "hidden"
          ? "（画面に表示されない欄へ入力・要確認）"
          : String(descCode).includes("html")
            ? "（書式ごとコピー）"
            : undefined;
    if (descCode && descText) {
      // 編集欄を読み戻して文字数で検証する（見た目だけの成功申告をしない）。
      await new Promise((r) => setTimeout(r, 700));
      const back = readBackDescriptionText();
      if (back) {
        if (back.length >= descText.length * 0.9) {
          descNote =
            "（全文 " + back.length + " 字を確認" +
            (String(descCode).includes("html") ? "・書式ごとコピー" : "") + "）";
        } else {
          descStatus = "fail";
          descNote =
            "編集欄の文字数が不足しています（入力 " + back.length +
            " 字 / コピー元 " + descText.length + " 字）";
        }
      } else {
        descStatus = "manual";
        descNote = "入力しましたが読み戻し確認ができませんでした（目視で確認してください）";
      }
    }
    lines.push({ label: "商品の説明", status: descStatus, note: descNote });

    // ---- 価格 -------------------------------------------------------------
    // 実 DOM（2026-11-23、ユーザー提示）: 価格エリア #js-FCNonPrePriceArea
    // の中に販売形式ラジオ name="salesmode"（#salesmode_auction = オークション、
    // もう一方がフリマ（定額））があり、形式で #price_auction / #price_buynow
    // が切り替わる。オークション側には開始価格の入力欄と「即決価格を設定する」
    // トグルの下に即決価格の入力欄（注記「この価格で商品の購入が確定し、
    // オークションが終了します」付き）。
    // 教訓: 入力欄の name 推測は外れた（開始価格のつもりが即決側に入った）。
    // 価格はラベル/注記の行から入力欄を探して直接入れる。
    const setValueDirect = (inp, v) => {
      try {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype, "value"
        ).set;
        setter.call(inp, String(v));
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
        return String(inp.value || "").replace(/[^0-9]/g, "") === String(v);
      } catch (e) {
        return false;
      }
    };
    const findInputByRowText = (needle, maxLen) => {
      const labs = Array.from(
        document.querySelectorAll("label, th, dt, div, span, p, td")
      ).filter(
        (el) =>
          FF.isVisible(el) &&
          (el.textContent || "").includes(needle) &&
          (el.textContent || "").length < (maxLen || 40)
      );
      for (const lab of labs) {
        let row = lab;
        for (let up = 0; up < 6 && row; up++) {
          const inp =
            row.querySelector &&
            row.querySelector('input[type="text"], input[type="number"], input:not([type])');
          if (inp) return inp;
          row = row.parentElement;
        }
      }
      return null;
    };
    const clickEl = (el) => {
      try {
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const t = document.elementFromPoint(x, y) || el;
        const opts = {
          bubbles: true, cancelable: true, view: window,
          clientX: x, clientY: y, button: 0,
        };
        for (const ty of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
          t.dispatchEvent(new MouseEvent(ty, opts));
        }
        return true;
      } catch (e) {
        try { el.click(); return true; } catch (e2) { return false; }
      }
    };

    if (data.buyNowPrice != null && data.price != null) {
      // 2 価格のオークション: まず販売形式で「オークション」を選ぶ
      // （選ばないと入力欄が揃わない — ユーザー指摘 2026-11-23）。
      const auctionRadio =
        document.getElementById("salesmode_auction") ||
        document.querySelector('input[name="salesmode"][value="auction"]');
      if (auctionRadio && !auctionRadio.checked) {
        const lab = auctionRadio.closest("label");
        if (lab) { try { lab.click(); } catch (e) { /* noop */ } }
        if (!auctionRadio.checked) {
          try { auctionRadio.click(); } catch (e) { /* noop */ }
        }
        await new Promise((r) => setTimeout(r, 600));
      }
      // 開始価格（行ラベルから探して直接入力、ダメなら従来の汎用入力）
      const startInp = findInputByRowText("開始価格", 30);
      let startOk = startInp ? setValueDirect(startInp, data.price) : false;
      if (!startOk) {
        startOk = FF.fillText(
          ['input[name*="startprice" i]', 'input[name*="price" i]', 'input[name*="start" i]', 'input[id*="price" i]'],
          ["開始価格"],
          String(data.price)
        );
      }
      lines.push({
        label: "開始価格",
        status: startOk ? "ok" : "fail",
        note: startOk
          ? "¥" + Number(data.price).toLocaleString("ja-JP")
          : "入力欄が見つかりませんでした",
      });
      // 即決価格: 注記の行から探す。見えなければトグルを開いてから探し直す。
      let winInp = findInputByRowText("この価格で商品の購入が確定", 60);
      if (winInp && startInp && winInp === startInp) winInp = null;
      if (!winInp || !FF.isVisible(winInp)) {
        const toggle = Array.from(
          document.querySelectorAll("a, button, div, span, p")
        ).find(
          (el) =>
            FF.isVisible(el) &&
            (el.textContent || "").includes("即決価格を設定する") &&
            (el.textContent || "").length < 30
        );
        if (toggle) {
          clickEl(toggle);
          await new Promise((r) => setTimeout(r, 700));
          winInp = findInputByRowText("この価格で商品の購入が確定", 60);
          if (winInp && startInp && winInp === startInp) winInp = null;
        }
      }
      if (!winInp) {
        const area = document.getElementById("price_auction");
        if (area) {
          winInp =
            Array.from(
              area.querySelectorAll('input[type="text"], input[type="number"], input:not([type])')
            ).filter((inp) => inp !== startInp && FF.isVisible(inp))[0] || null;
        }
      }
      const winOk = winInp ? setValueDirect(winInp, data.buyNowPrice) : false;
      lines.push({
        label: "即決価格",
        status: winOk ? "ok" : "fail",
        note: winOk
          ? "¥" + Number(data.buyNowPrice).toLocaleString("ja-JP")
          : "入力欄が見つからないか、値が反映されませんでした",
      });
    } else {
      // 単一価格（定額など）: 従来どおり開始価格欄へ入れる。
      const priceOk = FF.fillText(
        ['input[name*="startprice" i]', 'input[name*="price" i]', 'input[name*="start" i]', 'input[id*="price" i]'],
        ["開始価格"],
        data.price != null ? String(data.price) : null
      );
      lines.push({
        label: "開始価格",
        status: priceOk ? "ok" : "fail",
        note: priceOk ? "¥" + Number(data.price).toLocaleString("ja-JP") : data.price != null ? "入力欄が見つかりませんでした" : "コピー元に価格がありません",
      });
      lines.push({
        label: "即決価格",
        status: "manual",
        note: "手動で入力してください（必要な場合）",
      });
    }

    // 画像（単体ファイル入力が複数ある前提で配布される）
    if (data.imageUrls && data.imageUrls.length) {
      const r = await FF.attachImages(data.imageUrls, { incremental: true });
      lines.push({
        label: "画像",
        status: r.attached ? "ok" : "fail",
        note: r.attached + "枚添付" + (r.failed ? " / " + r.failed + "枚失敗" : ""),
      });
    } else {
      lines.push({ label: "画像", status: "fail", note: "コピー元に画像がありません" });
    }

    // 商品の状態（ネイティブ select をテキスト一致で試す）
    // 2026-11-17 実測: Yahoo! の状態はネイティブ select で、選択肢は
    // 未使用 / 未使用に近い / 目立った傷や汚れなし / やや傷や汚れあり /
    // 傷や汚れあり / 全体的に状態が悪い。最上位の呼び名だけが他プラットフォーム
    // と違う（Mercari 等の「新品、未使用」＝ Yahoo! の「未使用」）ため、
    // 候補に相互の表記を加えてクロスプラットフォーム複写でも選べるようにする。
    const condSel = FF.findSelect(
      ['select[name*="condition" i]', 'select[name*="state" i]', 'select[id*="condition" i]'],
      ["商品の状態", "状態"]
    );
    const condCandidates = [];
    if (data.conditionText) {
      condCandidates.push(data.conditionText);
      if (data.conditionText === "新品、未使用") condCandidates.push("未使用");
      if (data.conditionText === "未使用") condCandidates.push("新品、未使用");
    }
    const condOk = condSel && condCandidates.length
      ? FF.trySelectByText(condSel, condCandidates)
      : false;
    const condShown =
      condOk && condSel && condSel.selectedIndex >= 0
        ? condSel.options[condSel.selectedIndex].text
        : data.conditionText;
    lines.push({
      label: "商品の状態",
      status: condOk ? "ok" : "manual",
      note: condOk ? condShown : "手動" + (data.conditionText ? "（候補： " + data.conditionText + "）" : "で選択してください"),
    });

    // 配送まわり: コピー元が Yahoo! で構造化データが取れている場合だけ自動選択を試す。
    let shipHandled = false;
    if (
      data.source === "yahoo" &&
      (data.shippingMethod || data.shippingBurden || data.shipFrom || data.shipDays)
    ) {
      if (data.shippingMethod) {
        shipHandled = true;
        const shipRes = await selectShipMethod(data.shippingMethod);
        lines.push({
          label: "配送方法",
          status: shipRes.ok ? "ok" : "fail",
          note: shipRes.ok
            ? data.shippingMethod
            : "自動選択できませんでした（候補： " + data.shippingMethod + "） " + shipRes.diag,
        });
      }
      if (data.shippingBurden) {
        shipHandled = true;
        const radio = document.querySelector(
          'input[type="radio"][name="shipping_dummy"][value="' + data.shippingBurden + '"]'
        );
        let ok = false;
        if (radio) {
          FF.clickLikeUser(radio.closest("label") || radio);
          if (!radio.checked) {
            try { radio.click(); } catch (e) { /* 下で検証する */ }
          }
          ok = radio.checked;
        }
        lines.push({
          label: "送料負担",
          status: ok ? "ok" : "fail",
          note: data.shippingBurden === "seller" ? "出品者" : "落札者",
        });
      }
      if (data.shipFrom) {
        shipHandled = true;
        const sel = document.querySelector('select[name="loc_cd"]');
        const ok = sel ? FF.trySelectByText(sel, [data.shipFrom]) : false;
        lines.push({
          label: "発送元地域",
          status: ok ? "ok" : "fail",
          note: ok && sel.selectedIndex >= 0
            ? sel.options[sel.selectedIndex].text.trim()
            : "候補： " + data.shipFrom,
        });
      }
      if (data.shipDays) {
        shipHandled = true;
        const sel = document.querySelector('select[name="shipschedule"]');
        const ok = sel ? FF.trySelectByText(sel, [data.shipDays]) : false;
        lines.push({
          label: "発送までの日数",
          status: ok ? "ok" : "fail",
          note: ok && sel.selectedIndex >= 0
            ? sel.options[sel.selectedIndex].text.trim()
            : "候補： " + data.shipDays,
        });
      }
    }
    if (!shipHandled) {
      lines.push({
        label: "配送・送料",
        status: "manual",
        note: "手動" + (data.shippingText ? "（候補： " + data.shippingText + "）" : "で選択してください"),
      });
    }

    // カテゴリ: 選択済みで候補と一致すれば OK。未選択なら保留データを置き、
    // このページの入力を全部終えたあとで選択ページへ遷移する（最後に処理）。
    let pendingCategoryNav = null;
    const catSegments = data.categoryText
      ? data.categoryText.split(/[>＞]+/).map((s) => s.trim()).filter(Boolean)
      : [];
    const catLeaf = catSegments.length ? catSegments[catSegments.length - 1] : "";
    const catInput = document.querySelector('input[name="category"]');
    const catTextEl = document.querySelector(".Category__text");
    const catShown = catTextEl ? (catTextEl.textContent || "").trim() : "";
    if (
      data.categoryText &&
      catInput && catInput.value && catInput.value !== "0" &&
      catShown.includes(catLeaf)
    ) {
      lines.push({ label: "カテゴリ", status: "ok", note: catShown });
      try { await chrome.storage.local.remove(CATEGORY_PENDING_KEY); } catch (e) { /* noop */ }
    } else if (data.categoryText) {
      lines.push({
        label: "カテゴリ",
        status: "manual",
        note: "このあと選択ページで自動選択します（候補： " + data.categoryText + "）",
      });
      pendingCategoryNav = { segments: catSegments };
    } else {
      lines.push({ label: "カテゴリ", status: "manual", note: "手動で選択してください" });
    }

    lines.push({
      label: "送信前確認",
      status: "manual",
      note: "内容を確認してから出品してください（自動送信はしません）",
    });

    FF.showPanel("Yahoo!オークション 出品フォーム入力結果 (v" + VERSION + ")", lines);

    // カテゴリ未選択なら、保留データを置いて選択ページへ遷移する。
    if (pendingCategoryNav) {
      try {
        await chrome.storage.local.set({
          [CATEGORY_PENDING_KEY]: {
            segments: pendingCategoryNav.segments,
            path: data.categoryText,
            at: Date.now(),
          },
        });
      } catch (e) {
        /* 置けなければ遷移しない（手動選択に倒れる） */
        pendingCategoryNav = null;
      }
      if (pendingCategoryNav) {
        setTimeout(() => {
          const btn =
            document.getElementById("acMdCateChange") ||
            document.querySelector(".Category__button");
          if (btn) FF.clickLikeUser(btn);
        }, 900);
      }
    }
  }

  // ボタンはトップフレームだけに置く（子フレームでは message 連携のみ）。
  if (window === window.top) {
    FF.mountFillButton(handleFill, null, "yahoo");
    // カテゴリ選択ページから戻ってきたら、保留データと実際の選択を照合する。
    (async () => {
      for (let i = 0; i < 5; i++) {
        let pending = null;
        try {
          const res = await chrome.storage.local.get(CATEGORY_PENDING_KEY);
          pending = res[CATEGORY_PENDING_KEY] || null;
        } catch (e) {
          /* 読めなければ諦める */
        }
        if (!pending || !pending.segments || !pending.segments.length) return;
        const catInput = document.querySelector('input[name="category"]');
        const catTextEl = document.querySelector(".Category__text");
        const shown = catTextEl ? (catTextEl.textContent || "").trim() : "";
        const leaf = pending.segments[pending.segments.length - 1];
        if (catInput && catInput.value && catInput.value !== "0" && shown.includes(leaf)) {
          try { await chrome.storage.local.remove(CATEGORY_PENDING_KEY); } catch (e) { /* noop */ }
          FC.ui.showToast("カテゴリを自動選択しました：" + (pending.path || shown));
          // 結果パネルはカテゴリ選択ページへの遷移で DOM ごと消えてしまう
          // （表示されるのは遷移前の 1 秒弱だけ）。戻ってきたら、保存済みの
          // レポートのカテゴリ行を OK に差し替えてパネルを再表示する。
          try {
            const repRes = await chrome.storage.local.get("lastFillReport");
            const rep = repRes.lastFillReport;
            if (rep && Array.isArray(rep.lines)) {
              const lines = rep.lines.map((l) =>
                l.label === "カテゴリ"
                  ? { label: l.label, status: "ok", note: pending.path || shown }
                  : l
              );
              FF.showPanel(
                rep.title || "Yahoo!オークション 出品フォーム入力結果",
                lines
              );
            }
          } catch (e) { /* noop */ }
          return;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    })();
  }
})();
