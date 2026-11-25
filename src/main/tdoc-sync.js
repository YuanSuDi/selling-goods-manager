'use strict'

// 腾讯文档スマートシート ⇄ 管理プログラムの在庫同期。
//
// 方針（ユーザー決定 2026-11-25）:
// - 対象ドキュメント/シートは設定で指定（Z 表は書式リファレンス。後で変更可）。
// - 状態列は「列タイトル == 管理プログラムの状態名」で対応付ける。
//   対応しない列・状態は同期対象外（ユーザーが状態名を揃えれば自動で対象になる）。
// - 三者照合: ドキュメント / プログラム / 前回スナップショット。
//   片方だけ変わった → もう片方へ反映。両方変わった → 競合として通知し、
//   ユーザーがどちらを採用するか決めるまで上書きしない。
//   スナップショットが無いセル（初回）はドキュメント優先（シートが残数の正）。
// - ドキュメントにだけある商品 → 通知リストに出し、ワンクリックで手動導入。
// - プログラムにだけある商品 → 自動では送らない。手動「文档へ同期」でのみ追加。
// - ドキュメント内で商品ID（编号フィールド全文）が重複 → その ID は同期を
//   スキップして通知する（ユーザーがドキュメント側で一意化する）。

const { ipcMain } = require('electron')
const fs = require('fs')
const path = require('path')
const { TdocClient } = require('./tdoc-client')

const STATE_FILE = 'tdoc-sync.json'
const DEFAULT_SETTINGS = {
  token: '',
  fileId: '',
  sheetId: '',
  idField: '编号',
  nameField: '产品名称',
  ignoreTitles: ['亚马逊价格', '定价'],
  autoEnabled: false,
  intervalMin: 30,
}

function stateFilePath(ctx) {
  return path.join(ctx.userDataDir, STATE_FILE)
}

function loadState(ctx) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFilePath(ctx), 'utf8'))
    if (parsed && typeof parsed === 'object') {
      return {
        settings: Object.assign({}, DEFAULT_SETTINGS, parsed.settings || {}),
        snapshot: parsed.snapshot || {},
        lastRun: parsed.lastRun || null,
        log: Array.isArray(parsed.log) ? parsed.log : [],
        lastAutoAt: parsed.lastAutoAt || 0,
      }
    }
  } catch (e) { /* 無ければ初期状態 */ }
  return { settings: Object.assign({}, DEFAULT_SETTINGS), snapshot: {}, lastRun: null, log: [], lastAutoAt: 0 }
}

function saveState(ctx, state) {
  try {
    fs.writeFileSync(stateFilePath(ctx), JSON.stringify(state, null, 2))
  } catch (e) {
    console.warn('[tdoc] state save failed:', e && e.message)
  }
}

function pushLog(state, text) {
  state.log.unshift({ at: new Date().toISOString(), text })
  if (state.log.length > 50) state.log.length = 50
}

let syncing = false

function publicState(state) {
  const s = state.settings
  return {
    settings: {
      fileId: s.fileId,
      sheetId: s.sheetId,
      idField: s.idField,
      nameField: s.nameField,
      autoEnabled: s.autoEnabled,
      intervalMin: s.intervalMin,
      tokenSet: !!s.token,
    },
    syncing,
    lastRun: state.lastRun,
    log: state.log.slice(0, 30),
  }
}

function sendState(ctx, state) {
  const win = ctx.win
  if (!win || win.isDestroyed()) return
  win.webContents.send('tdoc_state', publicState(state))
}

// ---- シート読み取り ----

function fieldText(fv) {
  if (!fv) return ''
  if (fv.text_value && Array.isArray(fv.text_value.items)) {
    return fv.text_value.items.map((i) => i.text || '').join('')
  }
  if (fv.url_value && Array.isArray(fv.url_value.items)) {
    return fv.url_value.items.map((i) => i.text || '').join('')
  }
  return ''
}

function parseSheetRecords(records, idField, nameField, stockTitles) {
  const byId = new Map()
  const counts = new Map()
  let invalid = 0
  for (const rec of records || []) {
    const values = {}
    for (const fv of rec.field_values || []) values[fv.field] = fv
    const id = fieldText(values[idField]).trim()
    if (!id) {
      invalid += 1
      continue
    }
    counts.set(id, (counts.get(id) || 0) + 1)
    if (byId.has(id)) continue
    const stocks = {}
    for (const title of stockTitles) {
      const fv = values[title]
      const n = fv && typeof fv.number_value === 'number' ? fv.number_value : 0
      stocks[title] = Math.max(0, Math.round(n))
    }
    byId.set(id, {
      id,
      name: fieldText(values[nameField]).trim(),
      recordId: rec.record_id,
      stocks,
    })
  }
  const duplicates = []
  for (const [id, count] of counts) {
    if (count > 1) duplicates.push({ id, count })
  }
  return { byId, duplicates, invalid }
}

async function fetchAllRecords(client, fileId, sheetId) {
  const all = []
  let offset = 0
  let total = null
  for (let page = 0; page < 50; page++) {
    const res = await client.callTool('smartsheet.list_records', {
      file_id: fileId,
      sheet_id: sheetId,
      limit: 100,
      offset,
    })
    const recs = res.records || []
    if (typeof res.total === 'number') total = res.total
    all.push(...recs)
    if (!res.has_more || !recs.length) break
    offset += recs.length
  }
  // ページネーションで稀に行が欠けることがある（実績あり）→ 総数に
  // 届かなければ 1 回だけ読み直す。
  if (total != null && all.length < total) {
    const again = []
    offset = 0
    for (let page = 0; page < 50; page++) {
      const res = await client.callTool('smartsheet.list_records', {
        file_id: fileId,
        sheet_id: sheetId,
        limit: 100,
        offset,
      })
      const recs = res.records || []
      again.push(...recs)
      if (!res.has_more || !recs.length) break
      offset += recs.length
    }
    if (again.length > all.length) return again
  }
  return all
}

// ---- 三者照合（純粋関数・テスト対象） ----
// sheet/manager: Map<id, {name, recordId?, stocks:{cond:qty}}>
// snapshot: {id: {cond: qty}}
function computeSyncPlan({ sheet, manager, snapshot, stockTitles }) {
  const toManager = []
  const toSheet = []
  const conflicts = []
  const docOnly = []
  const mgrOnly = []
  const newSnapshot = {}
  const ids = new Set([...sheet.keys(), ...manager.keys()])
  for (const id of ids) {
    const s = sheet.get(id)
    const m = manager.get(id)
    if (s && !m) {
      docOnly.push(id)
      continue
    }
    if (m && !s) {
      mgrOnly.push(id)
      continue
    }
    const snap = snapshot[id] || null
    const entry = {}
    for (const cond of stockTitles) {
      const sheetQty = s.stocks[cond] != null ? s.stocks[cond] : 0
      const mgrQty = m.stocks[cond] != null ? m.stocks[cond] : 0
      if (sheetQty === mgrQty) {
        entry[cond] = sheetQty
        continue
      }
      const snapQty = snap && snap[cond] != null ? snap[cond] : null
      if (snapQty == null) {
        // 初回: ドキュメント（残数の正）を優先
        toManager.push({ id, cond, qty: sheetQty })
        entry[cond] = sheetQty
        continue
      }
      const sheetChanged = sheetQty !== snapQty
      const mgrChanged = mgrQty !== snapQty
      if (sheetChanged && !mgrChanged) {
        toManager.push({ id, cond, qty: sheetQty })
        entry[cond] = sheetQty
      } else if (mgrChanged && !sheetChanged) {
        toSheet.push({ id, recordId: s.recordId, cond, qty: mgrQty })
        entry[cond] = mgrQty
      } else if (sheetChanged && mgrChanged) {
        conflicts.push({ id, cond, sheetQty, mgrQty, snapQty })
        entry[cond] = snapQty
      } else {
        entry[cond] = sheetQty
      }
    }
    newSnapshot[id] = entry
  }
  return { toManager, toSheet, conflicts, docOnly, mgrOnly, newSnapshot }
}

// ---- 実行 ----

function dbFindAll(dbInst, query) {
  return new Promise((resolve, reject) => {
    dbInst.find(query || {}, (err, docs) => (err ? reject(err) : resolve(docs || [])))
  })
}
function dbInsert(dbInst, doc) {
  return new Promise((resolve, reject) => {
    dbInst.insert(doc, (err, created) => (err ? reject(err) : resolve(created)))
  })
}

async function buildManagerView(ctx) {
  const conditions = await ctx.inventory.listConditions()
  const condNameById = new Map(conditions.map((c) => [c._id, c.name]))
  const condIdByName = new Map(conditions.map((c) => [c.name, c._id]))
  const products = await dbFindAll(ctx.db, {})
  const byId = new Map()
  for (const p of products) {
    const stocks = {}
    for (const [condId, qty] of Object.entries(p.condition_stock || {})) {
      const name = condNameById.get(condId)
      if (name) stocks[name] = Math.max(0, Number(qty || 0))
    }
    byId.set(p.product_no, { id: p.product_no, name: p.product_name || '', stocks, doc: p })
  }
  return { byId, condIdByName, conditionNames: conditions.map((c) => c.name) }
}

async function runSync(ctx, state, trigger) {
  if (syncing) return { ok: false, error: '同期が既に実行中です' }
  const s = state.settings
  if (!s.token) throw new Error('腾讯文档 Token が未設定です')
  if (!s.fileId) throw new Error('文档 ID が未設定です')
  if (!s.sheetId) throw new Error('子表（シート）が未選択です')
  syncing = true
  sendState(ctx, state)
  try {
    const client = new TdocClient(s.token)
    const fieldsRes = await client.callTool('smartsheet.list_fields', {
      file_id: s.fileId,
      sheet_id: s.sheetId,
    })
    const fields = fieldsRes.fields || []
    const fieldTitles = new Set(fields.map((f) => f.field_title))
    if (!fieldTitles.has(s.idField)) {
      throw new Error('文档に ID フィールド「' + s.idField + '」がありません')
    }
    const mgr = await buildManagerView(ctx)
    const ignore = new Set(s.ignoreTitles || [])
    const numberTitles = fields.filter((f) => f.field_type === 'number').map((f) => f.field_title)
    const stockTitles = numberTitles.filter((t) => mgr.conditionNames.includes(t))
    const unmapped = numberTitles.filter((t) => !mgr.conditionNames.includes(t) && !ignore.has(t))

    const records = await fetchAllRecords(client, s.fileId, s.sheetId)
    const parsed = parseSheetRecords(records, s.idField, s.nameField, stockTitles)
    for (const dup of parsed.duplicates) parsed.byId.delete(dup.id)

    const plan = computeSyncPlan({
      sheet: parsed.byId,
      manager: mgr.byId,
      snapshot: state.snapshot,
      stockTitles,
    })

    // プログラムへ反映
    for (const item of plan.toManager) {
      const entry = mgr.byId.get(item.id)
      const condId = mgr.condIdByName.get(item.cond)
      if (entry && condId) await ctx.setConditionStock(entry.doc, condId, item.qty)
    }
    // ドキュメントへ反映（レコード単位にまとめて更新）
    const byRecord = new Map()
    for (const item of plan.toSheet) {
      if (!byRecord.has(item.recordId)) byRecord.set(item.recordId, {})
      byRecord.get(item.recordId)[item.cond] = { number_value: item.qty }
    }
    const recordUpdates = [...byRecord.entries()].map(([record_id, field_values]) => ({ record_id, field_values }))
    for (let i = 0; i < recordUpdates.length; i += 50) {
      await client.callTool('smartsheet.update_records', {
        file_id: s.fileId,
        sheet_id: s.sheetId,
        records: recordUpdates.slice(i, i + 50),
      })
    }

    state.snapshot = plan.newSnapshot
    state.lastRun = {
      at: new Date().toISOString(),
      trigger,
      ok: true,
      error: null,
      summary: {
        sheetCount: parsed.byId.size + parsed.duplicates.length,
        managerCount: mgr.byId.size,
        toManager: plan.toManager.length,
        toSheet: plan.toSheet.length,
        conflicts: plan.conflicts.length,
        docOnly: plan.docOnly.length,
        mgrOnly: plan.mgrOnly.length,
        duplicates: parsed.duplicates.length,
        invalid: parsed.invalid,
      },
      docOnly: plan.docOnly.map((id) => {
        const p = parsed.byId.get(id)
        return { id, name: p.name, stocks: p.stocks }
      }),
      mgrOnly: plan.mgrOnly.map((id) => {
        const p = mgr.byId.get(id)
        return { id, name: p.name, stocks: p.stocks }
      }),
      duplicates: parsed.duplicates,
      conflicts: plan.conflicts,
      unmapped,
    }
    pushLog(
      state,
      '同期完了（' + trigger + '）: 程序へ ' + plan.toManager.length + ' 件 / 文档へ ' +
        plan.toSheet.length + ' 件 / 競合 ' + plan.conflicts.length + ' 件 / 文档のみ ' +
        plan.docOnly.length + ' 件 / 程序のみ ' + plan.mgrOnly.length + ' 件'
    )
    saveState(ctx, state)
    if (plan.toManager.length) ctx.refreshRenderer()
    return { ok: true }
  } catch (e) {
    state.lastRun = {
      at: new Date().toISOString(),
      trigger,
      ok: false,
      error: String((e && e.message) || e),
      summary: null,
      docOnly: [],
      mgrOnly: [],
      duplicates: [],
      conflicts: [],
      unmapped: [],
    }
    pushLog(state, '同期失敗（' + trigger + '）: ' + String((e && e.message) || e))
    saveState(ctx, state)
    return { ok: false, error: String((e && e.message) || e) }
  } finally {
    syncing = false
    sendState(ctx, state)
  }
}

// ドキュメントにだけある商品をプログラムへ導入する。
async function importProduct(ctx, state, id) {
  const pending = (state.lastRun && state.lastRun.docOnly) || []
  const item = pending.find((p) => p.id === id)
  if (!item) throw new Error('導入待ちリストにありません（先に同期してください）')
  const existing = await ctx.dbFindOne(ctx.db, { product_no: id })
  if (existing) throw new Error('同じ商品番号が既に存在します')
  const mgr = await buildManagerView(ctx)
  const condition_stock = {}
  const condition_sold = {}
  let total = 0
  for (const [condName, qty] of Object.entries(item.stocks || {})) {
    const condId = mgr.condIdByName.get(condName)
    if (!condId) continue
    condition_stock[condId] = Math.max(0, Number(qty || 0))
    condition_sold[condId] = 0
    total += Math.max(0, Number(qty || 0))
  }
  await dbInsert(ctx.db, {
    product_no: id,
    product_name: item.name || '',
    product_content: '',
    amazon_price: 0,
    sku: total,
    selled_num: 0,
    comment: '腾讯文档から導入',
    amazon_url: '',
    product_img_dir: '',
    product_img: '',
    condition_stock,
    condition_sold,
  })
  state.snapshot[id] = Object.assign({}, item.stocks)
  state.lastRun.docOnly = pending.filter((p) => p.id !== id)
  pushLog(state, '文档から導入: ' + id)
  saveState(ctx, state)
  ctx.refreshRenderer()
  if (ctx.sendInventoryMeta) ctx.sendInventoryMeta()
}

// プログラムにだけある商品をドキュメントへ追加する。
async function pushProduct(ctx, state, id) {
  const s = state.settings
  const mgr = await buildManagerView(ctx)
  const entry = mgr.byId.get(id)
  if (!entry) throw new Error('商品が見つかりません')
  const client = new TdocClient(s.token)
  const field_values = {}
  field_values[s.idField] = { items: [{ text: id, type: 'text' }] }
  if (s.nameField) {
    field_values[s.nameField] = { items: [{ text: entry.name || '', type: 'text' }] }
  }
  // add_records は text_value ラッパ形式（list/update と同じ形）
  const wrapped = {}
  for (const [title, v] of Object.entries(field_values)) {
    wrapped[title] = { text_value: v }
  }
  for (const [condName, qty] of Object.entries(entry.stocks)) {
    wrapped[condName] = { number_value: qty }
  }
  await client.callTool('smartsheet.add_records', {
    file_id: s.fileId,
    sheet_id: s.sheetId,
    records: [{ field_values: wrapped }],
  })
  state.snapshot[id] = Object.assign({}, entry.stocks)
  if (state.lastRun && state.lastRun.mgrOnly) {
    state.lastRun.mgrOnly = state.lastRun.mgrOnly.filter((p) => p.id !== id)
  }
  pushLog(state, '文档へ追加: ' + id)
  saveState(ctx, state)
}

// 競合をどちらか一方の値で解決する。
async function resolveConflict(ctx, state, id, cond, useSheet) {
  const conflicts = (state.lastRun && state.lastRun.conflicts) || []
  const c = conflicts.find((x) => x.id === id && x.cond === cond)
  if (!c) throw new Error('競合が見つかりません（先に同期してください）')
  const s = state.settings
  const mgr = await buildManagerView(ctx)
  if (useSheet) {
    const entry = mgr.byId.get(id)
    const condId = mgr.condIdByName.get(cond)
    if (entry && condId) await ctx.setConditionStock(entry.doc, condId, c.sheetQty)
    if (!state.snapshot[id]) state.snapshot[id] = {}
    state.snapshot[id][cond] = c.sheetQty
    ctx.refreshRenderer()
  } else {
    const client = new TdocClient(s.token)
    // record_id は前回同期時のスナップショットには無いため、シートを
    // 読み直して対象レコードを探す。
    const fieldsRes = await client.callTool('smartsheet.list_fields', {
      file_id: s.fileId,
      sheet_id: s.sheetId,
    })
    const stockTitles = (fieldsRes.fields || [])
      .filter((f) => f.field_type === 'number' && mgr.conditionNames.includes(f.field_title))
      .map((f) => f.field_title)
    const records = await fetchAllRecords(client, s.fileId, s.sheetId)
    const parsed = parseSheetRecords(records, s.idField, s.nameField, stockTitles)
    const target = parsed.byId.get(id)
    if (!target) throw new Error('文档側に対象レコードが見つかりません')
    const field_values = {}
    field_values[cond] = { number_value: c.mgrQty }
    await client.callTool('smartsheet.update_records', {
      file_id: s.fileId,
      sheet_id: s.sheetId,
      records: [{ record_id: target.recordId, field_values }],
    })
    if (!state.snapshot[id]) state.snapshot[id] = {}
    state.snapshot[id][cond] = c.mgrQty
  }
  state.lastRun.conflicts = conflicts.filter((x) => !(x.id === id && x.cond === cond))
  pushLog(state, '競合を解決: ' + id + ' / ' + cond + ' → ' + (useSheet ? '文档の値を採用' : '程序の値を採用'))
  saveState(ctx, state)
}

// ---- IPC / 自動同期 ----

let autoTimer = null

function registerTdocIpc(ctx) {
  const state = loadState(ctx)

  ipcMain.on('tdoc_get_state', () => sendState(ctx, state))

  ipcMain.on('tdoc_save_settings', (e, data) => {
    const d = data || {}
    if (typeof d.token === 'string' && d.token.trim()) state.settings.token = d.token.trim()
    for (const key of ['fileId', 'sheetId', 'idField', 'nameField']) {
      if (typeof d[key] === 'string') state.settings[key] = d[key].trim()
    }
    if (Array.isArray(d.ignoreTitles)) state.settings.ignoreTitles = d.ignoreTitles
    if (typeof d.autoEnabled === 'boolean') state.settings.autoEnabled = d.autoEnabled
    if (Number(d.intervalMin) >= 5) state.settings.intervalMin = Math.round(Number(d.intervalMin))
    saveState(ctx, state)
    pushLog(state, '同期設定を保存しました')
    sendState(ctx, state)
  })

  ipcMain.on('tdoc_list_sheets', async (e, data) => {
    const token = (data && data.token && data.token.trim()) || state.settings.token
    const fileId = (data && data.fileId && data.fileId.trim()) || state.settings.fileId
    try {
      if (!token) throw new Error('Token が未設定です')
      if (!fileId) throw new Error('文档 ID が未設定です')
      const client = new TdocClient(token)
      const res = await client.callTool('smartsheet.list_tables', { file_id: fileId })
      e.sender.send('tdoc_sheets', { ok: true, sheets: res.sheets || [] })
    } catch (err) {
      e.sender.send('tdoc_sheets', { ok: false, error: String((err && err.message) || err) })
    }
  })

  ipcMain.on('tdoc_sync_now', async () => {
    await runSync(ctx, state, '手動')
  })

  ipcMain.on('tdoc_import', async (e, data) => {
    try {
      await importProduct(ctx, state, data && data.id)
      sendState(ctx, state)
    } catch (err) {
      pushLog(state, '導入失敗: ' + String((err && err.message) || err))
      saveState(ctx, state)
      sendState(ctx, state)
    }
  })

  ipcMain.on('tdoc_import_all', async () => {
    const ids = ((state.lastRun && state.lastRun.docOnly) || []).map((p) => p.id)
    for (const id of ids) {
      try {
        await importProduct(ctx, state, id)
      } catch (err) {
        pushLog(state, '導入失敗 (' + id + '): ' + String((err && err.message) || err))
      }
    }
    saveState(ctx, state)
    sendState(ctx, state)
  })

  ipcMain.on('tdoc_push', async (e, data) => {
    try {
      await pushProduct(ctx, state, data && data.id)
      sendState(ctx, state)
    } catch (err) {
      pushLog(state, '文档への追加に失敗: ' + String((err && err.message) || err))
      saveState(ctx, state)
      sendState(ctx, state)
    }
  })

  ipcMain.on('tdoc_resolve', async (e, data) => {
    try {
      await resolveConflict(ctx, state, data && data.id, data && data.cond, !!(data && data.useSheet))
      sendState(ctx, state)
    } catch (err) {
      pushLog(state, '競合解決に失敗: ' + String((err && err.message) || err))
      saveState(ctx, state)
      sendState(ctx, state)
    }
  })

  if (autoTimer) clearInterval(autoTimer)
  autoTimer = setInterval(async () => {
    const s = state.settings
    if (!s.autoEnabled || syncing) return
    if (!s.token || !s.fileId || !s.sheetId) return
    const intervalMs = Math.max(5, Number(s.intervalMin || 30)) * 60000
    if (Date.now() - (state.lastAutoAt || 0) < intervalMs) return
    state.lastAutoAt = Date.now()
    saveState(ctx, state)
    await runSync(ctx, state, '自動')
  }, 60000)
}

module.exports = { registerTdocIpc, computeSyncPlan, parseSheetRecords }
