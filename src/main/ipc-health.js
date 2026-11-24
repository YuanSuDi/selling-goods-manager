'use strict'

const { ipcMain } = require('electron')
const fs = require('fs')
const path = require('path')
const { emptyReport, scopeKey, computeHealthIssues, flattenReport } = require('./health')

// 绑定体检の IPC と結果反映。
// 流れ: レンダラーが health_scan_start → 登録済み全ノード×両プラット
// フォームへ type='healthscan' タスクを作成 → 拡張が各ブラウザで
// 在售リストを列挙して result.scan で返す → handleTaskResult から
// applyHealthScanResult が呼ばれ、レコードと突き合わせて異常一覧を
// health-report.json（userDataDir）に保存し、レンダラーへ配信する。
// 異常への対処（改绑・状態修正）は既存の listing_save /
// listing_set_state をそのまま使う。ここは「見つけて並べる」だけ。

function reportFilePath(ctx) {
  return path.join(ctx.userDataDir, 'health-report.json')
}

function loadReport(ctx) {
  try {
    const parsed = JSON.parse(fs.readFileSync(reportFilePath(ctx), 'utf8'))
    if (parsed && parsed.scopes) {
      return Object.assign(emptyReport(), parsed)
    }
  } catch (e) { /* 無ければ空レポート */ }
  return emptyReport()
}

function saveReport(ctx, report) {
  try {
    fs.writeFileSync(reportFilePath(ctx), JSON.stringify(report, null, 2))
  } catch (e) {
    console.warn('[manager] health report save failed:', e && e.message)
  }
}

function sendHealthReport(ctx) {
  const win = ctx.win
  if (!win || win.isDestroyed()) return
  win.webContents.send('health_report', flattenReport(loadReport(ctx)))
}

async function applyHealthScanResult(ctx, task) {
  const scan = task && task.result && task.result.scan
  if (!scan || !ctx.inventory) return
  const records = await ctx.inventory.listListings()
  const issues = computeHealthIssues({
    platform: task.platform,
    nodeId: task.node_id,
    complete: !!scan.complete,
    liveItems: scan.items || [],
    records,
  })
  const report = loadReport(ctx)
  const key = scopeKey(task.platform, task.node_id)
  report.scopes[key] = {
    platform: task.platform,
    nodeId: task.node_id || '',
    at: new Date().toISOString(),
    complete: !!scan.complete,
    liveCount: (scan.items || []).length,
    issues,
  }
  report.updatedAt = new Date().toISOString()
  saveReport(ctx, report)
  sendHealthReport(ctx)
}

function registerHealthIpc(ctx) {
  ipcMain.on('health_get', () => {
    sendHealthReport(ctx)
  })

  ipcMain.on('health_scan_start', async (e) => {
    try {
      if (!ctx.managerServer) throw new Error('連携サーバが起動していません')
      if (!ctx.inventory) throw new Error('データ層が初期化されていません')
      const nodes = await ctx.inventory.listNodes()
      if (!nodes.length) {
        e.sender.send('health_result', { ok: false, error: 'ブラウザノードがまだ登録されていません。' })
        return
      }
      let created = 0
      for (const node of nodes) {
        for (const platform of ['mercari', 'yahoo']) {
          const exists = Array.from(ctx.managerServer.tasks.values()).some(
            (t) => t.type === 'healthscan' && t.node_id === node._id &&
              t.platform === platform && (t.status === 'pending' || t.status === 'running')
          )
          if (exists) continue
          ctx.managerServer.addTask({
            platform,
            type: 'healthscan',
            trigger: 'health',
            node_id: node._id,
            title: '绑定体检',
          })
          created += 1
        }
      }
      ctx.sendTaskList()
      e.sender.send('health_result', { ok: true, created })
    } catch (err) {
      e.sender.send('health_result', { ok: false, error: String((err && err.message) || err) })
    }
  })

  ipcMain.on('health_dismiss', (e, key) => {
    if (!key) return
    const report = loadReport(ctx)
    if (!report.dismissed.includes(key)) report.dismissed.push(key)
    saveReport(ctx, report)
    sendHealthReport(ctx)
  })
}

module.exports = { registerHealthIpc, applyHealthScanResult, sendHealthReport }
