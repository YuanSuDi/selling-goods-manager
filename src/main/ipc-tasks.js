'use strict'

const { ipcMain } = require('electron')

// 出品タスクまわりの IPC（一覧・停止・起動・削除）。
// 共有状態とヘルパーは ctx 経由で参照する（実体は background.js）。
function registerTaskIpc(ctx) {
  //現在のタスク一覧を返す
  ipcMain.on('list_tasks', () => {
    ctx.sendTaskList()
  })

  // タスク停止: pending は拡張機能に渡らなくなる。running は既に拡張機能が
  // 処理中の可能性があるため状態だけ止める（結果が返れば通常どおり記録）。
  ipcMain.on('task_stop', (e, taskId) => {
    const task = ctx.managerServer && ctx.managerServer.tasks.get(taskId)
    if (task && (task.status === 'pending' || task.status === 'running')) {
      task.status = 'stopped'
      ctx.tasksDb.update({ id: task.id }, task, { upsert: true }, () => {})
      console.log('[manager] task stopped:', task.id)
    }
    ctx.sendTaskList()
  })

  // タスク起動: 停止中・失敗のタスクを pending に戻す（拡張機能が約1分
  // 以内に拾う）。同じ商品番号または Mercari 商品 ID に実行待ち/実行中の
  // 再出品がある場合は二重出品防止のため起動しない。
  ipcMain.on('task_start', (e, taskId) => {
    const task = ctx.managerServer && ctx.managerServer.tasks.get(taskId)
    if (task && (task.status === 'stopped' || task.status === 'failed')) {
      const bind = ctx.platformBinding(task.platform)
      const dup =
        task.type === 'relist' &&
        ctx.hasActiveRelistTask(
          task.product_no,
          bind.normalize(task.itemUrl),
          task.platform
        )
      if (!dup) {
        task.status = 'pending'
        task.notOwnerReleases = 0
        ctx.tasksDb.update({ id: task.id }, task, { upsert: true }, () => {})
        console.log('[manager] task restarted:', task.id)
        if (task.type === 'relist' && task.product_no) {
          ctx.db.update(
            { product_no: task.product_no },
            { $set: { [bind.errorField]: null } },
            () => ctx.refreshRenderer()
          )
          if (ctx.inventory && task.listing_id) {
            ctx.inventory.updateListing(task.listing_id, { error: null, status: 'active' }).catch(() => {})
          }
        }
      } else {
        console.log('[manager] task start refused (active relist exists):', task.id)
      }
    }
    ctx.sendTaskList()
  })

  // タスク削除: 記録ごと消す。実行中だった場合、結果は記録されない。
  ipcMain.on('task_delete', (e, taskId) => {
    if (ctx.managerServer && ctx.managerServer.tasks.has(taskId)) {
      ctx.managerServer.tasks.delete(taskId)
      ctx.tasksDb.remove({ id: taskId }, {}, () => {})
      console.log('[manager] task deleted:', taskId)
    }
    ctx.sendTaskList()
  })
}

module.exports = { registerTaskIpc }
