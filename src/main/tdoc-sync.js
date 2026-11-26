'use strict'

// 腾讯文档スマートシート ⇄ 管理プログラムの在庫同期。
//
// 方針（ユーザー決定 2026-11-25 / 子表は 2026-11-26 に全表自動へ変更）:
// - 対象ドキュメントは設定で指定（Z 表は書式リファレンス。後で変更可）。
// - 子表は「全部自動識別」が既定: ID フィールドがあり、状態名と一致する
//   数字列が 1 つ以上ある子表だけを在庫表として同期する（看板等は自動で
//   スキップ）。設定で 1 枚だけに固定もできる。
// - 状態列は「列タイトル == 管理プログラムの状態名」で対応付ける。
//   対応しない列・状態は同期対象外（ユーザーが状態名を揃えれば自動で対象）。
// - 三者照合: ドキュメント / プログラム / 前回スナップショット（子表ごと）。
//   片方だけ変わった → もう片方へ反映。両方変わった → 競合として通知し、
//   ユーザーがどちらを採用するか決めるまで上書きしない。
//   スナップショットが無いセル（初回）はドキュメント優先（シートが残数の正）。
// - ドキュメントにだけある商品 → 通知リストに出し、ワンクリックで手動導入。
// - プログラムにだけある商品 → 自動では送らない。手動「文档へ同期」でのみ
//   追加（追加先の子表は行ごとに選ぶ）。
// - ドキュメント内で商品ID（编号フィールド全文）が重複 → その ID は同期を
//   スキップして通知する（ユーザーがドキュメント側で一意化する）。
// - 同じ商品ID が複数の子表に現れたら、最初の子表だけを同期し、残りは
//   警告リストに出す（シート間の値の押し付け合いを防ぐ）。

const { ipcMain } = require('electron')
const fs = require('fs')
const path = require('path')
const { TdocClient } = require('./tdoc-client')

const STATE_FILE = 'tdoc-sync.json'
const DEFAULT_SETTINGS = {
  token: '',
  fileId: '',
  sheetMode: 'all', // 'all' | 'single'
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
  let state = { settings: Object.assign({}, DEFAULT_SETTINGS), snapshot: {}, lastRun: null, log: [], lastAutoAt: 0 }
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFilePath(ctx), 'utf8'))
    if (parsed && typeof parsed === 'object') {
      state = {
        settings: Object.assign({}, DEFAULT_SETTINGS, parsed.settings || {}),
        snapshot: parsed.snapshot || {},
        lastRun: parsed.lastRun || null,
        log: Array.isArray(parsed.log) ? parsed.log : [],
        lastAutoAt: parsed.lastAutoAt || 0,
      }
    }
  } catch (e) { /* 無ければ初期状態 */ }
  // v0.3.0 のスナップショットは {商品ID: {状態: 数}} の単一表形式だった。
  // 値が全部「数値のオブジェクト」なら旧形式とみなし、設定済み子表の下へ移す。
  const snap = state.snapshot
  const keys = Object.keys(snap)
  if (keys.length) {
    const looksFlat = keys.every((k) => {
      const v = snap[k]
      return v && typeof v === 'object' && Object.values(v).every((x) => typeof x === 'number')
    })
    if (looksFlat) {
      state.snapshot = state.settings.sheetId ? { [state.settings.sheetId]: snap } : {}
    }
  }
  return state
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
      sheetMode: s.sheetMode || 'all',
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

// 子表が在庫表かどうかを判定する（純粋関数・テスト対象）。
// 在庫表 = ID フィールドがあり、状態名と一致する数字列が 1 つ以上ある。
function detectInventorySheet(fields, idField, conditionNames, ignoreTitles) {
  const titles = new Set((fields || []).map((f) => f.field_title))
  const ignore = new Set(ignoreTitles || [])
  const numberTitles = (fields || []).filter((f) => f.field_type === 'number').map((f) => f.field_title)
  const stockTitles = numberTitles.filter((t) => conditionNames.includes(t))
  const unmapped = numberTitles.filter((t) => !conditionNames.includes(t) && !ignore.has(t))
  if (!titles.has(idField)) return { isInventory: false, reason: 'IDフィールド「' + idField + '」なし', stockTitles, unmapped }
  if (!stockTitles.length) return { isInventory: false, reason: '状態と一致する数字列なし', stockTitles, unmapped }
  return { isInventory: true, reason: '', stockTitles, unmapped }
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
// snapshot: {id: {cond: qty}}（1 子表分）
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
  if (s.sheetMode === 'single' && !s.sheetId) throw new Error('子表が未選択です')
  syncing = true
  sendState(ctx, state)
  try {
    const client = new TdocClient(s.token)
    const tablesRes = await client.callTool('smartsheet.list_tables', { file_id: s.fileId })
    const allSheets = tablesRes.sheets || []
    const candidates =
      s.sheetMode === 'single'
        ? allSheets.filter((sh) => sh.sheet_id === s.sheetId).length
          ? allSheets.filter((sh) => sh.sheet_id === s.sheetId)
          : [{ sheet_id: s.sheetId, title: s.sheetId }]
        : allSheets

    const mgr = await buildManagerView(ctx)
    const totals = { sheetCount: 0, toManager: 0, toSheet: 0, conflicts: 0, docOnly: 0, duplicates: 0, invalid: 0 }
    const sheetRuns = []
    const skipped = []
    const docOnlyAll = []
    const conflictsAll = []
    const duplicatesAll = []
    const crossSheet = []
    const seenInAnySheet = new Set()
    const claimedBy = new Map() // 商品ID -> 最初に同期した子表名
    let managerTouched = false

    for (const sh of candidates) {
      const fieldsRes = await client.callTool('smartsheet.list_fields', {
        file_id: s.fileId,
        sheet_id: sh.sheet_id,
      })
      const det = detectInventorySheet(fieldsRes.fields || [], s.idField, mgr.conditionNames, s.ignoreTitles)
      if (!det.isInventory) {
        skipped.push({ sheetId: sh.sheet_id, title: sh.title, reason: det.reason })
        continue
      }
      const records = await fetchAllRecords(client, s.fileId, sh.sheet_id)
      const parsed = parseSheetRecords(records, s.idField, s.nameField, det.stockTitles)
      for (const dup of parsed.duplicates) {
        parsed.byId.delete(dup.id)
        duplicatesAll.push({ id: dup.id, count: dup.count, sheetId: sh.sheet_id, sheetTitle: sh.title })
      }
      // 他の子表で同期済みの商品ID はこの表では扱わない（押し付け合い防止）
      for (const id of [...parsed.byId.keys()]) {
        if (claimedBy.has(id)) {
          crossSheet.push({ id, firstSheet: claimedBy.get(id), sheetTitle: sh.title })
          parsed.byId.delete(id)
        }
      }

      const plan = computeSyncPlan({
        sheet: parsed.byId,
        manager: mgr.byId,
        snapshot: (state.snapshot && state.snapshot[sh.sheet_id]) || {},
        stockTitles: det.stockTitles,
      })

      for (const item of plan.toManager) {
        const entry = mgr.byId.get(item.id)
        const condId = mgr.condIdByName.get(item.cond)
        if (entry && condId) {
          await ctx.setConditionStock(entry.doc, condId, item.qty)
          entry.stocks[item.cond] = item.qty
          managerTouched = true
        }
      }
      const byRecord = new Map()
      for (const item of plan.toSheet) {
        if (!byRecord.has(item.recordId)) byRecord.set(item.recordId, {})
        byRecord.get(item.recordId)[item.cond] = { number_value: item.qty }
      }
      const recordUpdates = [...byRecord.entries()].map(([record_id, field_values]) => ({ record_id, field_values }))
      for (let i = 0; i < recordUpdates.length; i += 50) {
        await client.callTool('smartsheet.update_records', {
          file_id: s.fileId,
          sheet_id: sh.sheet_id,
          records: recordUpdates.slice(i, i + 50),
        })
      }

      if (!state.snapshot) state.snapshot = {}
      state.snapshot[sh.sheet_id] = plan.newSnapshot
      for (const id of parsed.byId.keys()) {
        seenInAnySheet.add(id)
        if (!claimedBy.has(id)) claimedBy.set(id, sh.title)
      }
      for (const id of plan.docOnly) {
        const p = parsed.byId.get(id)
        docOnlyAll.push({ id, name: p.name, stocks: p.stocks, sheetId: sh.sheet_id, sheetTitle: sh.title })
      }
      for (const c of plan.conflicts) {
        conflictsAll.push(Object.assign({ sheetId: sh.sheet_id, sheetTitle: sh.title }, c))
      }
      totals.sheetCount += parsed.byId.size + parsed.duplicates.length
      totals.toManager += plan.toManager.length
      totals.toSheet += plan.toSheet.length
      totals.conflicts += plan.conflicts.length
      totals.docOnly += plan.docOnly.length
      totals.duplicates += parsed.duplicates.length
      totals.invalid += parsed.invalid
      sheetRuns.push({
        sheetId: sh.sheet_id,
        title: sh.title,
        count: parsed.byId.size,
        toManager: plan.toManager.length,
        toSheet: plan.toSheet.length,
        conflicts: plan.conflicts.length,
        docOnly: plan.docOnly.length,
        unmapped: det.unmapped,
      })
    }

    if (!sheetRuns.length) {
      throw new Error('同期できる子表が見つかりませんでした（「' + s.idField + '」フィールドと状態列のある子表が必要です）')
    }

    const mgrOnlyAll = []
    for (const [id, entry] of mgr.byId) {
      if (!seenInAnySheet.has(id)) {
        mgrOnlyAll.push({ id, name: entry.name, stocks: entry.stocks })
      }
    }

    state.lastRun = {
      at: new Date().toISOString(),
      trigger,
      ok: true,
      error: null,
      summary: {
        sheetCount: totals.sheetCount,
        managerCount: mgr.byId.size,
        toManager: totals.toManager,
        toSheet: totals.toSheet,
        conflicts: totals.conflicts,
        docOnly: totals.docOnly,
        mgrOnly: mgrOnlyAll.length,
        duplicates: totals.duplicates,
        invalid: totals.invalid,
        sheets: sheetRuns.length,
      },
      sheets: sheetRuns,
      skipped,
      crossSheet,
      docOnly: docOnlyAll,
      mgrOnly: mgrOnlyAll,
      duplicates: duplicatesAll,
      conflicts: conflictsAll,
      unmapped: sheetRuns.flatMap((r) => r.unmapped.map((t) => ({ title: t, sheetTitle: r.title }))),
    }
    pushLog(
      state,
      '同期完了（' + trigger + '）: 子表 ' + sheetRuns.length + ' 枚 / 程序へ ' + totals.toManager +
        ' 件 / 文档へ ' + totals.toSheet + ' 件 / 競合 ' + totals.conflicts + ' 件 / 文档のみ ' +
        totals.docOnly + ' 件 / 程序のみ ' + mgrOnlyAll.length + ' 件'
    )
    saveState(ctx, state)
    if (managerTouched) ctx.refreshRenderer()
    return { ok: true }
  } catch (e) {
    state.lastRun = {
      at: new Date().toISOString(),
      trigger,
      ok: false,
      error: String((e && e.message) || e),
      summary: null,
      sheets: [],
      skipped: [],
      crossSheet: [],
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
async function importProduct(ctx, state, sheetId, id) {
  const pending = (state.lastRun && state.lastRun.docOnly) || []
  const item = pending.find((p) => p.id === id && (!sheetId || p.sheetId === sheetId))
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
  if (!state.snapshot) state.snapshot = {}
  if (!state.snapshot[item.sheetId]) state.snapshot[item.sheetId] = {}
  state.snapshot[item.sheetId][id] = Object.assign({}, item.stocks)
  state.lastRun.docOnly = pending.filter((p) => !(p.id === id && p.sheetId === item.sheetId))
  pushLog(state, '文档から導入: ' + id + '（' + item.sheetTitle + '）')
  saveState(ctx, state)
  ctx.refreshRenderer()
  if (ctx.sendInventoryMeta) ctx.sendInventoryMeta()
}

// プログラムにだけある商品を指定の子表へ追加する。
async function pushProduct(ctx, state, sheetId, id) {
  const s = state.settings
  const targetSheet = sheetId || s.sheetId
  if (!targetSheet) throw new Error('追加先の子表が指定されていません')
  const mgr = await buildManagerView(ctx)
  const entry = mgr.byId.get(id)
  if (!entry) throw new Error('商品が見つかりません')
  const client = new TdocClient(s.token)
  const wrapped = {}
  wrapped[s.idField] = { text_value: { items: [{ text: id, type: 'text' }] } }
  if (s.nameField) {
    wrapped[s.nameField] = { text_value: { items: [{ text: entry.name || '', type: 'text' }] } }
  }
  for (const [condName, qty] of Object.entries(entry.stocks)) {
    wrapped[condName] = { number_value: qty }
  }
  await client.callTool('smartsheet.add_records', {
    file_id: s.fileId,
    sheet_id: targetSheet,
    records: [{ field_values: wrapped }],
  })
  if (!state.snapshot) state.snapshot = {}
  if (!state.snapshot[targetSheet]) state.snapshot[targetSheet] = {}
  state.snapshot[targetSheet][id] = Object.assign({}, entry.stocks)
  if (state.lastRun && state.lastRun.mgrOnly) {
    state.lastRun.mgrOnly = state.lastRun.mgrOnly.filter((p) => p.id !== id)
  }
  pushLog(state, '文档へ追加: ' + id)
  saveState(ctx, state)
}

// 競合をどちらか一方の値で解決する。
async function resolveConflict(ctx, state, sheetId, id, cond, useSheet) {
  const conflicts = (state.lastRun && state.lastRun.conflicts) || []
  const c = conflicts.find((x) => x.id === id && x.cond === cond && (!sheetId || x.sheetId === sheetId))
  if (!c) throw new Error('競合が見つかりません（先に同期してください）')
  const s = state.settings
  const targetSheet = c.sheetId || sheetId || s.sheetId
  const mgr = await buildManagerView(ctx)
  const snapFor = () => {
    if (!state.snapshot) state.snapshot = {}
    if (!state.snapshot[targetSheet]) state.snapshot[targetSheet] = {}
    if (!state.snapshot[targetSheet][id]) state.snapshot[targetSheet][id] = {}
    return state.snapshot[targetSheet][id]
  }
  if (useSheet) {
    const entry = mgr.byId.get(id)
    const condId = mgr.condIdByName.get(cond)
    if (entry && condId) await ctx.setConditionStock(entry.doc, condId, c.sheetQty)
    snapFor()[cond] = c.sheetQty
    ctx.refreshRenderer()
  } else {
    const client = new TdocClient(s.token)
    const fieldsRes = await client.callTool('smartsheet.list_fields', {
      file_id: s.fileId,
      sheet_id: targetSheet,
    })
    const det = detectInventorySheet(fieldsRes.fields || [], s.idField, mgr.conditionNames, s.ignoreTitles)
    const records = await fetchAllRecords(client, s.fileId, targetSheet)
    const parsed = parseSheetRecords(records, s.idField, s.nameField, det.stockTitles)
    const target = parsed.byId.get(id)
    if (!target) throw new Error('文档側に対象レコードが見つかりません')
    const field_values = {}
    field_values[cond] = { number_value: c.mgrQty }
    await client.callTool('smartsheet.update_records', {
      file_id: s.fileId,
      sheet_id: targetSheet,
      records: [{ record_id: target.recordId, field_values }],
    })
    snapFor()[cond] = c.mgrQty
  }
  state.lastRun.conflicts = conflicts.filter((x) => !(x.id === id && x.cond === cond && x.sheetId === c.sheetId))
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
    if (d.sheetMode === 'all' || d.sheetMode === 'single') state.settings.sheetMode = d.sheetMode
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
      await importProduct(ctx, state, data && data.sheetId, data && data.id)
      sendState(ctx, state)
    } catch (err) {
      pushLog(state, '導入失敗: ' + String((err && err.message) || err))
      saveState(ctx, state)
      sendState(ctx, state)
    }
  })

  ipcMain.on('tdoc_import_all', async () => {
    const items = ((state.lastRun && state.lastRun.docOnly) || []).slice()
    for (const item of items) {
      try {
        await importProduct(ctx, state, item.sheetId, item.id)
      } catch (err) {
        pushLog(state, '導入失敗 (' + item.id + '): ' + String((err && err.message) || err))
      }
    }
    saveState(ctx, state)
    sendState(ctx, state)
  })

  ipcMain.on('tdoc_push', async (e, data) => {
    try {
      await pushProduct(ctx, state, data && data.sheetId, data && data.id)
      sendState(ctx, state)
    } catch (err) {
      pushLog(state, '文档への追加に失敗: ' + String((err && err.message) || err))
      saveState(ctx, state)
      sendState(ctx, state)
    }
  })

  ipcMain.on('tdoc_resolve', async (e, data) => {
    try {
      await resolveConflict(ctx, state, data && data.sheetId, data && data.id, data && data.cond, !!(data && data.useSheet))
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
    if (!s.token || !s.fileId) return
    if (s.sheetMode === 'single' && !s.sheetId) return
    const intervalMs = Math.max(5, Number(s.intervalMin || 30)) * 60000
    if (Date.now() - (state.lastAutoAt || 0) < intervalMs) return
    state.lastAutoAt = Date.now()
    saveState(ctx, state)
    await runSync(ctx, state, '自動')
  }, 60000)
}

module.exports = { registerTdocIpc, computeSyncPlan, parseSheetRecords, detectInventorySheet }
