// lib/inventory.js
// フリマコピー（自作）の在庫台帳ライブラリ（v0.6.0）。
// 一つの在庫レコード = 一「款」の実物。在庫データは chrome.storage.local の
// キー "inventoryV1" に { seq, items: []} として保存する（この PC の中だけ）。
//
// レコード:
// { id, code ("FC-0001"), title, thumbUrl, imageHash,
// quantity, status, costPrice, channel, location, note,
// listings: [{ platform, itemId, url, price, status, boundAt}],
// sales: [{ platform, itemId, price, at, fee, shippingCost}],
// createdAt, updatedAt}
//
// 識別は 3 層: ①説明文中の管理番号（管理No：FC-XXXX、決定的）
// ②コピー経由のバインド（来歴） ③画像ハッシュ（候補提示のみ）
// 番号は台帳が採番し、出品説明の末尾に「管理No：FC-XXXX」と入れて回す。
(() => {
"use strict";

const KEY = "inventoryV1";
const STATUSES = ["在库", "出品中", "已售待发货", "已发货", "已完成"];
const LISTING_STATUSES = ["出品中", "已售", "已下架"];
const PLATFORM_LABELS = {
mercari: "メルカリ",
rakuma: "ラクマ",
paypay: "PayPayフリマ",
yahoo: "Yahoo!オークション",
};

async function loadDb() {
const res = await chrome.storage.local.get(KEY);
const db = res[KEY];
if (db && Array.isArray(db.items) && typeof db.seq === "number") return db;
return { seq: 0, items: []};
}

async function saveDb(db) {
await chrome.storage.local.set({ [KEY]: db});
}

function nextCode(db) {
db.seq += 1;
return "FC-" + String(db.seq).padStart(4, "0");
}

function newId() {
return (
"it" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
);
}

// 説明文から管理番号を取り出す。書式は「管理No：FC-0001」。
// 誤爆防止に管理No 表記つきを優先し、無ければ FC-XXXX 単体にも一致させる。
function extractCode(text) {
if (!text) return null;
const s = String(text);
const m =
s.match(/管理\s*No[:：]?\s*(FC-\d{3,})/i) || s.match(/\b(FC-\d{3,})\b/i);
return m? m[1].toUpperCase(): null;
}

// 説明文に管理番号が無ければ末尾へ 1 行追加する（既に同じ番号があれば何もしない）。
function ensureCode(text, code) {
const base = text == null? "": String(text);
if (!code) return base;
if (extractCode(base) === code) return base;
const cleaned = base
.replace(/\n*\s*管理\s*No[:：]?\s*FC-\d+\s*$/i, "")
.replace(/\s+$/g, "");
return cleaned + "\n\n管理No：" + code;
}

function normalizeTitle(t) {
return (t || "")
.toLowerCase()
.replace(
/[\s　・、。，．\[\]（）()!！?？:：;；/／\\\-ー~〜_｜|「」『』]/g,
""
);
}

function itemIdFromUrl(platform, url) {
if (!url) return null;
const s = String(url);
let m = null;
if (platform === "mercari") m = s.match(/\/item\/([A-Za-z0-9]+)/);
else if (platform === "paypay") m = s.match(/\/item\/([A-Za-z0-9]+)/);
else if (platform === "yahoo")
m = s.match(/\/auction\/([A-Za-z0-9]+)/) || s.match(/\/item\/([A-Za-z0-9]+)/);
else if (platform === "rakuma")
m = s.match(/item\.fril\.jp\/([A-Za-z0-9]+)/) || s.match(/\/item\/([A-Za-z0-9]+)/);
return m? m[1]: null;
}

function platformFromUrl(url) {
const s = String(url || "");
if (/jp\.mercari\.com/.test(s)) return "mercari";
if (/fril\.jp/.test(s)) return "rakuma";
if (/paypayfleamarket/.test(s)) return "paypay";
if (/auctions\.yahoo\.co\.jp/.test(s)) return "yahoo";
return null;
}

function blankItem(fields) {
const now = new Date().toISOString();
return Object.assign(
{
id: newId(),
code: null,
title: "（無題）",
thumbUrl: null,
thumbData: null,
imageHash: null,
quantity: 1,
status: "在库",
costPrice: null,
channel: null,
location: null,
note: null,
listings: [],
sales: [],
createdAt: now,
updatedAt: now,
},
fields || {}
);
}

// コピーデータ（FurimaCopy の copyData 形式）から在庫レコードを引く/作る。
// opts.bindListing が true なら、その商品ページを出品としてバインドする。
async function upsertFromCopy(data, opts) {
const bindListing =!opts || opts.bindListing!== false;
const db = await loadDb();
const code = extractCode(data && data.description);
const platform = (data && data.source) || platformFromUrl(data && data.sourceUrl);
const url = (data && data.sourceUrl) || null;
const itemId = platform? itemIdFromUrl(platform, url): null;

let item = null;
if (code) item = db.items.find((i) => i.code === code) || null;
if (!item && platform && itemId) {
item =
db.items.find((i) =>
i.listings.some((l) => l.platform === platform && l.itemId === itemId)
) || null;
}
let created = false;
if (!item) {
item = blankItem({
code: code || nextCode(db),
title: (data && data.title) || "（無題）",
thumbUrl: (data && data.imageUrls && data.imageUrls[0]) || null,
thumbData: (data && data.thumbData) || null,
imageHash: (data && data.imageHash) || null,
status: bindListing? "出品中": "在库",
});
db.items.push(item);
created = true;
} else {
if (!item.imageHash && data && data.imageHash) item.imageHash = data.imageHash;
if (!item.thumbUrl && data && data.imageUrls && data.imageUrls[0]) {
item.thumbUrl = data.imageUrls[0];
}
if (!item.thumbData && data && data.thumbData) {
item.thumbData = data.thumbData;
}
}
if (bindListing && platform && url) {
const exists = item.listings.some(
(l) =>
l.platform === platform &&
((itemId && l.itemId === itemId) || l.url === url)
);
if (!exists) {
item.listings.push({
platform,
itemId: itemId || null,
url,
price: data && data.price!= null? data.price: null,
status: "出品中",
boundAt: new Date().toISOString(),
});
}
if (item.status === "在库") item.status = "出品中";
}
item.updatedAt = new Date().toISOString();
await saveDb(db);
return { item, created};
}


// base64 の画像から台帳用の縮小サムネイル（data URL）を作る。ページ文脈専用。
function thumbFromBase64(base64, mime) {
return new Promise((resolve) => {
try {
if (typeof Image === "undefined" || typeof document === "undefined") {
resolve(null);
return;
}
const img = new Image();
img.onload = () => {
try {
const max = 192;
const scale = Math.min(1, max / Math.max(img.width || 1, img.height || 1));
const w = Math.max(1, Math.round((img.width || 1) * scale));
const h = Math.max(1, Math.round((img.height || 1) * scale));
const c = document.createElement("canvas");
c.width = w;
c.height = h;
c.getContext("2d").drawImage(img, 0, 0, w, h);
resolve(c.toDataURL("image/jpeg", 0.82));
} catch (e) {
resolve(null);
}
};
img.onerror = () => resolve(null);
img.src = "data:" + (mime || "image/jpeg") + ";base64," + base64;
} catch (e) {
resolve(null);
}
});
}

async function setThumbByCode(code, thumbData) {
if (!code || !thumbData) return null;
const db = await loadDb();
const item = db.items.find((i) => i.code === code);
if (!item) return null;
item.thumbData = thumbData;
item.updatedAt = new Date().toISOString();
await saveDb(db);
return item;
}

async function createItem(fields) {
const db = await loadDb();
const item = blankItem(Object.assign({}, fields, { code: nextCode(db)}));
db.items.push(item);
await saveDb(db);
return item;
}

async function updateItem(id, patch) {
const db = await loadDb();
const item = db.items.find((i) => i.id === id);
if (!item) return null;
Object.assign(item, patch || {});
item.updatedAt = new Date().toISOString();
await saveDb(db);
return item;
}

async function deleteItem(id) {
const db = await loadDb();
db.items = db.items.filter((i) => i.id!== id);
await saveDb(db);
}

async function addListing(id, listing) {
const db = await loadDb();
const item = db.items.find((i) => i.id === id);
if (!item) return null;
const platform = listing.platform || platformFromUrl(listing.url);
const itemId = platform? itemIdFromUrl(platform, listing.url): null;
item.listings.push({
platform: platform || "mercari",
itemId: itemId || null,
url: listing.url,
price: listing.price!= null? listing.price: null,
status: "出品中",
boundAt: new Date().toISOString(),
});
if (item.status === "在库") item.status = "出品中";
item.updatedAt = new Date().toISOString();
await saveDb(db);
return item;
}

// 出品 1 件を「売れた」にする。在庫を 1 減らし、販売記録を残す。
async function markListingSold(id, listingIndex, soldPrice) {
const db = await loadDb();
const item = db.items.find((i) => i.id === id);
if (!item) return null;
const listing = item.listings[listingIndex];
if (!listing) return null;
listing.status = "已售";
item.sales.push({
platform: listing.platform,
itemId: listing.itemId || null,
price: soldPrice!= null? soldPrice: listing.price,
at: new Date().toISOString(),
fee: null,
shippingCost: null,
});
item.quantity = Math.max(0, (item.quantity || 0) - 1);
const stillActive = item.listings.some((l) => l.status === "出品中");
if (item.quantity === 0) item.status = "已售待发货";
else if (!stillActive) item.status = "已售待发货";
item.updatedAt = new Date().toISOString();
await saveDb(db);
return item;
}

// 在庫切れなのにまだ「出品中」の出品が残っているか（下架提醒）。
function needsDelist(item) {
return (
(item.quantity || 0) === 0 &&
(item.listings || []).some((l) => l.status === "出品中")
);
}

// dropId のレコードを keepId へ統合する。数量は呼び出し側が決めた finalQuantity。
async function mergeItems(keepId, dropId, finalQuantity) {
const db = await loadDb();
const keep = db.items.find((i) => i.id === keepId);
const drop = db.items.find((i) => i.id === dropId);
if (!keep ||!drop || keep === drop) return null;
const seen = new Set(
keep.listings.map((l) => l.platform + "|" + (l.itemId || l.url))
);
drop.listings.forEach((l) => {
const k = l.platform + "|" + (l.itemId || l.url);
if (!seen.has(k)) {
keep.listings.push(l);
seen.add(k);
}
});
keep.sales = keep.sales.concat(drop.sales || []);
if (!keep.thumbUrl) keep.thumbUrl = drop.thumbUrl;
if (!keep.imageHash) keep.imageHash = drop.imageHash;
if (keep.costPrice == null) keep.costPrice = drop.costPrice;
if (finalQuantity!= null) keep.quantity = finalQuantity;
keep.updatedAt = new Date().toISOString();
db.items = db.items.filter((i) => i.id!== dropId);
await saveDb(db);
return keep;
}

// 疑似同款グループ: 画像ハッシュ一致 / 正規化タイトル一致（6 文字以上）。
function duplicateGroups(items) {
const groups = [];
const used = new Set();
const list = items || [];
for (let i = 0; i < list.length; i++) {
if (used.has(list[i].id)) continue;
const group = [list[i]];
for (let j = i + 1; j < list.length; j++) {
if (used.has(list[j].id)) continue;
const a = list[i];
const b = list[j];
const sameHash = a.imageHash && b.imageHash && a.imageHash === b.imageHash;
const ta = normalizeTitle(a.title);
const tb = normalizeTitle(b.title);
const sameTitle = ta && ta === tb && ta.length >= 6;
if (sameHash || sameTitle) group.push(b);
}
if (group.length > 1) {
group.forEach((g) => used.add(g.id));
groups.push(group);
}
}
return groups;
}

function toCsv(items) {
const esc = (v) => {
const s = v == null? "": String(v);
return /[",\n]/.test(s)? '"' + s.replace(/"/g, '""') + '"': s;
};
const head = [
"管理番号", "商品名", "数量", "状态", "进货价", "渠道", "存放位置", "备注",
"出品（平台:ID:价格:状态）", "售出记录数", "创建时间",
];
const lines = [head.join(",")];
(items || []).forEach((i) => {
const listings = (i.listings || [])
.map((l) => [l.platform, l.itemId || "", l.price!= null? l.price: "", l.status].join(":"))
.join(" | ");
lines.push(
[i.code, i.title, i.quantity, i.status, i.costPrice, i.channel, i.location, i.note,
listings, (i.sales || []).length, i.createdAt].map(esc).join(",")
);
});
return lines.join("\r\n");
}

globalThis.FurimaInventory = {
KEY,
STATUSES,
LISTING_STATUSES,
PLATFORM_LABELS,
loadDb,
saveDb,
nextCode,
extractCode,
ensureCode,
normalizeTitle,
itemIdFromUrl,
platformFromUrl,
upsertFromCopy,
thumbFromBase64,
setThumbByCode,
createItem,
updateItem,
deleteItem,
addListing,
markListingSold,
needsDelist,
mergeItems,
duplicateGroups,
toCsv,
};
})();
