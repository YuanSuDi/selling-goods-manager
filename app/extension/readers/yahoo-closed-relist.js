// Yahoo! オークションの「落札者なし」終了商品ページ専用の再出品 UI。
(() => {
  "use strict";

  if (window.__fcYahooClosedRelistUiInstalled) return;
  window.__fcYahooClosedRelistUiInstalled = true;

  const STATE_KEY = "yahooRelistState";
  let ui = null;
  let previewItems = null;
  let stopRequested = false;

  function isTargetPage() {
    try {
      const url = new URL(location.href);
      return (
        url.origin === "https://auctions.yahoo.co.jp" &&
        url.pathname === "/my/closed" &&
        url.searchParams.get("hasWinner") === "0"
      );
    } catch (e) {
      return false;
    }
  }

  function renderStoredState(state) {
    if (!ui || !state) return;
    const lines = [state.message || state.status || "未実行"];
    if (state.total != null) {
      lines.push("進捗: " + (state.completed || 0) + "/" + state.total);
    }
    if (state.currentId) lines.push("商品 ID: " + state.currentId);
    ui.status.textContent = lines.join("\n");
    ui.stop.hidden = state.status !== "running" || stopRequested;
  }

  async function renderLatestState() {
    const result = await chrome.storage.local.get(STATE_KEY);
    renderStoredState(result[STATE_KEY]);
  }

  async function preview() {
    if (!ui || !isTargetPage()) return;
    const currentUi = ui;
    currentUi.previewButton.disabled = true;
    currentUi.previewButton.textContent = "対象を確認中…";
    currentUi.status.textContent = "";
    currentUi.preview.textContent = "";
    currentUi.confirmRow.hidden = true;
    currentUi.start.hidden = true;
    previewItems = null;
    try {
      const result = await chrome.runtime.sendMessage({
        type: "FurimaYahooRelistPreview",
      });
      if (!isTargetPage()) return;
      if (!result || !result.ok) {
        throw new Error((result && result.error) || "対象ページを確認できませんでした");
      }
      if (!result.items || !result.items.length) {
        currentUi.status.textContent = "現在ページに再出品できる商品はありません";
        return;
      }
      previewItems = result.items;
      const lines = result.items
        .slice(0, 5)
        .map((item, index) => (index + 1) + ". " + (item.title || item.id));
      if (result.items.length > lines.length) {
        lines.push("ほか " + (result.items.length - lines.length) + " 件");
      }
      currentUi.preview.textContent =
        "現在ページの対象: " + result.items.length + " 件\n" + lines.join("\n");
      currentUi.confirmRow.hidden = false;
      currentUi.start.hidden = false;
      currentUi.start.textContent = result.items.length + " 件を自動で再出品";
      currentUi.status.textContent = "全ページの対象を確認し、チェックを入れて開始してください";
      currentUi.start.disabled = true;
    } catch (e) {
      if (ui === currentUi) {
        currentUi.status.textContent = "確認失敗: " + String((e && e.message) || e);
      }
    } finally {
      if (ui === currentUi) {
        currentUi.previewButton.disabled = false;
        currentUi.previewButton.textContent = "Yahoo!オークション 未落札商品の再出品";
      }
    }
  }

  async function start() {
    if (!ui || !previewItems || !ui.confirm.checked || !isTargetPage()) return;
    const currentUi = ui;
    stopRequested = false;
    currentUi.start.disabled = true;
    currentUi.previewButton.disabled = true;
    currentUi.status.textContent = "自動再出品を開始しています…";
    try {
      const result = await chrome.runtime.sendMessage({
        type: "FurimaYahooRelistStart",
        ids: previewItems.map((item) => item.id),
      });
      if (ui !== currentUi) return;
      if (!result || !result.ok) {
        throw new Error((result && result.error) || "再出品を開始できませんでした");
      }
      previewItems = null;
      currentUi.confirmRow.hidden = true;
      currentUi.start.hidden = true;
      await renderLatestState();
    } catch (e) {
      if (ui === currentUi) {
        currentUi.status.textContent = "開始失敗: " + String((e && e.message) || e);
        currentUi.start.disabled = false;
      }
    }
  }

  async function stop() {
    if (!ui) return;
    const currentUi = ui;
    currentUi.stop.disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({ type: "FurimaYahooRelistStop" });
      if (ui !== currentUi) return;
      if (!result || !result.ok) {
        currentUi.status.textContent =
          (result && result.error) || "停止を要求できませんでした";
        currentUi.stop.disabled = false;
      } else {
        stopRequested = true;
        currentUi.status.textContent = "現在の商品が終わった後に停止します…";
        currentUi.stop.hidden = true;
      }
    } catch (e) {
      if (ui === currentUi) {
        currentUi.status.textContent = "停止失敗: " + String((e && e.message) || e);
        currentUi.stop.disabled = false;
      }
    }
  }

  function createUi() {
    const host = document.createElement("div");
    host.id = "fc-yahoo-closed-relist-control";
    host.style.cssText =
      "position:fixed;right:20px;bottom:20px;z-index:2147483647;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        .card {
          width: min(390px, calc(100vw - 32px));
          max-height: 65vh;
          overflow: auto;
          padding: 14px;
          border: 1px solid #d6d6d6;
          border-radius: 10px;
          background: #fff;
          color: #222;
          box-shadow: 0 4px 18px rgba(0, 0, 0, .22);
          font: 13px/1.5 "Yu Gothic", "Hiragino Kaku Gothic ProN", sans-serif;
        }
        h2 { margin: 0 0 8px; font-size: 14px; }
        p { margin: 0 0 10px; color: #666; font-size: 11px; }
        button {
          min-height: 36px;
          padding: 7px 10px;
          border: 1px solid #bbb;
          border-radius: 6px;
          background: #f5f5f5;
          color: #222;
          font: inherit;
          font-weight: 700;
          cursor: pointer;
        }
        button:disabled { opacity: .55; cursor: not-allowed; }
        #previewButton, #start { width: 100%; }
        #previewButton, #start {
          border-color: #c5221f;
          background: #d93025;
          color: white;
        }
        #preview { margin-top: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
        #confirmRow { display: flex; align-items: flex-start; gap: 7px; margin: 10px 0; }
        #confirmRow[hidden], #start[hidden], #stop[hidden] { display: none; }
        #confirmRow label { font-size: 11px; line-height: 1.5; }
        #status { margin-top: 8px; color: #444; white-space: pre-wrap; overflow-wrap: anywhere; }
        #stop { margin-top: 8px; }
      </style>
      <section class="card">
        <h2>Yahoo!オークション 未落札商品の再出品</h2>
        <p>未落札商品の一覧を全ページ確認します。開始後は各商品の確認ページまで進み、自動で再出品します。</p>
        <button id="previewButton" type="button">Yahoo!オークション 未落札商品の再出品</button>
        <div id="preview"></div>
        <div id="confirmRow" hidden>
          <input id="confirm" type="checkbox">
          <label for="confirm">表示された商品を Yahoo! オークションへ自動で再出品（送信）することを確認しました</label>
        </div>
        <button id="start" type="button" hidden disabled>自動で再出品</button>
        <button id="stop" type="button" hidden>停止</button>
        <div id="status" role="status"></div>
      </section>
    `;

    ui = {
      host,
      previewButton: shadow.querySelector("#previewButton"),
      preview: shadow.querySelector("#preview"),
      confirmRow: shadow.querySelector("#confirmRow"),
      confirm: shadow.querySelector("#confirm"),
      start: shadow.querySelector("#start"),
      stop: shadow.querySelector("#stop"),
      status: shadow.querySelector("#status"),
    };
    ui.previewButton.addEventListener("click", preview);
    ui.confirm.addEventListener("change", () => {
      ui.start.disabled = !ui.confirm.checked;
    });
    ui.start.addEventListener("click", start);
    ui.stop.addEventListener("click", stop);
    document.documentElement.appendChild(host);
    renderLatestState().catch((e) => {
      if (ui && ui.host === host) {
        ui.status.textContent = "状態を取得できませんでした: " + String((e && e.message) || e);
      }
    });
  }

  function syncUi() {
    if (isTargetPage()) {
      if (!ui || !ui.host.isConnected) createUi();
    } else if (ui) {
      ui.host.remove();
      ui = null;
      previewItems = null;
    }
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[STATE_KEY]) {
      renderStoredState(changes[STATE_KEY].newValue);
    }
  });

  window.addEventListener("popstate", syncUi);
  window.addEventListener("hashchange", syncUi);
  new MutationObserver(syncUi).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  syncUi();
})();
