'use strict'

const { ipcMain } = require('electron')

// v0.2.0 の在庫まわり IPC（状態・出品レコード・ノード）。
// 共有状態とヘルパーは ctx 経由で参照する（実体は background.js）。
function registerInventoryIpc(ctx) {
  ipcMain.on('get_inventory_meta', () => {
    ctx.sendInventoryMeta()
  })

  ipcMain.on('condition_save', async (e, data) => {
    const result = ctx.inventory
      ? await ctx.inventory.saveCondition(data || {})
      : { ok: false, error: 'データ層が初期化されていません。' }
    e.sender.send('condition_result', result)
    if (result.ok) ctx.sendInventoryMeta()
  })

  ipcMain.on('condition_delete', async (e, data) => {
    const result = ctx.inventory
      ? await ctx.inventory.deleteCondition((data || {}).id)
      : { ok: false, error: 'データ層が初期化されていません。' }
    e.sender.send('condition_result', result)
    if (result.ok) ctx.sendInventoryMeta()
  })

  ipcMain.on('listing_save', async (e, data) => {
    const result = ctx.inventory
      ? await ctx.inventory.saveListing(data || {})
      : { ok: false, error: 'データ層が初期化されていません。' }
    if (result.ok && result.listing) {
      // 既定状態のレコードは旧フィールドへ二重書きする。
      const rec = result.listing
      if (rec.condition_id === ctx.defaultConditionId) {
        const bind = ctx.platformBinding(rec.platform)
        await ctx.dbUpdate(ctx.db, { product_no: rec.product_no }, {
          $set: { [bind.refField]: rec.listing_url, [bind.autoField]: !!rec.auto_restock },
        })
        ctx.refreshRenderer()
      }
    }
    e.sender.send('listing_result', result)
    if (result.ok) ctx.sendInventoryMeta()
  })

  ipcMain.on('listing_delete', async (e, data) => {
    const result = ctx.inventory
      ? await ctx.inventory.deleteListing((data || {}).id)
      : { ok: false, error: 'データ層が初期化されていません。' }
    if (result.ok && result.listing && result.listing.condition_id === ctx.defaultConditionId) {
      const bind = ctx.platformBinding(result.listing.platform)
      const rest = (await ctx.inventory.listListings(result.listing.product_no)).filter(
        (r) => r.platform === result.listing.platform && r.condition_id === ctx.defaultConditionId
      )
      if (!rest.length) {
        await ctx.dbUpdate(ctx.db, { product_no: result.listing.product_no }, {
          $set: { [bind.refField]: null, [bind.autoField]: false },
        })
        ctx.refreshRenderer()
      }
    }
    e.sender.send('listing_result', result)
    if (result.ok) ctx.sendInventoryMeta()
  })

  ipcMain.on('listing_relist', async (e, data) => {
    try {
      const record = ctx.inventory ? await ctx.inventory.getListing((data || {}).id) : null
      if (!record) {
        e.sender.send('listing_result', { ok: false, error: 'レコードが見つかりません。' })
        return
      }
      const product = await ctx.dbFindOne(ctx.db, { product_no: record.product_no })
      const condStock = product && product.condition_stock
        ? Number(product.condition_stock[record.condition_id] || 0)
        : 0
      if (!(condStock > 0)) {
        e.sender.send('listing_result', { ok: false, error: 'その状態の在庫がありません。' })
        return
      }
      const task = ctx.createRelistTaskForRecord(record, true, 'manual')
      e.sender.send('list_task_created', { ok: true, task, auto: false })
    } catch (err) {
      e.sender.send('listing_result', { ok: false, error: String((err && err.message) || err) })
    }
  })

  ipcMain.on('listing_claim', async (e, data) => {
    try {
      if (!ctx.managerServer) throw new Error('連携サーバが起動していません')
      const record = ctx.inventory ? await ctx.inventory.getListing((data || {}).id) : null
      if (!record) {
        e.sender.send('listing_result', { ok: false, error: 'レコードが見つかりません。' })
        return
      }
      for (const t of ctx.managerServer.tasks.values()) {
        if (t.type === 'verify' && t.listing_id === record._id && t.status === 'pending') {
          // 既存の確認タスクがある場合はエラーにせず、試行済みノードを
          // リセットして全ノードへ再配信する（再クリック＝再試行）。
          t.attemptedBy = []
          if (ctx.tasksDb) ctx.tasksDb.update({ id: t.id }, t, { upsert: true }, () => {})
          ctx.sendTaskList()
          e.sender.send('listing_result', { ok: true, claimed: true, reset: true })
          return
        }
      }
      ctx.managerServer.addTask({
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
      ctx.sendTaskList()
      e.sender.send('listing_result', { ok: true, claimed: true })
    } catch (err) {
      e.sender.send('listing_result', { ok: false, error: String((err && err.message) || err) })
    }
  })

  ipcMain.on('listing_fix_node', async (e, data) => {
    const result = ctx.inventory
      ? await ctx.inventory.updateListing((data || {}).id, { node_id: (data || {}).node_id || '' })
          .then((rec) => ({ ok: !!rec, listing: rec }))
          .catch((err) => ({ ok: false, error: String((err && err.message) || err) }))
      : { ok: false, error: 'データ層が初期化されていません。' }
    e.sender.send('listing_result', result)
    if (result.ok) ctx.sendInventoryMeta()
  })

  ipcMain.on('node_rename', async (e, data) => {
    const result = ctx.inventory
      ? await ctx.inventory.renameNode((data || {}).nodeId, (data || {}).name)
      : { ok: false, error: 'データ層が初期化されていません。' }
    if (result.ok && result.node) {
      ctx.nodeInfoCache.set(result.node._id, { id: result.node._id, name: result.node.name || null })
    }
    e.sender.send('node_result', result)
    if (result.ok) ctx.sendInventoryMeta()
  })

  ipcMain.on('node_delete', async (e, data) => {
    const result = ctx.inventory
      ? await ctx.inventory.deleteNode((data || {}).nodeId)
      : { ok: false, error: 'データ層が初期化されていません。' }
    if (result.ok) ctx.nodeInfoCache.delete((data || {}).nodeId)
    e.sender.send('node_result', result)
    if (result.ok) ctx.sendInventoryMeta()
  })
}

module.exports = { registerInventoryIpc }
