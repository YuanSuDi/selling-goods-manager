// ledger.js
// 在庫台帳ページ（inventory.html）の UI。データ操作は lib/inventory.js に委譲する。
(() => {
  "use strict";
  const INV = globalThis.FurimaInventory;
  const $ = (id) => document.getElementById(id);
  const yen = (n) => (n == null ? "" : "¥" + Number(n).toLocaleString("ja-JP"));

  const statusFilter = $("statusFilter");
  INV.STATUSES.forEach((s) => {
    const o = document.createElement("option");
    o.value = s;
    o.textContent = s;
    statusFilter.appendChild(o);
  });

  function download(name, text, type) {
    const blob = new Blob([text], { type: type || "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  async function render() {
    const db = await INV.loadDb();
    const items = db.items.slice().sort((a, b) =>
      String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))
    );

    // サマリー
    const totalQty = items.reduce((s, i) => s + (i.quantity || 0), 0);
    const stockValue = items.reduce(
      (s, i) => s + (i.costPrice != null ? i.costPrice * (i.quantity || 0) : 0),
      0
    );
    const toShip = items.filter((i) => i.status === "已售待发货").length;
    const delist = items.filter((i) => INV.needsDelist(i)).length;
    $("summary").innerHTML =
      "レコード <b>" + items.length + "</b> 件 ・ 在庫合計 <b>" + totalQty + "</b> 点" +
      " ・ 在庫金額（仕入） <b>" + yen(stockValue) + "</b>" +
      " ・ 発送待ち <b>" + toShip + "</b> 件" +
      (delist ? " ・ <b>在庫切れで出品中が " + delist + " 件（要 下架）</b>" : "");

    renderDups(items);
    renderItems(items);
  }

  function renderDups(items) {
    const sec = $("dupSection");
    sec.innerHTML = "";
    const groups = INV.duplicateGroups(items);
    if (!groups.length) return;
    const h = document.createElement("h2");
    h.textContent = "疑似同款（統合候補）";
    h.style.fontSize = "14px";
    sec.appendChild(h);
    groups.forEach((group) => {
      const box = document.createElement("div");
      box.className = "dupGroup";
      const label = document.createElement("div");
      label.className = "small";
      label.textContent = "画像またはタイトルが一致しています。残すレコードを選んで統合してください（数量は統合後の実数に直せます）。";
      box.appendChild(label);
      let keepId = group[0].id;
      const qtyInput = document.createElement("input");
      qtyInput.type = "number";
      qtyInput.min = "0";
      qtyInput.value = Math.max.apply(null, group.map((g) => g.quantity || 0));
      qtyInput.style.width = "70px";
      group.forEach((g, idx) => {
        const span = document.createElement("span");
        span.className = "dupItem";
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "keep-" + group[0].id;
        radio.checked = idx === 0;
        radio.addEventListener("change", () => { keepId = g.id; });
        const img = document.createElement("img");
        img.src = g.thumbData || g.thumbUrl || "";
        img.referrerPolicy = "no-referrer";
        img.alt = "";
        const txt = document.createElement("span");
        txt.textContent = g.code + " " + (g.title || "") + "（数量 " + g.quantity + "）";
        span.appendChild(radio);
        span.appendChild(img);
        span.appendChild(txt);
        box.appendChild(span);
      });
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "統合する（数量→）";
      btn.addEventListener("click", async () => {
        const qty = parseInt(qtyInput.value, 10);
        for (const g of group) {
          if (g.id !== keepId) {
            await INV.mergeItems(keepId, g.id, Number.isFinite(qty) ? qty : null);
          }
        }
        render();
      });
      box.appendChild(btn);
      box.appendChild(qtyInput);
      sec.appendChild(box);
    });
  }

  function field(labelText, input) {
    const l = document.createElement("label");
    l.textContent = labelText + " ";
    l.appendChild(input);
    return l;
  }

  function renderItems(items) {
    const q = ($("q").value || "").toLowerCase();
    const sf = statusFilter.value;
    const wrap = $("items");
    wrap.innerHTML = "";
    items
      .filter((i) => !sf || i.status === sf)
      .filter(
        (i) =>
          !q ||
          (i.title || "").toLowerCase().includes(q) ||
          (i.code || "").toLowerCase().includes(q)
      )
      .forEach((item) => wrap.appendChild(itemCard(item)));
    if (!wrap.children.length) {
      const p = document.createElement("p");
      p.className = "small";
      p.textContent = "レコードがありません。新規作成か URL 取り込みで追加してください。";
      wrap.appendChild(p);
    }
  }

  function itemCard(item) {
    const card = document.createElement("div");
    card.className = "card" + (INV.needsDelist(item) ? " delist" : "");

    const img = document.createElement("img");
    img.className = "thumb";
    img.src = item.thumbData || item.thumbUrl || "";
    img.referrerPolicy = "no-referrer";
    img.alt = "";
    card.appendChild(img);

    const grow = document.createElement("div");
    grow.className = "grow";
    card.appendChild(grow);

    const titleRow = document.createElement("div");
    titleRow.className = "titleRow";
    const code = document.createElement("span");
    code.className = "code";
    code.textContent = item.code || "";
    const title = document.createElement("input");
    title.type = "text";
    title.className = "titleInput";
    title.value = item.title || "";
    title.addEventListener("change", async () => {
      await INV.updateItem(item.id, { title: title.value });
      render();
    });
    titleRow.appendChild(code);
    titleRow.appendChild(title);
    grow.appendChild(titleRow);

    if (INV.needsDelist(item)) {
      const w = document.createElement("div");
      w.className = "warn";
      w.textContent = "⚠ 在庫切れです。出品中の他プラットフォームを下架してください。";
      grow.appendChild(w);
    }

    const grid = document.createElement("div");
    grid.className = "grid";

    const qty = document.createElement("input");
    qty.type = "number";
    qty.min = "0";
    qty.value = item.quantity;
    qty.addEventListener("change", async () => {
      await INV.updateItem(item.id, { quantity: Math.max(0, parseInt(qty.value, 10) || 0) });
      render();
    });
    grid.appendChild(field("数量", qty));

    const st = document.createElement("select");
    INV.STATUSES.forEach((s) => {
      const o = document.createElement("option");
      o.value = s;
      o.textContent = s;
      if (item.status === s) o.selected = true;
      st.appendChild(o);
    });
    st.addEventListener("change", async () => {
      await INV.updateItem(item.id, { status: st.value });
      render();
    });
    grid.appendChild(field("状態", st));

    const cost = document.createElement("input");
    cost.type = "number";
    cost.placeholder = "任意";
    cost.value = item.costPrice != null ? item.costPrice : "";
    cost.addEventListener("change", async () => {
      const v = cost.value === "" ? null : parseInt(cost.value, 10);
      await INV.updateItem(item.id, { costPrice: Number.isFinite(v) ? v : null });
      render();
    });
    grid.appendChild(field("仕入価格", cost));

    const channel = document.createElement("input");
    channel.type = "text";
    channel.value = item.channel || "";
    channel.addEventListener("change", async () => {
      await INV.updateItem(item.id, { channel: channel.value || null });
    });
    grid.appendChild(field("仕入先", channel));

    const loc = document.createElement("input");
    loc.type = "text";
    loc.value = item.location || "";
    loc.addEventListener("change", async () => {
      await INV.updateItem(item.id, { location: loc.value || null });
    });
    grid.appendChild(field("保管場所", loc));

    const note = document.createElement("input");
    note.type = "text";
    note.value = item.note || "";
    note.addEventListener("change", async () => {
      await INV.updateItem(item.id, { note: note.value || null });
    });
    grid.appendChild(field("メモ", note));

    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger";
    del.textContent = "削除";
    del.addEventListener("click", async () => {
      if (confirm("レコード " + item.code + " を削除しますか？")) {
        await INV.deleteItem(item.id);
        render();
      }
    });
    grid.appendChild(del);
    grow.appendChild(grid);

    // 出品リスト
    const listings = document.createElement("div");
    listings.className = "listings";
    (item.listings || []).forEach((l, idx) => {
      const row = document.createElement("div");
      row.className = "listing";
      const plat = document.createElement("span");
      plat.className = "plat";
      plat.textContent = INV.PLATFORM_LABELS[l.platform] || l.platform;
      const link = document.createElement("a");
      link.href = l.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = l.itemId || "リンク";
      const price = document.createElement("span");
      price.textContent = l.price != null ? yen(l.price) : "";
      const sel = document.createElement("select");
      INV.LISTING_STATUSES.forEach((s) => {
        const o = document.createElement("option");
        o.value = s;
        o.textContent = s;
        if (l.status === s) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener("change", async () => {
        const db = await INV.loadDb();
        const it = db.items.find((x) => x.id === item.id);
        if (it && it.listings[idx]) {
          it.listings[idx].status = sel.value;
          await INV.saveDb(db);
          render();
        }
      });
      const soldBtn = document.createElement("button");
      soldBtn.type = "button";
      soldBtn.textContent = "売れた";
      soldBtn.disabled = l.status === "已售";
      soldBtn.addEventListener("click", async () => {
        await INV.markListingSold(item.id, idx, l.price);
        render();
      });
      row.appendChild(plat);
      row.appendChild(link);
      row.appendChild(price);
      row.appendChild(sel);
      row.appendChild(soldBtn);
      listings.appendChild(row);
    });

    const addRow = document.createElement("div");
    addRow.className = "listing";
    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.placeholder = "出品 URL を貼って追加";
    urlInput.style.width = "320px";
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.textContent = "出品を追加";
    addBtn.addEventListener("click", async () => {
      const u = urlInput.value.trim();
      if (!u) return;
      await INV.addListing(item.id, { url: u });
      render();
    });
    addRow.appendChild(urlInput);
    addRow.appendChild(addBtn);
    listings.appendChild(addRow);
    grow.appendChild(listings);

    if ((item.sales || []).length) {
      const sales = document.createElement("div");
      sales.className = "sales";
      sales.textContent =
        "販売履歴: " +
        item.sales
          .map(
            (s) =>
              (INV.PLATFORM_LABELS[s.platform] || s.platform) + " " +
              (s.price != null ? yen(s.price) : "") +
              (item.costPrice != null && s.price != null
                ? "（粗利 " + yen(s.price - item.costPrice) + "）"
                : "") +
              " " + new Date(s.at).toLocaleDateString("ja-JP")
          )
          .join(" / ");
      grow.appendChild(sales);
    }

    return card;
  }

  // ツールバー
  $("q").addEventListener("input", render);
  statusFilter.addEventListener("change", render);
  $("btnNew").addEventListener("click", () => {
    $("newPanel").hidden = !$("newPanel").hidden;
  });
  $("btnCreate").addEventListener("click", async () => {
    const title = $("newTitle").value.trim();
    if (!title) return;
    const cost = $("newCost").value === "" ? null : parseInt($("newCost").value, 10);
    await INV.createItem({
      title,
      quantity: Math.max(0, parseInt($("newQty").value, 10) || 0),
      costPrice: Number.isFinite(cost) ? cost : null,
      channel: $("newChannel").value || null,
      location: $("newLocation").value || null,
      status: "在库",
    });
    $("newPanel").hidden = true;
    render();
  });
  $("btnCsv").addEventListener("click", async () => {
    const db = await INV.loadDb();
    download("inventory.csv", "﻿" + INV.toCsv(db.items), "text/csv;charset=utf-8");
  });
  $("btnJson").addEventListener("click", async () => {
    const db = await INV.loadDb();
    download("inventory.json", JSON.stringify(db, null, 2), "application/json");
  });
  $("fileJson").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      const db = JSON.parse(await f.text());
      if (!db || !Array.isArray(db.items)) throw new Error("形式が違います");
      await INV.saveDb(db);
      render();
    } catch (err) {
      alert("読み込みに失敗しました: " + String((err && err.message) || err));
    }
  });
  $("btnImport").addEventListener("click", () => {
    const urls = $("importUrls").value
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!urls.length) return;
    $("importStatus").textContent = "取り込みを開始します…";
    chrome.runtime.sendMessage({ type: "FurimaInventoryImport", urls }, () => {
      void chrome.runtime.lastError;
    });
  });

  async function renderImportStatus() {
    const res = await chrome.storage.local.get("inventoryImportStatus");
    const st = res.inventoryImportStatus;
    if (!st) return;
    const lines = [
      (st.running ? "取り込み中" : "取り込み終了") + ": " + st.done + " / " + st.total + " 件",
    ];
    (st.results || []).forEach((r) => {
      lines.push(
        (r.ok ? "✅ " : "⚠️ ") + (r.code ? r.code + " " : "") + (r.title || r.url) +
        (r.error ? "（" + r.error + "）" : "")
      );
    });
    $("importStatus").textContent = lines.join("\n");
    if (!st.running) render();
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.inventoryImportStatus) renderImportStatus();
    if (area === "local" && changes[INV.KEY]) render();
  });

  render();
  renderImportStatus();
})();
