'use strict'

import { app, protocol, BrowserWindow, ipcMain,shell ,dialog,desktopCapturer, net, Menu, clipboard  } from 'electron'
import  fs   from 'fs'
import { exec  } from 'child_process'
import { pathToFileURL } from 'url'
import { pipeline } from 'stream/promises'
import { autoUpdater } from 'electron-updater'

// createProtocol の自前実装（旧 vue-cli-plugin-electron-builder/lib の置き換え）。
// 新しい Electron では registerFileProtocol が廃止されたため protocol.handle を使う。
// app:// へのリクエストを、アプリのフォルダ（__dirname）内のファイルで返す。
function createProtocol(scheme) {
  protocol.handle(scheme, (request) => {
    let filePath = '/index.html'
    try {
      const u = new URL(request.url)
      if (u.pathname && u.pathname !== '/') filePath = decodeURIComponent(u.pathname)
    } catch (e) {}
    return net.fetch(pathToFileURL(path.join(__dirname, filePath)).href)
  })
}
import axios from 'axios';
import path from 'path';
import puppeteer from 'puppeteer-core';
import crypto from 'crypto';
import Datastore from 'nedb';
import { createManagerServer } from './manager-server';
import { createInventoryV2, conditionStockTotal, parseListingId } from './inventory-v2';
import { productImagePathFromRequest } from './utils/product-image'
const { prepareUserDataDirectory } = require('./utils/user-data')


const isDevelopment = process.env.NODE_ENV !== 'production'
let db = null
let getAll = null
let tasksDb = null
let userDataDir = ''

function getChromiumExecutablePath() {
  const chromiumRelativePath = path.join(
    'app',
    '.local-chromium',
    'win64-1045629',
    'chrome-win',
    'chrome.exe'
  )
  const candidates = [
    path.join(path.dirname(app.getPath('exe')), chromiumRelativePath),
    path.join(app.getAppPath(), chromiumRelativePath),
    path.resolve(chromiumRelativePath),
  ]
  const executablePath = candidates.find((candidate) => fs.existsSync(candidate))
  if (!executablePath) {
    throw new Error('Bundled Chromium is missing. Expected app/.local-chromium/win64-1045629/chrome-win/chrome.exe.')
  }
  return executablePath
}

function reportImageWorkflowError(sender, operation, error) {
  console.error(`[${operation}] failed`, error)
  if (!sender || sender.isDestroyed()) return
  const detail = error && error.message ? error.message : String(error)
  sender.send('add_error_done', `${operation}失败：${detail}`)
}

// ---- 出品管理プログラム連携サーバ（FurimaCopy 拡張との通信、v0.9.0） --------
// localhost 専用の小さな HTTP サーバを立て、拡張機能へ「自動出品タスク」を
// 渡す。トークンは初回起動時に生成してユーザーデータ領域に保存する
// （拡張機能のポップアップに同じトークンを入力して使う）。
// タスクは tasks.db にも保存し、再起動時に pending 分を復元する。
let managerServer = null
let managerInfo = { port: 17341, token: '', running: false }

// ---- v0.2.0: 状態・出品レコード・ノードのデータ層 -------------------------
let inventory = null
let conditionsDb = null
let listingsDb = null
let nodesDb = null
let defaultConditionId = null
// サーバの可視判定用に、ノード名をメモリにも持つ（DB が正）。
const nodeInfoCache = new Map()

function dbFindOne(dbInst, query) {
  return new Promise((resolve, reject) => {
    dbInst.findOne(query, (err, doc) => (err ? reject(err) : resolve(doc)))
  })
}
function dbUpdate(dbInst, query, upd) {
  return new Promise((resolve, reject) => {
    dbInst.update(query, upd, {}, (err, n) => (err ? reject(err) : resolve(n)))
  })
}

// 商品の状態別在庫を書き換え、sku（合計）も同期する。
async function setConditionStock(product, conditionId, nextStock) {
  const stockMap = Object.assign({}, product.condition_stock || {})
  stockMap[conditionId] = Math.max(0, Number(nextStock || 0))
  const total = Object.values(stockMap).reduce((a, b) => a + Math.max(0, Number(b || 0)), 0)
  await dbUpdate(db, { product_no: product.product_no }, { $set: { condition_stock: stockMap, sku: total } })
  return total
}

// Mercari の参照商品 URL を正規化する。完全な URL でも、m から始まる
// 商品 ID だけでも受け付ける。解釈できなければ null。
function normalizeMercariUrl(input) {
  if (!input) return null
  const s = String(input).trim()
  const m = s.match(/jp\.mercari\.com\/item\/(m\d+)/) || s.match(/^(m\d+)$/)
  return m ? 'https://jp.mercari.com/item/' + m[1] : null
}

// Yahoo!オークションの参照商品 URL を正規化する。完全な URL でも、
// オークション ID（英字0〜1文字+数字。古い商品は数字のみ）だけでも
// 受け付ける。解釈できなければ null。
function normalizeYahooUrl(input) {
  if (!input) return null
  const s = String(input).trim()
  const m =
    s.match(/auctions\.yahoo\.co\.jp\/jp\/auction\/([a-z]?\d+)/) ||
    s.match(/^([a-z]?\d+)$/)
  return m ? 'https://auctions.yahoo.co.jp/jp/auction/' + m[1] : null
}

// プラットフォームごとの参照まわりの対応表。
function platformBinding(platform) {
  return platform === 'yahoo'
    ? {
        refField: 'yahoo_ref',
        autoField: 'yahoo_auto_restock',
        errorField: 'yahoo_list_error',
        dedupeField: 'last_processed_yahoo_sale_item_id',
        normalize: normalizeYahooUrl,
        refSegment: 'auction/',
        label: 'Yahoo!オークション',
      }
    : {
        refField: 'mercari_ref',
        autoField: 'auto_restock',
        errorField: 'list_error',
        dedupeField: 'last_processed_sale_item_id',
        normalize: normalizeMercariUrl,
        refSegment: 'item/',
        label: 'Mercari',
      }
}

// 同じプラットフォームで、同じ商品番号または同じ商品IDの再出品タスクが
// 実行待ち・実行中なら true（別プラットフォームのタスクとは競合しない）。
function hasActiveRelistTask(product_no, itemUrl, platform) {
  if (!managerServer) return false
  const plat = platform === 'yahoo' ? 'yahoo' : 'mercari'
  const normalize = platformBinding(plat).normalize
  for (const t of managerServer.tasks.values()) {
    if (
      t.type === 'relist' &&
      (t.platform || 'mercari') === plat &&
      (t.status === 'pending' || t.status === 'running') &&
      (
        (product_no != null && t.product_no === product_no) ||
        (itemUrl && normalize(t.itemUrl) === itemUrl)
      )
    ) {
      return true
    }
  }
  return false
}

// 出品レコード単位で「実行待ち・実行中」の再出品タスクがあるか。
function hasActiveTaskForRecord(record) {
  if (!managerServer || !record) return false
  for (const t of managerServer.tasks.values()) {
    if (
      t.type === 'relist' &&
      (t.status === 'pending' || t.status === 'running') &&
      t.listing_id === record._id
    ) {
      return true
    }
  }
  return false
}

// 出品レコードから再出品タスクを作る（v0.2.0 の正規ルート）。
// タスクにはレコード ID と担当ノードを引き継ぐ。
function createRelistTaskForRecord(record, autoSubmit, trigger) {
  if (!managerServer) throw new Error('連携サーバが起動していません')
  if (!record || !record.listing_url) throw new Error('参照商品のURLが未設定です')
  if (hasActiveTaskForRecord(record)) {
    throw new Error('このレコードの出品タスクが既に実行待ちです')
  }
  if (hasActiveRelistTask(record.product_no, record.listing_url, record.platform)) {
    throw new Error('同じ商品番号または商品IDの出品タスクが既に実行待ちです')
  }
  const task = managerServer.addTask({
    product_no: record.product_no,
    platform: record.platform,
    type: 'relist',
    itemUrl: record.listing_url,
    autoSubmit: !!autoSubmit,
    trigger: trigger || 'manual',
    condition_id: record.condition_id,
    listing_id: record._id,
    node_id: record.node_id || '',
  })
  sendTaskList()
  return task
}

// 参照商品をブラウザでコピーして再出品するタスクを作る。
// v0.2.0: 対応する出品レコードがあればレコード経由で作る。
async function createRelistTask(product, autoSubmit, trigger, platform) {
  if (!managerServer) throw new Error('連携サーバが起動していません')
  const plat = platform === 'yahoo' ? 'yahoo' : 'mercari'
  const bind = platformBinding(plat)
  const itemUrl = bind.normalize(product[bind.refField])
  if (!itemUrl) throw new Error('参照商品のURLが未設定です')
  if (inventory) {
    const lid = parseListingId(plat, itemUrl)
    const record = lid ? await inventory.findRecordByListingId(plat, lid) : null
    if (record && record.product_no === product.product_no) {
      return createRelistTaskForRecord(record, autoSubmit, trigger)
    }
  }
  if (hasActiveRelistTask(product.product_no, itemUrl, plat)) {
    throw new Error('同じ商品番号または' + bind.label + '商品IDの出品タスクが既に実行待ちです')
  }
  const task = managerServer.addTask({
    product_no: product.product_no,
    platform: plat,
    type: 'relist',
    itemUrl,
    autoSubmit: !!autoSubmit,
    trigger: trigger || 'manual',
  })
  sendTaskList()
  return task
}

// 商品データの変更後、レンダラが現在の検索条件で再取得できるよう通知する。
function refreshRenderer() {
  if (window && !window.isDestroyed()) {
    window.webContents.send('products_updated', getAll())
  }
}

// レンダラーへ最新のタスク一覧を送る（タスク管理画面用）
function sendTaskList() {
  if (!window || window.isDestroyed()) return
  const list = managerServer
    ? [...managerServer.tasks.values()].sort((a, b) =>
        String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
      )
    : []
  window.webContents.send('tasks_list', list)
}

// レンダラーへ状態・レコード・ノードの一覧を送る（v0.2.0 UI 用）。
async function sendInventoryMeta() {
  if (!inventory || !window || window.isDestroyed()) return
  try {
    const [conditions, listings, nodes] = await Promise.all([
      inventory.listConditions(),
      inventory.listListings(),
      inventory.listNodes(),
    ])
    window.webContents.send('inventory_meta', { conditions, listings, nodes })
  } catch (e) {
    console.error('[manager] failed to send inventory meta', e)
  }
}

// 従来のバインドモーダル（プラットフォーム別）からの保存を、レコード
// 方式へ読み替える。対象は指定状態（既定は既定状態）の先頭レコード。
// 既定状態のレコードは旧フィールドへも二重書きする。
async function saveBindingFromIpc(platform, data) {
  const bind = platformBinding(platform)
  const productNo = String((data && data.product_no) || '').trim()
  const rawItemUrl = String((data && data.itemUrl) || '').trim()
  const itemUrl = rawItemUrl ? bind.normalize(rawItemUrl) : null
  const autoRestock = !!(data && data.auto_restock)
  if (!productNo) return { ok: false, error: '商品管理番号が指定されていません。' }
  if ((rawItemUrl && !itemUrl) || (autoRestock && !itemUrl)) {
    return {
      ok: false,
      error:
        platform === 'yahoo'
          ? '有効な Yahoo!オークション商品 URL またはオークション ID を入力してください。'
          : '有効な Mercari 商品 URL または商品 ID を入力してください。',
    }
  }
  if (!inventory || !defaultConditionId) return { ok: false, error: 'データ層が初期化されていません。' }
  const product = await dbFindOne(db, { product_no: productNo })
  if (!product) return { ok: false, error: '商品が見つかりません。' }
  const condId = (data && data.condition_id) || defaultConditionId
  const records = (await inventory.listListings(productNo)).filter(
    (r) => r.platform === platform && r.condition_id === condId
  )
  if (!itemUrl) {
    if (records.length > 1) {
      return { ok: false, error: 'この状態には複数のレコードがあります。参照詳細から削除してください。' }
    }
    if (records.length === 1) await inventory.deleteListing(records[0]._id)
    if (condId === defaultConditionId) {
      await dbUpdate(db, { product_no: productNo }, { $set: { [bind.refField]: null, [bind.autoField]: false } })
    }
    return { ok: true, itemUrl: null, autoRestock: false }
  }
  const saved = records.length
    ? await inventory.saveListing({
        id: records[0]._id,
        product_no: productNo,
        condition_id: condId,
        platform,
        itemUrl,
        auto_restock: autoRestock,
        node_id: data.node_id,
      })
    : await inventory.saveListing({
        product_no: productNo,
        condition_id: condId,
        platform,
        itemUrl,
        auto_restock: autoRestock,
        node_id: data.node_id,
      })
  if (!saved.ok) return { ok: false, error: saved.error }
  if (condId === defaultConditionId) {
    await dbUpdate(db, { product_no: productNo }, { $set: { [bind.refField]: itemUrl, [bind.autoField]: autoRestock } })
  }
  return { ok: true, itemUrl, autoRestock }
}

function startManagerServer() {
  if (managerServer) return
  const cfgPath = path.join(userDataDir, 'manager.json')
  let cfg = {}
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (!cfg.token) {
    cfg.token = crypto.randomBytes(16).toString('hex')
    cfg.port = cfg.port || 17341
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
  }
  managerInfo = { port: cfg.port || 17341, token: cfg.token, running: false }
  const persistTask = (task) => {
    tasksDb.update({ id: task.id }, task, { upsert: true }, () => {})
  }
  // レコード紐付きタスクの結果をレコードへ反映する（v0.2.0）。
  // 成功時は実行ノードをレコードの担当として記録する（出生バインド）。
  // 既定状態のレコードは旧フィールドへも二重書きし、旧版へ戻しても
  // 参照が壊れないようにする。
  const applyTaskResultToRecord = async (task, record) => {
    const bind = platformBinding(record.platform)
    const isDefaultRecord = record.condition_id === defaultConditionId
    const executedBy = (task.result && task.result.executedBy) || null
    const bornNode = record.node_id || executedBy || ''
    if (task.result && task.result.ok) {
      if (record.platform === 'yahoo') {
        await inventory.updateListing(record._id, { error: null, status: 'active', node_id: bornNode })
        if (isDefaultRecord) {
          const listingUrl = normalizeYahooUrl(task.result.listingUrl) || record.listing_url
          db.update(
            { product_no: record.product_no },
            { $set: { yahoo_ref: listingUrl, yahoo_list_error: null } },
            () => refreshRenderer()
          )
        } else refreshRenderer()
        return
      }
      const listingUrl = normalizeMercariUrl(task.result.listingUrl)
      const sourceUrl = normalizeMercariUrl(task.itemUrl)
      if (!listingUrl || listingUrl === sourceUrl) {
        const detail = task.result.message &&
          !String(task.result.message).includes('参照 URL は更新されていません')
          ? ' ' + task.result.message
          : ''
        const msg = '出品結果の URL が無効または参照元と同一のため、参照 URL は更新されていません。' + detail
        await inventory.updateListing(record._id, { error: msg, status: 'error' })
        if (isDefaultRecord) {
          db.update(
            { product_no: record.product_no },
            { $set: { list_error: msg } },
            () => refreshRenderer()
          )
        } else refreshRenderer()
        return
      }
      await inventory.updateListing(record._id, {
        listing_id: parseListingId('mercari', listingUrl),
        listing_url: listingUrl,
        error: null,
        status: 'active',
        node_id: bornNode,
      })
      if (isDefaultRecord) {
        db.update(
          { product_no: record.product_no },
          { $set: { mercari_ref: listingUrl, list_error: null } },
          () => refreshRenderer()
        )
      } else refreshRenderer()
    } else {
      const msg = (task.result && task.result.message) || '出品に失敗しました'
      await inventory.updateListing(record._id, { error: msg, status: 'error' })
      if (isDefaultRecord) {
        db.update(
          { product_no: record.product_no },
          { $set: { [bind.errorField]: msg } },
          () => refreshRenderer()
        )
      } else refreshRenderer()
    }
  }

  // 再出品タスクの結果を受けたら、商品の参照 URL を新しい出品 URL で
  // 上書きする（成功時）。失敗時はエラー内容を商品に残し、自動では
  // 再試行しない（次は手動で出品し直す）。
  // v0.2.0: レコード紐付きタスクはレコードへ、それ以外は従来処理へ。
  const handleTaskResult = async (task) => {
    if (inventory && task && task.type === 'relist' && task.listing_id) {
      const record = await inventory.getListing(task.listing_id)
      if (record) {
        persistTask(task)
        sendTaskList()
        await applyTaskResultToRecord(task, record)
        sendInventoryMeta()
        return
      }
    }
    handleTaskResultLegacy(task)
  }
  const handleTaskResultLegacy = (task) => {
    persistTask(task)
    sendTaskList()
    if (!task || task.type !== 'relist' || !task.product_no) return
    if (task.platform === 'yahoo') {
      // ヤフオクの再出品は同じオークション ID を使い回すため、成功しても
      // 参照 URL は実質そのまま（新しい ID への差し替えは起きない）。
      if (task.result && task.result.ok) {
        const listingUrl =
          normalizeYahooUrl(task.result.listingUrl) || normalizeYahooUrl(task.itemUrl)
        const $set = { yahoo_list_error: null }
        if (listingUrl) $set.yahoo_ref = listingUrl
        db.update({ product_no: task.product_no }, { $set }, () => refreshRenderer())
      } else {
        const msg = (task.result && task.result.message) || '出品に失敗しました'
        db.update(
          { product_no: task.product_no },
          { $set: { yahoo_list_error: msg } },
          () => refreshRenderer()
        )
      }
      return
    }
    if (task.result && task.result.ok) {
      const listingUrl = normalizeMercariUrl(task.result.listingUrl)
      const sourceUrl = normalizeMercariUrl(task.itemUrl)
      if (!listingUrl || listingUrl === sourceUrl) {
        const detail = task.result.message &&
          !String(task.result.message).includes('参照 URL は更新されていません')
          ? ' ' + task.result.message
          : ''
        const msg = '出品結果の URL が無効または参照元と同一のため、参照 URL は更新されていません。' + detail
        db.update(
          { product_no: task.product_no },
          { $set: { list_error: msg } },
          () => refreshRenderer()
        )
        return
      }
      db.update(
        { product_no: task.product_no },
        {
          $set: {
            mercari_ref: listingUrl,
            list_error: null,
          },
        },
        () => refreshRenderer()
      )
    } else {
      const msg = (task.result && task.result.message) || '出品に失敗しました'
      db.update(
        { product_no: task.product_no },
        { $set: { list_error: msg } },
        () => refreshRenderer()
      )
    }
  }
  // v0.2.0 の売却処理: 出品レコードを商品 ID で引き当て、そのレコードが
  // 属する状態の在庫を引く。報告ノードとレコードの担当が食い違う場合は
  // 自動で書き換えず、レンダラへ較正提案（node_mismatch）を送る。
  const handleSaleReported = async (sale) => {
    if (!inventory) return handleSaleReportedLegacy(sale)
    const itemId = String(sale.itemId || '')
    if (!itemId) return { ok: false, matched: false }
    const platform = sale.platform === 'yahoo' ? 'yahoo' : 'mercari'
    const bind = platformBinding(platform)
    let record = await inventory.findRecordByListingId(platform, itemId)
    let product = record ? await dbFindOne(db, { product_no: record.product_no }) : null
    if (!record || !product) {
      // 保険: 移行漏れ（参照だけあってレコードがない）の場合は、その場で
      // レコードを作ってから処理する。
      const escapedItemId = itemId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      product = await dbFindOne(db, {
        [bind.refField]: new RegExp(
          '(?:^|/)' + bind.refSegment + escapedItemId + '(?:[/?#]|$)|^' + escapedItemId + '$',
          'i'
        ),
      })
      if (!product) return { ok: true, matched: false, itemId }
      const saved = await inventory.saveListing({
        product_no: product.product_no,
        platform,
        itemUrl: bind.normalize(product[bind.refField]),
        auto_restock: !!product[bind.autoField],
      })
      if (!saved.ok) return { ok: true, matched: false, itemId }
      record = saved.listing
      // 移行時と同じく、処理済み ID とエラーも引き継ぐ。
      await inventory.updateListing(record._id, {
        last_processed_sale_item_id: product[bind.dedupeField] || null,
        error: product[bind.errorField] || null,
        status: product[bind.errorField] ? 'error' : 'active',
      })
      record = await inventory.getListing(record._id)
    }

    if (record.last_processed_sale_item_id === itemId) {
      return { ok: true, matched: true, duplicate: true, itemId, product_no: product.product_no }
    }

    // レコード側の原子的ガード（スキャン多重報告・競合対策）。
    const newSoldCount = Number(record.sold_count || 0) + 1
    const guard = await dbUpdate(
      listingsDb,
      { _id: record._id, last_processed_sale_item_id: { $ne: itemId } },
      {
        $set: {
          last_processed_sale_item_id: itemId,
          sold_count: newSoldCount,
          error: null,
          status: 'active',
          updatedAt: new Date().toISOString(),
        },
      }
    )
    if (!guard) {
      return { ok: true, matched: true, duplicate: true, itemId, product_no: product.product_no }
    }

    const condId = record.condition_id
    const stockMap = Object.assign({}, product.condition_stock || {})
    stockMap[condId] = Math.max(0, Number(stockMap[condId] || 0) - 1)
    const newCondStock = stockMap[condId]
    const newSku = Object.values(stockMap).reduce((a, b) => a + Math.max(0, Number(b || 0)), 0)
    const soldMap = Object.assign({}, product.condition_sold || {})
    soldMap[condId] = Number(soldMap[condId] || 0) + 1
    const newSoldNum = Number(product.selled_num || 0) + 1
    const $set = {
      condition_stock: stockMap,
      condition_sold: soldMap,
      sku: newSku,
      selled_num: newSoldNum,
    }
    if (condId === defaultConditionId) {
      $set[bind.errorField] = null
      $set[bind.dedupeField] = itemId
    }
    await dbUpdate(db, { product_no: product.product_no }, { $set })

    // ノード較正: 未割当なら報告ノードを担当として採用する（スキャンは
    // 自分のアカウントしか見えないため、報告者＝所有者の証明になる）。
    // 割当済みと食い違う場合は書き換えず、提案だけ送る。
    const reporter = sale.nodeId || null
    const updatedRecord = Object.assign({}, record, {
      sold_count: newSoldCount,
      last_processed_sale_item_id: itemId,
    })
    if (reporter && !record.node_id) {
      await inventory.updateListing(record._id, { node_id: reporter })
      updatedRecord.node_id = reporter
      sendInventoryMeta()
    } else if (reporter && record.node_id && reporter !== record.node_id) {
      if (window && !window.isDestroyed()) {
        window.webContents.send('node_mismatch', {
          product_no: product.product_no,
          platform,
          listing_record_id: record._id,
          listing_id: itemId,
          record_node_id: record.node_id,
          record_node_name: (nodeInfoCache.get(record.node_id) || {}).name || null,
          reported_node_id: reporter,
          reported_node_name: (nodeInfoCache.get(reporter) || {}).name || null,
        })
      }
    }

    const quotaOk = record.quota == null || newSoldCount < Number(record.quota)
    if (newCondStock > 0 && record.auto_restock && quotaOk) {
      try {
        createRelistTaskForRecord(updatedRecord, true, platform === 'yahoo' ? 'yahoo-sold' : 'mercari-todo')
      } catch (e) {
        console.warn('[manager] sale restock skipped:', e && e.message)
      }
    }
    refreshRenderer()
    if (window && !window.isDestroyed()) {
      window.webContents.send('sale_reported', {
        ok: true,
        platform,
        itemId,
        product_no: product.product_no,
        condition_id: condId,
        sku: newSku,
        selled_num: newSoldNum,
      })
    }
    return { ok: true, matched: true, product_no: product.product_no, sku: newSku, selled_num: newSoldNum }
  }

  // 所有権の自己申告（認領）: スキャンしたノードが「この出品は自分の
  // アカウントのものだ」と申告してきたら、未割当レコードの担当にする。
  // 割当済みのレコードは奪わない。
  const handleOwnershipClaim = async (claim) => {
    if (!inventory || !claim || !claim.nodeId) return { ok: false, assigned: false }
    const record = await inventory.findRecordByListingId(claim.platform, claim.listingId)
    if (!record) return { ok: true, assigned: false }
    if (record.node_id === claim.nodeId) return { ok: true, assigned: true, already: true }
    if (record.node_id) return { ok: true, assigned: false, conflict: true }
    await inventory.updateListing(record._id, { node_id: claim.nodeId })
    return { ok: true, assigned: true, product_no: record.product_no }
  }

  const handleSaleReportedLegacy = async (sale) => {
    const itemId = String(sale.itemId || '')
    if (!itemId) return { ok: false, matched: false }
    const platform = sale.platform === 'yahoo' ? 'yahoo' : 'mercari'
    const bind = platformBinding(platform)
    const escapedItemId = itemId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const product = await new Promise((resolve, reject) => {
      db.findOne(
        {
          [bind.refField]: new RegExp(
            '(?:^|/)' + bind.refSegment + escapedItemId + '(?:[/?#]|$)|^' + escapedItemId + '$',
            'i'
          ),
        },
        (err, doc) => err ? reject(err) : resolve(doc)
      )
    })
    if (!product) return { ok: true, matched: false, itemId }

    // 同じ出品は一度しか売れないため、処理済みの商品 ID の売却報告は
    // 二度目以降を在庫に反映しない（発送までやることリストに残り続け、
    // スキャンが繰り返し報告しても二重に引かないようにする）。
    if (product[bind.dedupeField] === itemId) {
      return { ok: true, matched: true, duplicate: true, itemId, product_no: product.product_no }
    }

    const newSku = Math.max(0, Number(product.sku || 0) - 1)
    const newSoldNum = Number(product.selled_num || 0) + 1
    const updatedCount = await new Promise((resolve, reject) => {
      db.update(
        {
          product_no: product.product_no,
          [bind.refField]: product[bind.refField],
          [bind.dedupeField]: { $ne: itemId },
        },
        {
          $set: {
            sku: newSku,
            selled_num: newSoldNum,
            [bind.errorField]: null,
            [bind.dedupeField]: itemId,
          },
        },
        {},
        (err, count) => err ? reject(err) : resolve(count)
      )
    })
    if (!updatedCount) {
      return { ok: true, matched: false, itemId }
    }
    if (newSku > 0 && product[bind.autoField] && product[bind.refField]) {
      try {
        createRelistTask(
          Object.assign({}, product, { sku: newSku, selled_num: newSoldNum }),
          true,
          platform === 'yahoo' ? 'yahoo-sold' : 'mercari-todo',
          platform
        )
      } catch (e) {
        console.warn('[manager] sale restock skipped:', e && e.message)
      }
    }
    refreshRenderer()
    if (window && !window.isDestroyed()) {
      window.webContents.send('sale_reported', {
        ok: true,
        platform,
        itemId,
        product_no: product.product_no,
        sku: newSku,
        selled_num: newSoldNum,
      })
    }
    return { ok: true, matched: true, product_no: product.product_no, sku: newSku, selled_num: newSoldNum }
  }
  managerServer = createManagerServer({
    port: managerInfo.port,
    token: managerInfo.token,
    imageRoots: [],
    onTaskCreated: persistTask,
    onTaskResult: handleTaskResult,
    onSaleReported: handleSaleReported,
    onTaskReleased: (task) => {
      persistTask(task)
      sendTaskList()
    },
    onNodeSeen: (nodeId) => {
      if (!inventory) return
      const isNewNode = !nodeInfoCache.has(nodeId)
      inventory
        .touchNode(nodeId)
        .then((n) => {
          if (n) nodeInfoCache.set(nodeId, { id: nodeId, name: n.name || null })
          if (isNewNode) sendInventoryMeta()
        })
        .catch(() => {})
    },
    getNodeInfo: (nodeId) => nodeInfoCache.get(nodeId) || null,
    onOwnershipClaim: async (claim) => {
      const r = await handleOwnershipClaim(claim)
      if (r && r.assigned) sendInventoryMeta()
      return r
    },
  })
  managerServer.listen().then(() => {
    managerInfo.running = true
    console.log('[manager] listening on 127.0.0.1:' + managerInfo.port)
    // 全状態のタスクを復元する（claim できるのは pending のみ）。
    // タスク管理画面で履歴も見られるようにするため。
    tasksDb.find({}, (err, docs) => {
      if (!err && docs) docs.forEach((t) => managerServer.restore(t))
    })
  }).catch((e) => console.error('[manager] listen failed', e))
}
// Scheme must be registered before the app is ready
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { secure: true, standard: true } },
  { scheme: 'imgp', privileges: { secure: true, standard: true } }
])
let window
async function createWindow() {

  // Create the browser window.
  const windowTitle = `商品管理程序 v${app.getVersion()}`
  window = new BrowserWindow({
    width: 1380,
    height: 1000,
    title: windowTitle,
    webPreferences: {
      nodeIntegration:true,
      contextIsolation: false,
      sandbox: false,
      preload: path.join(__static, 'preload.js')
    },
    icon:path.join(__static, "app.ico"),
    autoHideMenuBar: true
  })
  window.on('page-title-updated', (event) => {
    event.preventDefault()
    window.setTitle(windowTitle)
  })

  // 右クリックメニュー。Electron はブラウザと違い標準でコンテキスト
  // メニューを出さないため、ここで自前に付ける。入力欄では編集セット、
  // それ以外の場所でも「テキストを選択中ならコピー」「リンクなら
  // アドレスをコピー」「画像なら画像をコピー」を出す。
  window.webContents.on('context-menu', (e, params) => {
    const { isEditable, selectionText, editFlags, mediaType, srcURL, linkURL, x, y } = params
    const hasSelection = !!selectionText && selectionText.trim().length > 0
    const template = []
    if (mediaType === 'image' && srcURL) {
      template.push({
        label: '画像をコピー',
        click: () => window.webContents.copyImageAt(x, y),
      })
    }
    if (linkURL) {
      template.push({
        label: 'リンクのアドレスをコピー',
        click: () => clipboard.writeText(linkURL),
      })
    }
    if (template.length) template.push({ type: 'separator' })
    if (isEditable) {
      template.push(
        { label: '切り取り', role: 'cut', enabled: !!editFlags.canCut },
        { label: 'コピー', role: 'copy', enabled: !!editFlags.canCopy },
        { label: '貼り付け', role: 'paste', enabled: !!editFlags.canPaste },
        { type: 'separator' },
        { label: 'すべて選択', role: 'selectAll', enabled: !!editFlags.canSelectAll }
      )
    } else if (hasSelection) {
      template.push({ label: 'コピー', role: 'copy', enabled: !!editFlags.canCopy })
    }
    if (!template.length) return
    Menu.buildFromTemplate(template).popup({ window })
  })
  // 商品检索

  ipcMain.on('ping', (e, args) => {
    e.sender.send('pong', getAll())
  })

  //新增
  ipcMain.on('add_product_data', (e, data) => {
    db.findOne({product_no:data.product_no}, async (e1, data1) => {
      if(data1 != null) {
        e.sender.send('add_error_done', `商品管理番号：${data1.product_no}が存在してます。`)
      } else {
          if (defaultConditionId && !data.condition_stock) {
            data.condition_stock = { [defaultConditionId]: Math.max(0, Number(data.sku || 0)) }
            data.condition_sold = { [defaultConditionId]: Math.max(0, Number(data.selled_num || 0)) }
          }
          db.insert(data, function(err, doc) {
            e.sender.send('product_added', getAll())
          })
      }
    });
  })

  //删除
  ipcMain.on('deleteItem', (e, data) => {
    db.remove({product_no: data}, function (err, num) {
      e.sender.send('products_updated', getAll())
    })
  })

  ipcMain.on('add_speed_product_data', (e, data) => {
    //番号が存在するチェック
    db.findOne({product_no:data.product_no}, (findError, data1) => {
      if (findError) {
        reportImageWorkflowError(e.sender, '快速追加', findError)
        return
      }
      if(data1 != null) {
        e.sender.send('add_error_done', `商品管理番号：${data1.product_no}が存在してます。`)
      } else {
        if(data.product_no == "" || data.amazon_url == "" || data .product_img_dir == "") {
          e.sender.send('add_error_done', "商品管理番号、Amazon商品リンク、写真パスを全部入力してください。")
        } else {
          ;(async () => {
            try {
              const downData = await downloadImg(data.amazon_url, data.product_img_dir)
              data.product_img = downData.mainImgPath
              data.product_name = downData.title
              data.product_content = downData.content
              data.amazon_price = downData.price
              if (defaultConditionId && !data.condition_stock) {
                data.condition_stock = { [defaultConditionId]: Math.max(0, Number(data.sku || 0)) }
                data.condition_sold = { [defaultConditionId]: Math.max(0, Number(data.selled_num || 0)) }
              }
              db.insert(data, function(err) {
                if (err) {
                  reportImageWorkflowError(e.sender, '快速追加', err)
                } else if (!e.sender.isDestroyed()) {
                  e.sender.send('add_speed_product_data_success', getAll())
                }
              })
            } catch (error) {
              reportImageWorkflowError(e.sender, '快速追加', error)
            }
          })()
        }
      }
    });
  })

  ipcMain.on('download_image', (e, data) => {
    ;(async () => {
      try {
        if (!data || !data.amazon_url || !data.product_img_dir) {
          throw new Error('Amazon商品リンクと写真パスを入力してください。')
        }
        await onlyDownloadImg(data.amazon_url, data.product_img_dir)
        if (!e.sender.isDestroyed()) e.sender.send('download_image_done')
      } catch (error) {
        reportImageWorkflowError(e.sender, '商品画像ダウンロード', error)
      }
    })()
  })

  //按名称检索
  ipcMain.on('searchByName', (e, data) => {
    db.find({"$or":[{product_name: new RegExp(data, 'i')}, {product_content: new RegExp(data, 'i')}]}).sort({product_no:1}).exec((err, docs) => {
      if (err) {
        console.error('Error executing query:', err);
        return;
      }
      e.sender.send('pong', docs)
    });
  })

  //按编号检索
  ipcMain.on('searchByNo', (e, data) => {
    db.find({"$or":[{product_no: new RegExp(data, 'i')}] }).sort({product_no:1}).exec((err, docs) => {
      if (err) {
        console.error('Error executing query:', err);
        return;
      }
      e.sender.send('pong', docs)
    });
  })

  //按编号选择
  ipcMain.on('searchBySelectNo', (e, data) => {
    db.find({product_no: new RegExp(`^${data}\\d+.*`, 'i')}).sort({product_no:1}).exec((err, docs) => {
      if (err) {
        console.error('Error executing query:', err);
        return;
      }
      e.sender.send('pong', docs)
    });
  })

  //打开亚马逊链接
  ipcMain.on('url', (e, url) => {
    shell.openExternal(url);
  })

  //打开文件夹
  ipcMain.on('open_dir', (e, folderPath) => {
    openFolder(folderPath);
  })

  ipcMain.on('open_user_data_folder', async () => {
    try {
      const error = await shell.openPath(userDataDir)
      if (error) throw new Error(error)
    } catch (error) {
      console.error('[storage] failed to open user data folder', error)
      dialog.showErrorBox(
        '无法打开用户数据文件夹',
        error && error.message ? error.message : String(error)
      )
    }
  })

  ipcMain.on('select_main_image', async (e) => {
    const result = await dialog.showOpenDialog(window, {
      title: 'メイン商品画像を選択',
      properties: ['openFile'],
      filters: [{ name: '画像', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
    })
    if (!result.canceled && result.filePaths && result.filePaths[0]) {
      e.sender.send('main_image_selected', result.filePaths[0])
    }
  })

  //商品入库（v0.2.0: 状態別の在庫を絶対値で設定し、合計を sku に同期）
  ipcMain.on('addProductCount', async (e, data) => {
    try {
      const product = await dbFindOne(db, { product_no: data.product_no })
      if (!product) return
      const condId = data.condition_id || defaultConditionId
      if (!condId) return
      await setConditionStock(product, condId, data.sku)
      refreshRenderer()
    } catch (err) {
      console.error('[manager] addProductCount failed', err)
    }
  })

    //商品售出（v0.2.0: 状態を指定して、その状態の在庫を1つ引く。
    // 状態の解決: 明示指定 → 在庫がある状態が1つだけならそれ → 曖昧ならエラー）
  ipcMain.on('selledItem', async (e, data) => {
    try {
      const product = await dbFindOne(db, { product_no: data.product_no })
      if (!product) return
      const stockMap = product.condition_stock || {}
      let condId = data.condition_id || null
      if (!condId) {
        const stocked = Object.keys(stockMap).filter((k) => Number(stockMap[k] || 0) > 0)
        if (stocked.length === 1) condId = stocked[0]
        else if (defaultConditionId && Number(stockMap[defaultConditionId] || 0) > 0 && stocked.length === 0) condId = defaultConditionId
      }
      if (!condId) {
        e.sender.send('add_error_done', '売れた状態を選んでください。')
        refreshRenderer()
        return
      }
      const cur = Number(stockMap[condId] || 0)
      if (cur <= 0) {
        e.sender.send('add_error_done', 'その状態の在庫がありません。')
        refreshRenderer()
        return
      }
      const newCondStock = cur - 1
      const newTotal = await setConditionStock(product, condId, newCondStock)
      const soldMap = Object.assign({}, product.condition_sold || {})
      soldMap[condId] = Number(soldMap[condId] || 0) + 1
      const newSoldNum = Number(product.selled_num || 0) + 1
      await dbUpdate(db, { product_no: product.product_no }, { $set: { condition_sold: soldMap, selled_num: newSoldNum } })
      refreshRenderer()
      // 自動補充: その状態の Mercari レコードで自動補充 ON のものが
      // ちょうど1件なら、従来どおり自動で再出品タスクを作る。
      if (!managerServer || !inventory) return
      if (!(newCondStock > 0)) return
      const records = (await inventory.listListings(product.product_no)).filter(
        (r) => r.platform === 'mercari' && r.condition_id === condId && r.auto_restock
      )
      if (records.length === 1) {
        const record = records[0]
        const newRecordSold = Number(record.sold_count || 0) + 1
        await inventory.updateListing(record._id, {
          sold_count: newRecordSold,
          error: null,
          status: 'active',
        })
        if (record.quota != null && newRecordSold >= Number(record.quota)) return
        try {
          const task = createRelistTaskForRecord(record, true, 'manual-sale')
          if (window && !window.isDestroyed()) {
            window.webContents.send('list_task_created', { ok: true, task, auto: true })
          }
        } catch (err) {
          console.warn('[manager] auto restock skipped:', err && err.message)
        }
      } else if (records.length > 1) {
        e.sender.send('manual_sale_multi_record', { product_no: product.product_no, condition_id: condId })
      } else if (product.auto_restock && product.mercari_ref) {
        // レコードがない旧データ向けフォールバック
        try {
          const task = await createRelistTask(
            Object.assign({}, product, { sku: newTotal }),
            true,
            'manual-sale'
          )
          db.update({ product_no: product.product_no }, { $set: { list_error: null } })
          if (window && !window.isDestroyed()) {
            window.webContents.send('list_task_created', { ok: true, task, auto: true })
          }
        } catch (err) {
          console.warn('[manager] auto restock skipped:', err && err.message)
        }
      }
    } catch (err) {
      console.error('[manager] selledItem failed', err)
    }
  })

   //保存备注
   ipcMain.on('saveComment', (e, data) => {
    db.update({product_no: data.product_no}, {
      $set: {
        comment: data.comment,
      },
    })
  })

   //编辑商品情报
   ipcMain.on('editInfo', (e, data) => {
    const $set = {
      product_name: data.product_name,
      product_content: data.product_content,
      amazon_price: data.amazon_price,
       amazon_url: data.amazon_url,
    }
     if (data.product_img !== undefined) $set.product_img = data.product_img
    db.update({product_no: data.product_no}, { $set }, (err) => {
      if (err) console.error('[manager] failed to update product:', err)
      else refreshRenderer()
    })
  })

  //連携情報（ポートとトークン）を返す。拡張機能側の設定に使う。
  ipcMain.on('get_manager_info', (e) => {
    e.sender.send('manager_info', managerInfo)
  })

  ipcMain.on('bind_mercari_item', async (e, data) => {
    const result = await saveBindingFromIpc('mercari', data || {})
    if (result.ok) refreshRenderer()
    e.sender.send('mercari_binding_saved', result)
    sendInventoryMeta()
  })

  ipcMain.on('bind_yahoo_item', async (e, data) => {
    const result = await saveBindingFromIpc('yahoo', data || {})
    if (result.ok) refreshRenderer()
    e.sender.send('yahoo_binding_saved', result)
    sendInventoryMeta()
  })

  // ---- v0.2.0: 状態・レコード・ノード管理 IPC ----
  ipcMain.on('get_inventory_meta', () => {
    sendInventoryMeta()
  })

  ipcMain.on('condition_save', async (e, data) => {
    const result = inventory
      ? await inventory.saveCondition(data || {})
      : { ok: false, error: 'データ層が初期化されていません。' }
    e.sender.send('condition_result', result)
    if (result.ok) sendInventoryMeta()
  })

  ipcMain.on('condition_delete', async (e, data) => {
    const result = inventory
      ? await inventory.deleteCondition((data || {}).id)
      : { ok: false, error: 'データ層が初期化されていません。' }
    e.sender.send('condition_result', result)
    if (result.ok) sendInventoryMeta()
  })

  ipcMain.on('listing_save', async (e, data) => {
    const result = inventory
      ? await inventory.saveListing(data || {})
      : { ok: false, error: 'データ層が初期化されていません。' }
    if (result.ok && result.listing) {
      // 既定状態のレコードは旧フィールドへ二重書きする。
      const rec = result.listing
      if (rec.condition_id === defaultConditionId) {
        const bind = platformBinding(rec.platform)
        await dbUpdate(db, { product_no: rec.product_no }, {
          $set: { [bind.refField]: rec.listing_url, [bind.autoField]: !!rec.auto_restock },
        })
        refreshRenderer()
      }
    }
    e.sender.send('listing_result', result)
    if (result.ok) sendInventoryMeta()
  })

  ipcMain.on('listing_delete', async (e, data) => {
    const result = inventory
      ? await inventory.deleteListing((data || {}).id)
      : { ok: false, error: 'データ層が初期化されていません。' }
    if (result.ok && result.listing && result.listing.condition_id === defaultConditionId) {
      const bind = platformBinding(result.listing.platform)
      const rest = (await inventory.listListings(result.listing.product_no)).filter(
        (r) => r.platform === result.listing.platform && r.condition_id === defaultConditionId
      )
      if (!rest.length) {
        await dbUpdate(db, { product_no: result.listing.product_no }, {
          $set: { [bind.refField]: null, [bind.autoField]: false },
        })
        refreshRenderer()
      }
    }
    e.sender.send('listing_result', result)
    if (result.ok) sendInventoryMeta()
  })

  ipcMain.on('listing_relist', async (e, data) => {
    try {
      const record = inventory ? await inventory.getListing((data || {}).id) : null
      if (!record) {
        e.sender.send('listing_result', { ok: false, error: 'レコードが見つかりません。' })
        return
      }
      const product = await dbFindOne(db, { product_no: record.product_no })
      const condStock = product && product.condition_stock
        ? Number(product.condition_stock[record.condition_id] || 0)
        : 0
      if (!(condStock > 0)) {
        e.sender.send('listing_result', { ok: false, error: 'その状態の在庫がありません。' })
        return
      }
      const task = createRelistTaskForRecord(record, true, 'manual')
      e.sender.send('list_task_created', { ok: true, task, auto: false })
    } catch (err) {
      e.sender.send('listing_result', { ok: false, error: String((err && err.message) || err) })
    }
  })

  ipcMain.on('listing_claim', async (e, data) => {
    try {
      if (!managerServer) throw new Error('連携サーバが起動していません')
      const record = inventory ? await inventory.getListing((data || {}).id) : null
      if (!record) {
        e.sender.send('listing_result', { ok: false, error: 'レコードが見つかりません。' })
        return
      }
      for (const t of managerServer.tasks.values()) {
        if (t.type === 'verify' && t.listing_id === record._id && t.status === 'pending') {
          throw new Error('このレコードの所有権確認は既に実行待ちです')
        }
      }
      managerServer.addTask({
        product_no: record.product_no,
        platform: record.platform,
        type: 'verify',
        itemUrl: record.listing_url,
        autoSubmit: false,
        trigger: 'claim',
        condition_id: record.condition_id,
        listing_id: record._id,
        node_id: '*',
      })
      sendTaskList()
      e.sender.send('listing_result', { ok: true, claimed: true })
    } catch (err) {
      e.sender.send('listing_result', { ok: false, error: String((err && err.message) || err) })
    }
  })

  ipcMain.on('listing_fix_node', async (e, data) => {
    const result = inventory
      ? await inventory.updateListing((data || {}).id, { node_id: (data || {}).node_id || '' })
          .then((rec) => ({ ok: !!rec, listing: rec }))
          .catch((err) => ({ ok: false, error: String((err && err.message) || err) }))
      : { ok: false, error: 'データ層が初期化されていません。' }
    e.sender.send('listing_result', result)
    if (result.ok) sendInventoryMeta()
  })

  ipcMain.on('node_rename', async (e, data) => {
    const result = inventory
      ? await inventory.renameNode((data || {}).nodeId, (data || {}).name)
      : { ok: false, error: 'データ層が初期化されていません。' }
    if (result.ok && result.node) {
      nodeInfoCache.set(result.node._id, { id: result.node._id, name: result.node.name || null })
    }
    e.sender.send('node_result', result)
    if (result.ok) sendInventoryMeta()
  })

  ipcMain.on('node_delete', async (e, data) => {
    const result = inventory
      ? await inventory.deleteNode((data || {}).nodeId)
      : { ok: false, error: 'データ層が初期化されていません。' }
    if (result.ok) nodeInfoCache.delete((data || {}).nodeId)
    e.sender.send('node_result', result)
    if (result.ok) sendInventoryMeta()
  })

  //現在のタスク一覧を返す
  ipcMain.on('list_tasks', () => {
    sendTaskList()
  })

  // タスク停止: pending は拡張機能に渡らなくなる。running は既に拡張機能が
  // 処理中の可能性があるため状態だけ止める（結果が返れば通常どおり記録）。
  ipcMain.on('task_stop', (e, taskId) => {
    const task = managerServer && managerServer.tasks.get(taskId)
    if (task && (task.status === 'pending' || task.status === 'running')) {
      task.status = 'stopped'
      tasksDb.update({ id: task.id }, task, { upsert: true }, () => {})
      console.log('[manager] task stopped:', task.id)
    }
    sendTaskList()
  })

  // タスク起動: 停止中・失敗のタスクを pending に戻す（拡張機能が約1分
  // 以内に拾う）。同じ商品番号または Mercari 商品 ID に実行待ち/実行中の
  // 再出品がある場合は二重出品防止のため起動しない。
  ipcMain.on('task_start', (e, taskId) => {
    const task = managerServer && managerServer.tasks.get(taskId)
    if (task && (task.status === 'stopped' || task.status === 'failed')) {
      const bind = platformBinding(task.platform)
      const dup =
        task.type === 'relist' &&
        hasActiveRelistTask(
          task.product_no,
          bind.normalize(task.itemUrl),
          task.platform
        )
      if (!dup) {
        task.status = 'pending'
        tasksDb.update({ id: task.id }, task, { upsert: true }, () => {})
        console.log('[manager] task restarted:', task.id)
        if (task.type === 'relist' && task.product_no) {
          db.update(
            { product_no: task.product_no },
            { $set: { [bind.errorField]: null } },
            () => refreshRenderer()
          )
          if (inventory && task.listing_id) {
            inventory.updateListing(task.listing_id, { error: null, status: 'active' }).catch(() => {})
          }
        }
      } else {
        console.log('[manager] task start refused (active relist exists):', task.id)
      }
    }
    sendTaskList()
  })

  // タスク削除: 記録ごと消す。実行中だった場合、結果は記録されない。
  ipcMain.on('task_delete', (e, taskId) => {
    if (managerServer && managerServer.tasks.has(taskId)) {
      managerServer.tasks.delete(taskId)
      tasksDb.remove({ id: taskId }, {}, () => {})
      console.log('[manager] task deleted:', taskId)
    }
    sendTaskList()
  })
  if (process.env.WEBPACK_DEV_SERVER_URL) {
    // Load the url of the dev server if in development mode
    await window.loadURL(process.env.WEBPACK_DEV_SERVER_URL)
    if (!process.env.IS_TEST) window.webContents.openDevTools()
  } else {
    createProtocol('app')
    // Load the index.html when not in development
    window.loadURL('app://./index.html')
  }
}

// Quit when all windows are closed.
app.on('window-all-closed', () => {
  // On macOS it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  // On macOS it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

function findLegacyDataRoot() {
  const candidates = app.isPackaged
    ? [path.dirname(app.getPath('exe')), process.cwd()]
    : [process.cwd()]
  const roots = [...new Set(candidates.map((candidate) => path.resolve(candidate)))]
  const dataRoot = roots.find((root) => {
    const legacyData = path.join(root, 'userdata')
    return fs.existsSync(legacyData) && fs.readdirSync(legacyData).length > 0
  })
  return dataRoot || roots.find((root) => fs.existsSync(path.join(root, 'img'))) || roots[0]
}

let lastUpdaterError = ''
let lastUpdaterErrorAt = 0

function reportUpdaterError(error) {
  const detail = error && error.message ? error.message : String(error)
  const now = Date.now()
  if (detail === lastUpdaterError && now - lastUpdaterErrorAt < 2000) return
  lastUpdaterError = detail
  lastUpdaterErrorAt = now
  console.error('[updater] failed', error)
  const options = {
    type: 'warning',
    title: '更新检查失败',
    message: '暂时无法检查或下载更新。',
    detail,
    buttons: ['关闭'],
  }
  if (window && !window.isDestroyed()) {
    dialog.showMessageBox(window, options).catch((dialogError) => {
      console.error('[updater] failed to show error dialog', dialogError)
    })
  } else {
    dialog.showErrorBox(options.title, `${options.message}\n\n${detail}`)
  }
}

function setupAutoUpdater() {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false
  autoUpdater.on('update-available', (info) => {
    console.info(`[updater] version ${info.version} is available`)
  })
  autoUpdater.on('update-not-available', (info) => {
    console.info(`[updater] already on the latest version ${info.version}`)
  })
  autoUpdater.on('update-downloaded', (info) => {
    const options = {
      type: 'info',
      title: '更新已下载',
      message: `新版本 ${info.version} 已下载完成。`,
      detail: '现在重启安装，或稍后退出程序时自动安装。',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
    }
    const prompt = window && !window.isDestroyed()
      ? dialog.showMessageBox(window, options)
      : dialog.showMessageBox(options)
    prompt.then(({response}) => {
      if (response === 0) autoUpdater.quitAndInstall()
    }).catch((error) => {
      console.error('[updater] failed to show downloaded update dialog', error)
    })
  })
  autoUpdater.on('error', reportUpdaterError)
  autoUpdater.checkForUpdates().catch(reportUpdaterError)
}

// 二重起動防止：ロックを取れなかった側は即終了する（DB とポート 17341 の
// 二重使用を防ぐ）。二つ目が起動されたら既存ウィンドウを前面に出す。
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}
app.on('second-instance', () => {
  if (window) {
    if (window.isMinimized()) window.restore()
    if (!window.isVisible()) window.show()
    window.focus()
  }
})

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return
  const preparedData = await prepareUserDataDirectory(
    app.getPath('userData'),
    findLegacyDataRoot()
  )
  userDataDir = preparedData.dataDirectory
  if (preparedData.migrated) {
    console.info('[storage] Legacy user data copied to the application data directory')
  }
  const database = require('./nedb/db')
  db = database.initializeDatabase(userDataDir)
  getAll = database.getAll
  tasksDb = new Datastore({
    filename: path.join(userDataDir, 'tasks.db'),
    autoload: true,
  })
  // v0.2.0: 状態・出品レコード・ノードの各 DB を用意し、サーバ起動前に
  // 旧形式からの移行を済ませる（移行は冪等）。
  conditionsDb = new Datastore({
    filename: path.join(userDataDir, 'conditions.db'),
    autoload: true,
  })
  listingsDb = new Datastore({
    filename: path.join(userDataDir, 'listings.db'),
    autoload: true,
  })
  nodesDb = new Datastore({
    filename: path.join(userDataDir, 'nodes.db'),
    autoload: true,
  })
  inventory = createInventoryV2({
    productsDb: db,
    conditionsDb,
    listingsDb,
    nodesDb,
  })
  const migrationStats = await inventory.migrate()
  console.log('[manager] v0.2.0 migration:', JSON.stringify(migrationStats))
  const defaultCond = await inventory.ensureDefaultCondition()
  defaultConditionId = defaultCond._id
  const knownNodes = await inventory.listNodes()
  knownNodes.forEach((n) => nodeInfoCache.set(n._id, { id: n._id, name: n.name || null }))

  // Register before creating the window so renderer image requests cannot race
  // protocol setup.
  const contentTypes = {
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
  }
  const readImage = async (imagePath) => {
    const body = await fs.promises.readFile(imagePath)
    const contentType = contentTypes[path.extname(imagePath).toLowerCase()] || 'application/octet-stream'
    return new Response(body, { headers: { 'Content-Type': contentType } })
  }
  protocol.handle('imgp', async (request) => {
    try {
      const u = new URL(request.url)
      const requestPath = decodeURIComponent(u.pathname)
      const rel = requestPath.replace(/^\/+/, '')
      const absolutePath = productImagePathFromRequest(u.hostname, u.pathname)
      const productDirectory = u.searchParams.get('productDir')
      if (absolutePath) {
        if (fs.existsSync(absolutePath)) {
          return await readImage(absolutePath)
        }
      }
      if (!rel || rel.includes('..')) {
        return new Response('bad path', { status: 400 })
      }
      const candidates = [
        path.join(userDataDir, rel),
        path.resolve(rel),
        path.join(path.dirname(app.getPath('exe')), rel),
        path.join(app.getAppPath(), rel),
        path.resolve('..', rel),
      ]
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          return await readImage(p)
        }
      }
      if (productDirectory && path.isAbsolute(productDirectory)) {
        const productImagePath = path.join(productDirectory, path.basename(rel))
        if (fs.existsSync(productImagePath)) {
          return await readImage(productImagePath)
        }
      }
      console.warn('[imgp] image not found')
      return new Response('image not found', { status: 404 })
    } catch (e) {
      console.error('[imgp] failed', e)
      return new Response('image error', { status: 500 })
    }
  })

  startManagerServer()
  await createWindow()
  setupAutoUpdater()
}).catch((error) => {
  console.error('[startup] failed', error)
  const detail = error && error.message ? error.message : String(error)
  dialog.showErrorBox('启动失败', `无法安全准备应用数据：\n\n${detail}`)
  app.quit()
})

// Exit cleanly on request from parent process in development mode.
if (isDevelopment) {
  if (process.platform === 'win32') {
    process.on('message', (data) => {
      if (data === 'graceful-exit') {
        app.quit()
      }
    })
  } else {
    process.on('SIGTERM', () => {
      app.quit()
    })
  }
}


function openFolder(folderPath) {
  // 打开文件夹的命令，根据操作系统不同可能需要调整
  const openFolderCommand = process.platform === 'win32' ? 'start "" "' : 'open "';
  // 执行命令以打开文件夹
  exec(openFolderCommand.concat(folderPath).concat('"'), (err, stdout, stderr) => {
    if (err) {
      console.error('Error opening folder:', err);
      return;
    }
  });
}


async function downloadImg(url, folderPath) {
  let data = {title:"", content:"", mainImgPath:"", price:0};
  const ChromiumPath = getChromiumExecutablePath()
  const browser = await puppeteer.launch({
    executablePath:ChromiumPath
  });
  try {
  const page = await browser.newPage();
  await page.goto(url, { timeout: 30000 });
  await page.waitForSelector("#altImages > ul > li.imageThumbnail", { timeout: 30000 });

  //获取标题跟详情
  //#productTitle
  let productTitleEl = await page.$("#productTitle");
  let productTitle = await page.evaluate(el => el.innerHTML, productTitleEl)
  data.title  = productTitle.trim()
  //#feature-bullets > ul > li > span"
  let productContentEls = await page.$$("#feature-bullets > ul > li > span");
  let content = ""
  for (let index = 0; index < productContentEls.length; index++) {
    let tmpCtx = await page.evaluate(el => el.innerHTML, productContentEls[index])
    content = index === 0? tmpCtx:content.concat(`\n${tmpCtx}`)
  }
  data.content = content

  //#corePriceDisplay_desktop_feature_div > div.a-section.a-spacing-none.aok-align-center.aok-relative > span.a-price.aok-align-center.reinventPricePriceToPayMargin.priceToPay > span:nth-child(2) > span.a-price-whole
  let productPriceEl = await page.$$("#corePriceDisplay_desktop_feature_div > div.a-section.a-spacing-none.aok-align-center.aok-relative > span.a-price.aok-align-center.reinventPricePriceToPayMargin.priceToPay > span:nth-child(2) > span.a-price-whole");
  if(productPriceEl.length>0){
    let productPrice = await page.evaluate(el => el.innerHTML, productPriceEl[0])
    productPrice = productPrice.replace(",","")
    if(/^[\d]+$/.test(productPrice)) {
      data.price = Number(productPrice)
    } 
  }

  //点击加载大图
  let loadImgDiv = await page.$("#landingImage")
  loadImgDiv.click()
  //等待大图加载完毕
  await sleep(2000)
  let mainImg = await page.$("#ivLargeImage > img")
  let src = await page.evaluate(el => el.getAttribute('src'), mainImg)
  //console.log(src)
  //主图 #landingImage
  await downloadFile(src, folderPath)
  await downloadFile(src, path.join(userDataDir, 'img'))
  data.mainImgPath = "imgp://../img/".concat(src.split("/")[src.split("/").length-1])
  //获取点击列表
  let titles = await page.$$("#ivThumbs > div.ivRow>div.ivThumb");
  for (let index = 1; index < titles.length; index++) {
    titles[index].click();
    let selecter = "#ivLargeImage > img";
    //等待大图加载完毕
    await sleep(2000)
    let itemImg = await page.$(selecter)
    let src = await page.evaluate(el => el.getAttribute('src'), itemImg)
    //console.log(src)
    await downloadFile(src, folderPath)
  }

  return data
  } finally {
    await browser.close()
  }
}

//仅仅下载图片，不创建记录
async function onlyDownloadImg(url, folderPath) {
  let data = {title:"", content:"", price:0};
  const ChromiumPath = getChromiumExecutablePath()
  const browser = await puppeteer.launch({
    executablePath:ChromiumPath
  });
  try {
  const page = await browser.newPage();
  await page.goto(url, { timeout: 30000 });
  await page.waitForSelector("#altImages > ul > li.imageThumbnail", { timeout: 30000 });

  //获取标题跟详情
  //#productTitle
  let productTitleEl = await page.$("#productTitle");
  let productTitle = await page.evaluate(el => el.innerHTML, productTitleEl)
  data.title  = productTitle.trim()
  //#feature-bullets > ul > li > span"
  let productContentEls = await page.$$("#feature-bullets > ul > li > span");
  let content = ""
  for (let index = 0; index < productContentEls.length; index++) {
    let tmpCtx = await page.evaluate(el => el.innerHTML, productContentEls[index])
    content = index === 0? tmpCtx:content.concat(`${tmpCtx}
`)
  }
  data.content = content
  //#corePriceDisplay_desktop_feature_div > div.a-section.a-spacing-none.aok-align-center.aok-relative > span.a-price.aok-align-center.reinventPricePriceToPayMargin.priceToPay > span:nth-child(2) > span.a-price-whole
  let productPriceEl = await page.$$("#corePriceDisplay_desktop_feature_div > div.a-section.a-spacing-none.aok-align-center.aok-relative > span.a-price.aok-align-center.reinventPricePriceToPayMargin.priceToPay > span:nth-child(2) > span.a-price-whole");
  if(productPriceEl.length>0){
    let productPrice = await page.evaluate(el => el.innerHTML, productPriceEl[0])
    productPrice = productPrice.replace(",","")
    if(/^[\d]+$/.test(productPrice)) {
      data.price = Number(productPrice)
    } 
  }
  //点击加载大图
  let loadImgDiv = await page.$("#landingImage")
  loadImgDiv.click()
  //等待大图加载完毕
  await sleep(2000)
  let mainImg = await page.$("#ivLargeImage > img")
  let src = await page.evaluate(el => el.getAttribute('src'), mainImg)
  //console.log(src)
  //主图 #landingImage
  await downloadFile(src, folderPath)
  //获取点击列表
  let titles = await page.$$("#ivThumbs > div.ivRow>div.ivThumb");
  for (let index = 1; index < titles.length; index++) {
    titles[index].click();
    let selecter = "#ivLargeImage > img";
    //等待大图加载完毕
    await sleep(2000)
    let itemImg = await page.$(selecter)
    let src = await page.evaluate(el => el.getAttribute('src'), itemImg)
    //console.log(src)
    await downloadFile(src, folderPath)
  }

  //将商品详情写入文件
  await appendToFile(path.join(folderPath, "商品説明.txt"), url + "\n"+ data.title + "\n" + data.price + "\n" + data.content)
  } finally {
    await browser.close()
  }
}

async function sleep (time) {
  return new Promise((resolve) => setTimeout(resolve, time));
}

async function downloadFile(url, filePath) {
  await checkDir(filePath)
  const response = await axios({
    method: "get",
    url: url,
    responseType: "stream",
    timeout: 30000,
  })
  const fileName = url.split("/").pop()
  await pipeline(response.data, fs.createWriteStream(path.join(filePath, fileName)))
};

async function checkDir(folderPath) {
  const folders = folderPath.split("/"); // 拆分路径为文件夹数组
    let currentPath = '';

    for (const folder of folders) {
        currentPath = path.join(currentPath, folder); // 逐级拼接路径
        if (!currentPath.endsWith(":.")){
          currentPath=currentPath.replace(":",":\\")
        } 
    
        if (!fs.existsSync(currentPath)) {
            fs.mkdirSync(currentPath); // 如果文件夹不存在，创建它
        } 
    }
}

//将内容写入文本
async function appendToFile(filePath, content){
  await fs.promises.appendFile(filePath, content, 'utf8')
}



