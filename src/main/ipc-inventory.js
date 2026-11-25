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

  // 手動下架（テスト・即時実行用）: 在庫や自動下架スイッチと無関係に、
  // このレコードの下架タスクを今すぐ作る。実行内容は自動下架と同じ
  // （Mercari=一時停止 / Yahoo=取消し、入札時は中止）。
  ipcMain.on('listing_delist_now', async (e, data) => {
    try {
      const record = ctx.inventory ? await ctx.inventory.getListing((data || {}).id) : null
      if (!record) {
        e.sender.send('listing_result', { ok: false, error: 'レコードが見つかりません。' })
        return
      }
      if (!record.listing_id || record.listing_state !== 'live') {
        e.sender.send('listing_result', { ok: false, error: '出品中のレコードだけ下架できます。' })
        return
      }
      const task = ctx.createDelistTaskForRecord(record, 'manual')
      e.sender.send('list_task_created', { ok: true, task, auto: false })
    } catch (err) {
      e.sender.send('listing_result', { ok: false, error: String((err && err.message) || err) })
    }
  })

  // 手動再上架（テスト・即時実行用）: 「補充出品」と違い在庫ゲートを
  // 通さない。Mercari の一時停止中レコードは「再開」タスク、それ以外
  // （販売済・未出品など）は通常の再出品タスクを作る。
  ipcMain.on('listing_relist_now', async (e, data) => {
    try {
      const record = ctx.inventory ? await ctx.inventory.getListing((data || {}).id) : null
      if (!record) {
        e.sender.send('listing_result', { ok: false, error: 'レコードが見つかりません。' })
        return
      }
      if (record.platform === 'mercari' && record.listing_state === 'paused' && record.listing_id) {
        if (!ctx.managerServer) throw new Error('連携サーバが起動していません')
        for (const t of ctx.managerServer.tasks.values()) {
          if (
            (t.type === 'resume' || t.type === 'delist') &&
            (t.status === 'pending' || t.status === 'running') &&
            t.listing_id === record._id
          ) {
            throw new Error('このレコードの下架/再開タスクが既に実行待ちです')
          }
        }
        const task = ctx.managerServer.addTask({
          product_no: record.product_no,
          platform: record.platform,
          type: 'resume',
          itemUrl: record.listing_url,
          autoSubmit: true,
          trigger: 'manual',
          condition_id: record.condition_id,
          listing_id: record._id,
          node_id: record.node_id || '',
        })
        ctx.persistTask(task)
        ctx.sendTaskList()
        e.sender.send('list_task_created', { ok: true, task, auto: false })
        return
      }
      if (record.listing_state === 'live') {
        e.sender.send('listing_result', { ok: false, error: '既に出品中です。' })
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

  // 出品状態の手動修正。通常はイベントで自動更新されるが、実態と
  // ズレたときにユーザーが直接直せるようにする。変更後は下架判定を
  // 走らせる（例: 在庫0で「出品中」に直したら、その場で下架対象に
  // なる）。値が同じでも判定は走らせる（再判定の受け皿）。
  ipcMain.on('listing_set_state', async (e, data) => {
    const state = (data || {}).state
    if (!['live', 'sold', 'unlisted', 'unknown', 'paused'].includes(state)) {
      e.sender.send('listing_result', { ok: false, error: '状態の値が不正です。' })
      return
    }
    // 出品IDがないレコード（下架・取消しでIDが消えたもの）を「出品中」
    // にすると、リンクなしで出品中という壊れた状態になる（A342 で
    // 発生）。手動変更では許可しない。
    if (state === 'live' && ctx.inventory) {
      const rec = await ctx.inventory.getListing((data || {}).id).catch(() => null)
      if (rec && !rec.listing_id) {
        e.sender.send('listing_result', {
          ok: false,
          error: '出品IDがないレコードは「出品中」にできません。',
        })
        return
      }
    }
    const result = ctx.inventory
      ? await ctx.inventory.updateListing((data || {}).id, {
          listing_state: state,
          state_at: new Date().toISOString(),
        })
          .then((rec) => ({ ok: !!rec, listing: rec }))
          .catch((err) => ({ ok: false, error: String((err && err.message) || err) }))
      : { ok: false, error: 'データ層が初期化されていません。' }
    e.sender.send('listing_result', result)
    if (result.ok) {
      ctx.sendInventoryMeta()
      if (result.listing && ctx.evaluateDelist) {
        try {
          await ctx.evaluateDelist(result.listing.product_no, result.listing.condition_id)
        } catch (err) {
          console.warn('[manager] delist evaluation after manual state set skipped:', err && err.message)
        }
      }
    }
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
