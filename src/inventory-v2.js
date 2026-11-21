'use strict'

// inventory-v2.js — v0.2.0 のデータ層。
//
// 商品 → 状態（コンディション）→ 出品レコード の3層モデルと、
// ブラウザノード（Chrome プロファイル）の登録簿を管理する。
//
//   状態 (conditions.db): 全商品共通の辞書 { _id, name, isDefault, sort, createdAt }
//     - 改名は表示名だけの変更（_id は不変なので履歴・参照は壊れない）。
//     - 在庫やレコードがぶら下がっている状態は削除できない。
//   出品レコード (listings.db): 1件のウェブサイト出品とのバインド。
//     { _id, product_no, condition_id, platform, node_id, listing_id,
//       listing_url, auto_restock, auto_delist, quota, sold_count, status,
//       error, last_processed_sale_item_id, createdAt, updatedAt,
//       listing_state, listed_at, state_at }
//     - node_id は拡張が自動生成するノード ID。'' は「未割当（既定プール）」。
//     - quota はこのレコードが売ってよい上限（null = 制限なし）。
//     - auto_delist は自動下架の対象かどうか（レコード単位の opt-in）。
//     - listing_state は出品ライフサイクル: 'live'（出品中）/ 'sold'
//       （販売済み・補充待ち）/ 'unlisted'（未出品）/ 'unknown'（要確認）。
//       確認済みイベントでのみ更新し、state_at にその時刻を持つ。
//       listed_at は現在の出品が公開された時刻（下架の残存優先順位用）。
//     - status は従来どおりレコードの健全性（'active' / 'error'）。
//   ノード (nodes.db): { _id(=ノードID), name, firstSeenAt, lastSeenAt }
//     - 表示名はここ（プログラム側）でのみ付け、重複は拒否する。
//
// 商品ドキュメント側の在庫は condition_stock { [状態ID]: 件数 } で持ち、
// product.sku は常にその合計に同期させる（従来 UI・検索との互換のため）。
// product.selled_num も従来どおり商品全体の累計を保持し、内訳は
// condition_sold { [状態ID]: 件数 } に持つ。

const crypto = require('crypto')

function newId(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex')
}

function find(db, query) {
  return new Promise((resolve, reject) =>
    db.find(query || {}, (e, d) => (e ? reject(e) : resolve(d)))
  )
}
function findOne(db, query) {
  return new Promise((resolve, reject) =>
    db.findOne(query, (e, d) => (e ? reject(e) : resolve(d)))
  )
}
function insert(db, doc) {
  return new Promise((resolve, reject) =>
    db.insert(doc, (e, d) => (e ? reject(e) : resolve(d)))
  )
}
function update(db, query, upd, options) {
  return new Promise((resolve, reject) =>
    db.update(query, upd, options || {}, (e, n) => (e ? reject(e) : resolve(n)))
  )
}
function remove(db, query) {
  return new Promise((resolve, reject) =>
    db.remove(query, {}, (e, n) => (e ? reject(e) : resolve(n)))
  )
}

// プラットフォームごとの商品 ID を URL / ID 文字列から取り出す。
function parseListingId(platform, input) {
  if (!input) return null
  const s = String(input).trim()
  if (platform === 'yahoo') {
    const m = s.match(/auctions\.yahoo\.co\.jp\/jp\/auction\/([a-z]?\d+)/i) || s.match(/^([a-z]?\d+)$/)
    return m ? m[1] : null
  }
  const m = s.match(/jp\.mercari\.com\/item\/(m\d+)/) || s.match(/^(m\d+)$/)
  return m ? m[1] : null
}

function listingUrl(platform, listingId) {
  if (!listingId) return null
  return platform === 'yahoo'
    ? 'https://auctions.yahoo.co.jp/jp/auction/' + listingId
    : 'https://jp.mercari.com/item/' + listingId
}

// 商品の状態別在庫の合計。移行前の商品（マップなし）は sku をそのまま使う。
function conditionStockTotal(product) {
  if (!product) return 0
  const map = product.condition_stock
  if (map && typeof map === 'object') {
    return Object.values(map).reduce((a, b) => a + Math.max(0, Number(b || 0)), 0)
  }
  return Math.max(0, Number(product.sku || 0))
}

function createInventoryV2(dbs) {
  const productsDb = dbs.productsDb
  const conditionsDb = dbs.conditionsDb
  const listingsDb = dbs.listingsDb
  const nodesDb = dbs.nodesDb

  async function ensureDefaultCondition() {
    let cond = await findOne(conditionsDb, { isDefault: true })
    if (!cond) {
      cond = await insert(conditionsDb, {
        _id: newId('cond'),
        name: '通常',
        isDefault: true,
        sort: 0,
        createdAt: new Date().toISOString(),
      })
    }
    return cond
  }

  // v0.1.x 形式からの移行（冪等：起動のたびに走らせてよい）。
  // - 状態別在庫マップがない商品に、既定状態へ全在庫を寄せて作る。
  // - mercari_ref / yahoo_ref があれば、既定状態・ノード未割当の
  //   レコードを生成する（重複チェック済みの売却 ID とエラーも引き継ぐ）。
  async function migrate() {
    const stats = { productsTouched: 0, recordsCreated: 0 }
    const def = await ensureDefaultCondition()
    const products = await find(productsDb, {})
    for (const p of products) {
      const $set = {}
      if (!p.condition_stock || typeof p.condition_stock !== 'object') {
        $set.condition_stock = { [def._id]: Math.max(0, Number(p.sku || 0)) }
        $set.condition_sold = { [def._id]: Math.max(0, Number(p.selled_num || 0)) }
      }
      if (Object.keys($set).length) {
        await update(productsDb, { _id: p._id }, { $set })
        stats.productsTouched += 1
      }
      const sources = [
        { platform: 'mercari', ref: p.mercari_ref, auto: p.auto_restock, err: p.list_error, last: p.last_processed_sale_item_id },
        { platform: 'yahoo', ref: p.yahoo_ref, auto: p.yahoo_auto_restock, err: p.yahoo_list_error, last: p.last_processed_yahoo_sale_item_id },
      ]
      for (const src of sources) {
        const lid = parseListingId(src.platform, src.ref)
        if (!lid) continue
        const existing = await findOne(listingsDb, {
          product_no: p.product_no,
          platform: src.platform,
          listing_id: lid,
        })
        if (existing) continue
        await insert(listingsDb, {
          _id: newId('lst'),
          product_no: p.product_no,
          condition_id: def._id,
          platform: src.platform,
          node_id: '',
          listing_id: lid,
          listing_url: listingUrl(src.platform, lid),
          auto_restock: !!src.auto,
          auto_delist: false,
          quota: null,
          sold_count: 0,
          status: src.err ? 'error' : 'active',
          error: src.err || null,
          last_processed_sale_item_id: src.last || null,
          listing_state: 'live',
          listed_at: new Date().toISOString(),
          state_at: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        stats.recordsCreated += 1
      }
    }
    // v0.2.12: 既存レコードへ出品状態フィールドを補完する（冪等）。
    const allRecords = await find(listingsDb, {})
    for (const r of allRecords) {
      if (r.listing_state) continue
      const at = r.updatedAt || r.createdAt || new Date().toISOString()
      await update(listingsDb, { _id: r._id }, {
        $set: {
          listing_state: r.listing_id ? 'live' : 'unlisted',
          listed_at: r.listing_id ? at : null,
          state_at: at,
          auto_delist: !!r.auto_delist,
        },
      })
      stats.productsTouched += 1
    }
    return stats
  }

  // ---- 状態（コンディション）辞書 ----
  async function listConditions() {
    const list = await find(conditionsDb, {})
    return list.sort((a, b) => (a.sort || 0) - (b.sort || 0) || String(a.createdAt).localeCompare(String(b.createdAt)))
  }

  async function saveCondition(data) {
    const name = String((data && data.name) || '').trim()
    if (!name) return { ok: false, error: '状態名を入力してください。' }
    const all = await listConditions()
    if (data && data.id) {
      const cond = all.find((c) => c._id === data.id)
      if (!cond) return { ok: false, error: '状態が見つかりません。' }
      if (all.some((c) => c._id !== data.id && c.name === name)) {
        return { ok: false, error: '同じ名前の状態が既にあります。' }
      }
      await update(conditionsDb, { _id: data.id }, { $set: { name } })
      return { ok: true, condition: Object.assign({}, cond, { name }) }
    }
    if (all.some((c) => c.name === name)) {
      return { ok: false, error: '同じ名前の状態が既にあります。' }
    }
    const cond = await insert(conditionsDb, {
      _id: newId('cond'),
      name,
      isDefault: false,
      sort: all.length,
      createdAt: new Date().toISOString(),
    })
    return { ok: true, condition: cond }
  }

  async function deleteCondition(id) {
    const cond = await findOne(conditionsDb, { _id: id })
    if (!cond) return { ok: false, error: '状態が見つかりません。' }
    if (cond.isDefault) return { ok: false, error: '既定の状態は削除できません。' }
    const usedByListing = await findOne(listingsDb, { condition_id: id })
    if (usedByListing) return { ok: false, error: '出品レコードがある状態は削除できません。先にレコードを削除してください。' }
    const products = await find(productsDb, {})
    const usedByStock = products.some(
      (p) => p.condition_stock && Number(p.condition_stock[id] || 0) > 0
    )
    if (usedByStock) return { ok: false, error: '在庫が残っている状態は削除できません。先に在庫を0にしてください。' }
    await remove(conditionsDb, { _id: id })
    return { ok: true }
  }

  // ---- 出品レコード ----
  async function listListings(productNo) {
    const q = productNo ? { product_no: productNo } : {}
    const list = await find(listingsDb, q)
    return list.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  }

  async function getListing(id) {
    if (!id) return null
    return findOne(listingsDb, { _id: id })
  }

  async function findRecordByListingId(platform, listingId) {
    if (!listingId) return null
    return findOne(listingsDb, { platform, listing_id: String(listingId) })
  }

  async function saveListing(data) {
    const platform = data && data.platform === 'yahoo' ? 'yahoo' : 'mercari'
    const productNo = String((data && data.product_no) || '').trim()
    if (!productNo) return { ok: false, error: '商品管理番号が指定されていません。' }
    const product = await findOne(productsDb, { product_no: productNo })
    if (!product) return { ok: false, error: '商品が見つかりません。' }
    let conditionId = data.condition_id || null
    if (!conditionId) {
      const def = await ensureDefaultCondition()
      conditionId = def._id
    }
    const lid = parseListingId(platform, data.itemUrl || data.listing || data.listing_id || '')
    const autoRestock = !!(data && data.auto_restock)
    const now = new Date().toISOString()
    if (!lid) {
      return { ok: false, error: '有効な商品 URL または商品 ID を入力してください。' }
    }
    if (data.id) {
      const rec = await findOne(listingsDb, { _id: data.id })
      if (!rec) return { ok: false, error: 'レコードが見つかりません。' }
      const clash = await findOne(listingsDb, { platform, listing_id: lid })
      if (clash && clash._id !== data.id) {
        return { ok: false, error: 'その商品 ID は既に別のレコードに登録されています。' }
      }
      const $set = {
        condition_id: conditionId,
        listing_id: lid,
        listing_url: listingUrl(platform, lid),
        auto_restock: autoRestock,
        quota: data.quota != null && data.quota !== '' ? Math.max(0, Number(data.quota)) : null,
        node_id: data.node_id != null ? String(data.node_id) : rec.node_id || '',
        updatedAt: now,
      }
      if (data.auto_delist !== undefined) $set.auto_delist = !!data.auto_delist
      // 手で生きたリンクを結んだ = 出品中として扱う。ID が変わった場合は
      // 出品時刻も付け替える（下架の残存優先順位は listed_at 基準）。
      $set.listing_state = 'live'
      $set.state_at = now
      if (rec.listing_id !== lid || !rec.listed_at) $set.listed_at = now
      await update(listingsDb, { _id: data.id }, { $set })
      return { ok: true, listing: Object.assign({}, rec, $set) }
    }
    const clash = await findOne(listingsDb, { platform, listing_id: lid })
    if (clash) {
      return { ok: false, error: 'その商品 ID は既に別のレコードに登録されています。' }
    }
    const rec = await insert(listingsDb, {
      _id: newId('lst'),
      product_no: productNo,
      condition_id: conditionId,
      platform,
      node_id: data.node_id != null ? String(data.node_id) : '',
      listing_id: lid,
      listing_url: listingUrl(platform, lid),
      auto_restock: autoRestock,
      auto_delist: !!(data && data.auto_delist),
      quota: data.quota != null && data.quota !== '' ? Math.max(0, Number(data.quota)) : null,
      sold_count: 0,
      status: 'active',
      error: null,
      last_processed_sale_item_id: null,
      listing_state: 'live',
      listed_at: now,
      state_at: now,
      createdAt: now,
      updatedAt: now,
    })
    return { ok: true, listing: rec }
  }

  async function deleteListing(id) {
    const rec = await findOne(listingsDb, { _id: id })
    if (!rec) return { ok: false, error: 'レコードが見つかりません。' }
    await remove(listingsDb, { _id: id })
    return { ok: true, listing: rec }
  }

  async function updateListing(id, $set) {
    const upd = Object.assign({}, $set, { updatedAt: new Date().toISOString() })
    await update(listingsDb, { _id: id }, { $set: upd })
    return findOne(listingsDb, { _id: id })
  }

  // ---- ノード登録簿 ----
  async function touchNode(nodeId) {
    if (!nodeId) return null
    const now = new Date().toISOString()
    const existing = await findOne(nodesDb, { _id: nodeId })
    if (!existing) {
      return insert(nodesDb, { _id: nodeId, name: null, firstSeenAt: now, lastSeenAt: now })
    }
    await update(nodesDb, { _id: nodeId }, { $set: { lastSeenAt: now } })
    return Object.assign({}, existing, { lastSeenAt: now })
  }

  async function listNodes() {
    const list = await find(nodesDb, {})
    return list.sort((a, b) => String(a.firstSeenAt).localeCompare(String(b.firstSeenAt)))
  }

  async function getNode(nodeId) {
    if (!nodeId) return null
    return findOne(nodesDb, { _id: nodeId })
  }

  async function renameNode(nodeId, name) {
    const node = await findOne(nodesDb, { _id: nodeId })
    if (!node) return { ok: false, error: 'ノードが見つかりません。' }
    const trimmed = String(name || '').trim()
    if (!trimmed) {
      await update(nodesDb, { _id: nodeId }, { $set: { name: null } })
      return { ok: true, node: Object.assign({}, node, { name: null }) }
    }
    const all = await listNodes()
    if (all.some((n) => n._id !== nodeId && n.name === trimmed)) {
      return { ok: false, error: '同じ名前のノードが既にあります。別の名前を付けてください。' }
    }
    await update(nodesDb, { _id: nodeId }, { $set: { name: trimmed } })
    return { ok: true, node: Object.assign({}, node, { name: trimmed }) }
  }

  async function deleteNode(nodeId) {
    const node = await findOne(nodesDb, { _id: nodeId })
    if (!node) return { ok: false, error: 'ノードが見つかりません。' }
    const used = await findOne(listingsDb, { node_id: nodeId })
    if (used) return { ok: false, error: 'レコードが割り当たっているノードは削除できません。先にレコードの割当を外してください。' }
    await remove(nodesDb, { _id: nodeId })
    return { ok: true }
  }

  return {
    ensureDefaultCondition,
    migrate,
    listConditions,
    saveCondition,
    deleteCondition,
    listListings,
    getListing,
    findRecordByListingId,
    saveListing,
    deleteListing,
    updateListing,
    touchNode,
    listNodes,
    getNode,
    renameNode,
    deleteNode,
  }
}

module.exports = {
  createInventoryV2,
  parseListingId,
  listingUrl,
  conditionStockTotal,
  newId,
}
