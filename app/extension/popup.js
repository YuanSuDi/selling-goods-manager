// popup.js
// ポップアップ: 現在ステージング中のコピーデータを表示する。
// lib/store.js の FurimaCopy.load() / clear() を使う。
(() => {
  "use strict";

  const SOURCE_LABELS = {
    mercari: "メルカリ",
    rakuma: "ラクマ",
    paypay: "PayPayフリマ",
    yahoo: "Yahoo!オークション",
  };

  async function render() {
    const emptyEl = document.getElementById("empty");
    const itemEl = document.getElementById("item");
    const data = await window.FurimaCopy.load();

    if (!data) {
      emptyEl.hidden = false;
      itemEl.hidden = true;
      return;
    }

    emptyEl.hidden = true;
    itemEl.hidden = false;

    document.getElementById("source").textContent =
      SOURCE_LABELS[data.source] || data.source || "不明";
    document.getElementById("title").textContent = data.title || "（タイトル不明）";
    document.getElementById("price").textContent =
      data.price != null ? "¥" + Number(data.price).toLocaleString("ja-JP") : "価格不明";

    const thumb = document.getElementById("thumb");
    thumb.referrerPolicy = "no-referrer";
    if (data.imageUrls && data.imageUrls.length) {
      thumb.src = data.imageUrls[0];
      thumb.hidden = false;
      // 取り込み済みの画像データがあればそちらを優先表示する
      // （拡張ページから CDN の URL は防盗链で読めないため、v0.6.1）。
      try {
        const stored = await chrome.storage.local.get("copyImages");
        const imgs = stored.copyImages;
        const first =
          imgs && Array.isArray(imgs.items)
            ? imgs.items.find((x) => x && x.base64)
            : null;
        if (first) {
          thumb.src =
            "data:" + (first.mime || "image/jpeg") + ";base64," + first.base64;
        }
      } catch (e) {
        /* URL のまま表示を試みる */
      }
    } else {
      thumb.hidden = true;
    }

    const imageCount = data.imageUrls ? data.imageUrls.length : 0;
    const when = data.copiedAt ? new Date(data.copiedAt).toLocaleString("ja-JP") : "";
    document.getElementById("meta").textContent =
      "画像 " + imageCount + " 枚" + (when ? " ・ コピー日時: " + when : "");
  }

  document.getElementById("clear").addEventListener("click", async () => {
    await window.FurimaCopy.clear();
    render();
  });

  // ---- 出品管理プログラム連携（v0.9.0） -----------------------------------
  const mgrEls = {
    enabled: document.getElementById("mgrEnabled"),
    baseUrl: document.getElementById("mgrBaseUrl"),
    token: document.getElementById("mgrToken"),
    status: document.getElementById("mgrStatus"),
    todoScanEnabled: document.getElementById("todoScanEnabled"),
    todoScanInterval: document.getElementById("todoScanInterval"),
    todoScanUnit: document.getElementById("todoScanUnit"),
    yahooScanEnabled: document.getElementById("yahooScanEnabled"),
    yahooScanInterval: document.getElementById("yahooScanInterval"),
    yahooScanUnit: document.getElementById("yahooScanUnit"),
    yahooStatus: document.getElementById("yahooScanStatus"),
  };

  async function renderManager() {
    const res = await chrome.storage.local.get("managerConfig");
    const cfg = res.managerConfig || {};
    mgrEls.enabled.checked = !!cfg.enabled;
    if (document.activeElement !== mgrEls.baseUrl) {
      mgrEls.baseUrl.value = cfg.baseUrl || "http://127.0.0.1:17341";
    }
    if (document.activeElement !== mgrEls.token) {
      mgrEls.token.value = cfg.token || "";
    }
    mgrEls.todoScanEnabled.checked = !!cfg.todoScanEnabled;
    if (document.activeElement !== mgrEls.todoScanInterval) {
      mgrEls.todoScanInterval.value = cfg.todoScanInterval || 5;
    }
    if (document.activeElement !== mgrEls.todoScanUnit) {
      mgrEls.todoScanUnit.value = cfg.todoScanUnit || "minutes";
    }
    mgrEls.todoScanInterval.max = mgrEls.todoScanUnit.value === "hours" ? 24 : 1440;
    mgrEls.yahooScanEnabled.checked = !!cfg.yahooScanEnabled;
    if (document.activeElement !== mgrEls.yahooScanInterval) {
      mgrEls.yahooScanInterval.value = cfg.yahooScanInterval || 5;
    }
    if (document.activeElement !== mgrEls.yahooScanUnit) {
      mgrEls.yahooScanUnit.value = cfg.yahooScanUnit || "minutes";
    }
    mgrEls.yahooScanInterval.max = mgrEls.yahooScanUnit.value === "hours" ? 24 : 1440;
    const yahooLines = [];
    yahooLines.push(
      "雅虎定时扫描: " +
        (cfg.yahooScanEnabled
          ? "已开启（每 " + (cfg.yahooScanInterval || 5) +
            (cfg.yahooScanUnit === "hours" ? " 小时）" : " 分钟）")
          : "已关闭")
    );
    yahooLines.push("雅虎卖出监测: " + (cfg.lastYahooScanStatus || "未扫描"));
    if (cfg.lastYahooScanAt) {
      yahooLines.push("雅虎监测时间: " + new Date(cfg.lastYahooScanAt).toLocaleString("zh-CN"));
    }
    mgrEls.yahooStatus.textContent = yahooLines.join("\n");
    const lines = [];
    const nodeRes = await chrome.storage.local.get("fcNodeId");
    const nodeShort = nodeRes.fcNodeId ? String(nodeRes.fcNodeId).slice(0, 8) : "—";
    lines.push(
      "ノード: " +
        (cfg.nodeName
          ? cfg.nodeName
          : "未登録（管理プログラムの「連携情報」で名前を付けられます）") +
        "（ID " + nodeShort + "…）"
    );
    lines.push("状態: " + (cfg.lastStatus || "未設定"));
    lines.push(
      "Todo 定时扫描: " +
        (cfg.todoScanEnabled
          ? "已开启（每 " + (cfg.todoScanInterval || 5) +
            (cfg.todoScanUnit === "hours" ? " 小时）" : " 分钟）")
          : "已关闭")
    );
    lines.push("卖出监测: " + (cfg.lastSaleScanStatus || "未扫描"));
    if (cfg.lastSaleScanAt) {
      lines.push("卖出监测时间: " + new Date(cfg.lastSaleScanAt).toLocaleString("zh-CN"));
    }
    if (cfg.lastPollAt) {
      lines.push("最終チェック: " + new Date(cfg.lastPollAt).toLocaleString("ja-JP"));
    }
    mgrEls.status.textContent = lines.join("\n");
  }

  const saveManagerConfig = async () => {
    const interval = Number(mgrEls.todoScanInterval.value);
    const unit = mgrEls.todoScanUnit.value;
    const max = unit === "hours" ? 24 : 1440;
    if (!Number.isInteger(interval) || interval < 1 || interval > max) {
      mgrEls.status.textContent =
        "保存失败：扫描间隔必须是 1 到 " + max + (unit === "hours" ? " 小时" : " 分钟");
      return;
    }
    const yahooInterval = Number(mgrEls.yahooScanInterval.value);
    const yahooUnit = mgrEls.yahooScanUnit.value;
    const yahooMax = yahooUnit === "hours" ? 24 : 1440;
    if (!Number.isInteger(yahooInterval) || yahooInterval < 1 || yahooInterval > yahooMax) {
      mgrEls.status.textContent =
        "保存失败：Yahoo 扫描间隔必须是 1 到 " + yahooMax + (yahooUnit === "hours" ? " 小时" : " 分钟");
      return;
    }
    mgrEls.status.textContent = "正在保存设置…";
    try {
      const result = await chrome.runtime.sendMessage({
        type: "FurimaManagerSaveConfig",
        enabled: mgrEls.enabled.checked,
        baseUrl: mgrEls.baseUrl.value.trim(),
        token: mgrEls.token.value.trim(),
        todoScanEnabled: mgrEls.todoScanEnabled.checked,
        todoScanInterval: interval,
        todoScanUnit: unit,
        yahooScanEnabled: mgrEls.yahooScanEnabled.checked,
        yahooScanInterval: yahooInterval,
        yahooScanUnit: yahooUnit,
      });
      if (!result || !result.ok) {
        mgrEls.status.textContent =
          "保存失败：" + ((result && result.error) || "后台未能更新扫描计划");
        return;
      }
      await renderManager();
    } catch (error) {
      mgrEls.status.textContent =
        "保存失败：" + String((error && error.message) || error);
    }
  };
  document.getElementById("mgrSave").addEventListener("click", saveManagerConfig);
  document.getElementById("todoScanSave").addEventListener("click", saveManagerConfig);
  document.getElementById("yahooScanSave").addEventListener("click", saveManagerConfig);
  mgrEls.todoScanUnit.addEventListener("change", () => {
    mgrEls.todoScanInterval.max = mgrEls.todoScanUnit.value === "hours" ? 24 : 1440;
  });
  mgrEls.yahooScanUnit.addEventListener("change", () => {
    mgrEls.yahooScanInterval.max = mgrEls.yahooScanUnit.value === "hours" ? 24 : 1440;
  });

  document.getElementById("mgrPollNow").addEventListener("click", () => {
    mgrEls.status.textContent = "チェック中…";
    chrome.runtime.sendMessage({ type: "FurimaManagerPollNow" }, () => {
      setTimeout(renderManager, 1200);
    });
  });

  document.getElementById("todoScanNow").addEventListener("click", async () => {
    mgrEls.status.textContent = "Todo 扫描中…";
    try {
      const result = await chrome.runtime.sendMessage({ type: "FurimaTodoScanNow" });
      await renderManager();
      if (result && !result.ok && !result.skipped) {
        mgrEls.status.textContent += "\n立即扫描失败：" + (result.error || "未知错误");
      }
    } catch (error) {
      mgrEls.status.textContent =
        "立即扫描失败：" + String((error && error.message) || error);
    }
  });

  document.getElementById("yahooScanNow").addEventListener("click", async () => {
    mgrEls.yahooStatus.textContent = "Yahoo 扫描中…";
    try {
      const result = await chrome.runtime.sendMessage({ type: "FurimaYahooScanNow" });
      await renderManager();
      if (result && !result.ok && !result.skipped) {
        mgrEls.yahooStatus.textContent += "\n立即扫描失败：" + (result.error || "未知错误");
      }
    } catch (error) {
      mgrEls.yahooStatus.textContent =
        "立即扫描失败：" + String((error && error.message) || error);
    }
  });

  render();
  renderManager();
})();
