'use strict'

// 自動下架まわり: 売却で在庫が減った結果「出品中リンク数 > 残在庫」に
// なった状態×商品について、余剰分の下架タスクを作る。
//
// ルール（2026-11-21 ユーザー確定）:
// - 対象はレコード単位の「自動下架」スイッチ（auto_delist）が ON の
//   出品中レコードだけ。OFF のレコードは数には入るが自動では触らない。
// - 残すのは「出品が新しい順」。犠牲は listed_at が古い順に選ぶ。
// - Mercari は出品を削除、Yahoo は入札ゼロなら取消し。入札がある場合は
//   拡張側が中止して報告し、ここでは「手動下架」エントリ（type:
//   'manual-delist', status: 'manual'）を作ってユーザー対応に回す。
//   status 'manual' のタスクは拡張へ配信されない（配信は pending のみ）。
// - 自動で消し切れなかった余剰（対象レコード不足）も手動エントリにする。
//
// 共有状態は ctx 経由（relist-tasks.js と同じ流儀）。
function createDelist(ctx) {
  function busyRecordIds() {
    const busy = new Set()
    if (!ctx.managerServer) return busy
    for (const t of ctx.managerServer.tasks.values()) {
      if ((t.status === 'pending' || t.status === 'running') && t.listing_id) {
        busy.add(t.listing_id)
      }
    }
    return busy
  }

  function hasActiveDelistTaskForRecord(record) {
    if (!ctx.managerServer || !record) return false
    for (const t of ctx.managerServer.tasks.values()) {
      if (
        t.type === 'delist' &&
        (t.status === 'pending' || t.status === 'running') &&
        t.listing_id === record._id
      ) {
        return true
      }
    }
    return false
  }

  // レコードの下架タスクを作る。Mercari=削除 / Yahoo=取消し（入札時は
  // 拡張が中止して hasBids で返す）。担当ノードはレコードの割当どおり。
  function createDelistTaskForRecord(record, trigger) {
    if (!ctx.managerServer) throw new Error('連携サーバが起動していません')
    if (!record || !record.listing_url) throw new Error('下架対象のURLが未設定です')
    if (hasActiveDelistTaskForRecord(record)) {
      throw new Error('このレコードの下架タスクが既に実行待ちです')
    }
    const task = ctx.managerServer.addTask({
      product_no: record.product_no,
      platform: record.platform,
      type: 'delist',
      itemUrl: record.listing_url,
      autoSubmit: true,
      trigger: trigger || 'auto-delist',
      condition_id: record.condition_id,
      listing_id: record._id,
      node_id: record.node_id || '',
    })
    ctx.persistTask(task)
    ctx.sendTaskList()
    return task
  }

  // 「手動下架」エントリ: 拡張には渡らない、ユーザーが処理するまで
  // タスク一覧に残り続ける注意喚起。同じ対象に重複して作らない。
  function ensureManualDelistEntry(opts) {
    if (!ctx.managerServer) return null
    const productNo = opts.product_no
    const recordId = opts.record ? opts.record._id : null
    for (const t of ctx.managerServer.tasks.values()) {
      if (t.type !== 'manual-delist' || t.status !== 'manual') continue
      if (t.product_no !== productNo) continue
      if (recordId && t.listing_id === recordId) return t
      if (!recordId && !t.listing_id && t.condition_id === (opts.condition_id || null)) return t
    }
    const task = ctx.managerServer.addTask({
      product_no: productNo,
      platform: opts.record ? opts.record.platform : opts.platform || 'mercari',
      type: 'manual-delist',
      itemUrl: opts.record ? opts.record.listing_url : null,
      autoSubmit: false,
      trigger: 'auto-delist',
      condition_id: opts.condition_id || (opts.record ? opts.record.condition_id : null),
      listing_id: recordId,
      node_id: opts.record ? opts.record.node_id || '' : '',
      manualReason: opts.reason || '',
    })
    // addTask は pending で作るので、手動専用ステータスへ付け替える。
    task.status = 'manual'
    ctx.persistTask(task)
    ctx.sendTaskList()
    return task
  }

  // 売却・在庫変動のあとに呼ぶ。在庫は呼び出し時点の DB から読み直す。
  // 戻り値: { created: [task], manual: task|null, excess }
  async function evaluateDelist(productNo, conditionId) {
    const out = { created: [], manual: null, excess: 0 }
    if (!ctx.inventory || !ctx.managerServer || !productNo || !conditionId) return out
    const product = await ctx.dbFindOne(ctx.db, { product_no: productNo })
    if (!product) return out
    const stock = Math.max(0, Number((product.condition_stock || {})[conditionId] || 0))
    const records = await ctx.inventory.listListings(productNo)
    const mine = records.filter((r) => r.condition_id === conditionId)
    const live = mine.filter((r) => r.listing_id && r.listing_state === 'live')
    let excess = live.length - stock
    out.excess = Math.max(0, excess)
    if (excess <= 0) return out
    const busy = busyRecordIds()
    // 古い順（listed_at → createdAt）に犠牲を選ぶ = 新しい出品を残す。
    const victims = live
      .filter((r) => r.auto_delist && !busy.has(r._id))
      .sort((a, b) =>
        String(a.listed_at || a.createdAt || '').localeCompare(
          String(b.listed_at || b.createdAt || '')
        )
      )
    for (const rec of victims) {
      if (excess <= 0) break
      try {
        out.created.push(createDelistTaskForRecord(rec, 'auto-delist'))
        excess -= 1
      } catch (e) {
        console.warn('[manager] delist task skipped:', e && e.message)
      }
    }
    if (excess > 0) {
      out.manual = ensureManualDelistEntry({
        product_no: productNo,
        condition_id: conditionId,
        platform: mine.length ? mine[0].platform : 'mercari',
        reason:
          '出品中 ' + live.length + ' 件 / 在庫 ' + stock + ' 件で ' + excess +
          ' 件余っていますが、自動下架の対象レコードが足りません。手動で下架してください。',
      })
    }
    return out
  }

  return {
    createDelistTaskForRecord,
    hasActiveDelistTaskForRecord,
    ensureManualDelistEntry,
    evaluateDelist,
  }
}

module.exports = { createDelist }
