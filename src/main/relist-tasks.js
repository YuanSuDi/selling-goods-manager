'use strict'

const { parseListingId } = require('../inventory-v2')

// 再出品タスクまわり: 参照 URL の正規化、重複チェック、タスク作成。
// 共有状態（managerServer / inventory / sendTaskList）は ctx 経由で
// 参照する。実体は background.js が持ち、getter で常に最新を返す。
function createRelistTasks(ctx) {
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
    if (!ctx.managerServer) return false
    const plat = platform === 'yahoo' ? 'yahoo' : 'mercari'
    const normalize = platformBinding(plat).normalize
    for (const t of ctx.managerServer.tasks.values()) {
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
    if (!ctx.managerServer || !record) return false
    for (const t of ctx.managerServer.tasks.values()) {
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
    if (!ctx.managerServer) throw new Error('連携サーバが起動していません')
    if (!record || !record.listing_url) throw new Error('参照商品のURLが未設定です')
    if (hasActiveTaskForRecord(record)) {
      throw new Error('このレコードの出品タスクが既に実行待ちです')
    }
    if (hasActiveRelistTask(record.product_no, record.listing_url, record.platform)) {
      throw new Error('同じ商品番号または商品IDの出品タスクが既に実行待ちです')
    }
    const task = ctx.managerServer.addTask({
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
    ctx.sendTaskList()
    return task
  }

  // 参照商品をブラウザでコピーして再出品するタスクを作る。
  // v0.2.0: 対応する出品レコードがあればレコード経由で作る。
  async function createRelistTask(product, autoSubmit, trigger, platform) {
    if (!ctx.managerServer) throw new Error('連携サーバが起動していません')
    const plat = platform === 'yahoo' ? 'yahoo' : 'mercari'
    const bind = platformBinding(plat)
    const itemUrl = bind.normalize(product[bind.refField])
    if (!itemUrl) throw new Error('参照商品のURLが未設定です')
    if (ctx.inventory) {
      const lid = parseListingId(plat, itemUrl)
      const record = lid ? await ctx.inventory.findRecordByListingId(plat, lid) : null
      if (record && record.product_no === product.product_no) {
        return createRelistTaskForRecord(record, autoSubmit, trigger)
      }
    }
    if (hasActiveRelistTask(product.product_no, itemUrl, plat)) {
      throw new Error('同じ商品番号または' + bind.label + '商品IDの出品タスクが既に実行待ちです')
    }
    const task = ctx.managerServer.addTask({
      product_no: product.product_no,
      platform: plat,
      type: 'relist',
      itemUrl,
      autoSubmit: !!autoSubmit,
      trigger: trigger || 'manual',
    })
    ctx.sendTaskList()
    return task
  }

  return {
    normalizeMercariUrl,
    normalizeYahooUrl,
    platformBinding,
    hasActiveRelistTask,
    hasActiveTaskForRecord,
    createRelistTaskForRecord,
    createRelistTask,
  }
}

module.exports = { createRelistTasks }
