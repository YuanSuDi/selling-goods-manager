'use strict'

// 绑定体检（レコード対照）の純ロジック。
// あるノード×プラットフォームの「実際の在售リスト」と、出品レコードの
// 記録を突き合わせ、ズレを異常として列挙する。Electron に依存しない
// 純関数だけを置き、単体テスト可能にする（test/health-test.js）。
//
// 異常の種類:
//   missing  … レコードは「出品中」と言うが、そのノードの在售リストに無い
//              （黙って売れた/終了した/ID が漂移した可能性）。
//              スキャンが完全（complete）のときだけ出す。不完全な
//              スキャンで「消えた」と誤判定しないための安全弁。
//   revived  … レコードは「販売済/未出品」と言うが、実際はまだ売っている
//              （A342 型: 手動販売の誤記で状態だけ倒れたケース）。
//   unclaimed… 在售リストにあるのに、どのレコードにも紐付いていない
//              （A348 型: テストで付け替えた後に放置された生きた出品）。
//              タイトルから商品番号らしい文字列を拾い、付け替え先の
//              レコード候補（missing のレコード、または ID 未設定の
//              レコード）が一意に定まれば suggestion を付ける。
//
// 一時停止（paused）のレコードは対象外にする: Mercari の一時停止は
// 意図的に止めた状態で、在售リストへの載り方もプラットフォーム依存
// のため、載っていないことを異常とはみなさない。

function emptyReport() {
  return { version: 1, updatedAt: null, scopes: {}, dismissed: [] }
}

function scopeKey(platform, nodeId) {
  return String(platform || '') + ':' + String(nodeId || '')
}

// タイトルから商品番号の候補を作る。
// 例: "AY342 ソーラーライト…" → {AY342, A342}
//     （Yahoo のタイトルは A342 が AY342 と書かれることがあるため、
//      2 文字目を落とした候補も出す。元の候補も残すので OT12 のような
//      2 文字プレフィックスと衝突しない。最終的に候補レコードが
//      一意でなければ suggestion は付けないので、誤爆は防げる）
function codeCandidatesFromTitle(title) {
  const out = new Set()
  const text = String(title || '').toUpperCase()
  const re = /[A-Z]{1,3}[0-9]{2,4}/g
  let m
  while ((m = re.exec(text)) !== null) {
    const token = m[0]
    out.add(token)
    const letters = token.match(/^[A-Z]+/)[0]
    if (letters.length >= 2) {
      out.add(letters[0] + letters.slice(2) + token.slice(letters.length))
    }
  }
  return out
}

function computeHealthIssues(input) {
  const platform = input && input.platform === 'yahoo' ? 'yahoo' : 'mercari'
  const nodeId = String((input && input.nodeId) || '')
  const complete = !!(input && input.complete)
  const liveItems = Array.isArray(input && input.liveItems) ? input.liveItems : []
  const records = (Array.isArray(input && input.records) ? input.records : [])
    .filter((r) => r && r.platform === platform)

  const liveMap = new Map()
  for (const it of liveItems) {
    if (it && it.id) liveMap.set(String(it.id), String(it.title || ''))
  }
  // そのプラットフォームの全レコード（ノード不問）が主張する ID。
  const claimed = new Map()
  for (const r of records) {
    if (r.listing_id) claimed.set(String(r.listing_id), r)
  }

  const issues = []
  const missingRecords = []
  const scoped = records.filter((r) => String(r.node_id || '') === nodeId)
  for (const r of scoped) {
    if (!r.listing_id) continue
    const lid = String(r.listing_id)
    const inLive = liveMap.has(lid)
    if ((r.listing_state === 'live' || r.listing_state === 'unknown') && !inLive && complete) {
      issues.push({
        key: platform + '|' + nodeId + '|missing|' + r._id,
        kind: 'missing',
        platform,
        nodeId,
        recordId: r._id,
        product_no: r.product_no,
        condition_id: r.condition_id || null,
        listingId: lid,
        listingUrl: r.listing_url || null,
        title: null,
        suggestion: null,
      })
      missingRecords.push(r)
    } else if ((r.listing_state === 'sold' || r.listing_state === 'unlisted') && inLive) {
      issues.push({
        key: platform + '|' + nodeId + '|revived|' + r._id,
        kind: 'revived',
        platform,
        nodeId,
        recordId: r._id,
        product_no: r.product_no,
        condition_id: r.condition_id || null,
        listingId: lid,
        listingUrl: r.listing_url || null,
        title: liveMap.get(lid) || null,
        suggestion: null,
      })
    }
  }

  // 付け替え先の候補プール: 今回 missing になったレコードと、
  // ID 未設定（下架で ID が外れた等）のレコード。対象は自ノードと
  // 未割当のものだけに絞る（他ノードのレコードを横取りしない）。
  const pool = new Map()
  for (const r of missingRecords) pool.set(r._id, r)
  for (const r of records) {
    const rn = String(r.node_id || '')
    if ((rn === nodeId || rn === '') && !r.listing_id) pool.set(r._id, r)
  }
  const missingKeyByRecord = new Map(
    issues.filter((i) => i.kind === 'missing').map((i) => [i.recordId, i.key])
  )

  for (const it of liveItems) {
    if (!it || !it.id) continue
    const lid = String(it.id)
    if (claimed.has(lid)) continue
    const title = String(it.title || '')
    const codes = codeCandidatesFromTitle(title)
    const matched = []
    for (const r of pool.values()) {
      const pno = String(r.product_no || '').toUpperCase()
      if (!pno) continue
      if (codes.has(pno) || title.toUpperCase().includes(pno)) matched.push(r)
    }
    let suggestion = null
    if (matched.length === 1) {
      const r = matched[0]
      suggestion = {
        recordId: r._id,
        product_no: r.product_no,
        condition_id: r.condition_id || null,
        auto_restock: !!r.auto_restock,
        pairedKey: missingKeyByRecord.get(r._id) || null,
      }
    }
    issues.push({
      key: platform + '|' + nodeId + '|unclaimed|' + lid,
      kind: 'unclaimed',
      platform,
      nodeId,
      recordId: null,
      product_no: suggestion ? suggestion.product_no : null,
      condition_id: suggestion ? suggestion.condition_id : null,
      listingId: lid,
      listingUrl: null,
      title,
      suggestion,
    })
  }

  return issues
}

// レポート（全スコープ + 却下済みキー）から、レンダラー表示用の
// フラットな形を作る。却下済みの異常は落とす。
function flattenReport(report) {
  const dismissed = new Set((report && report.dismissed) || [])
  const scopes = []
  const issues = []
  const src = (report && report.scopes) || {}
  for (const key of Object.keys(src)) {
    const s = src[key] || {}
    scopes.push({
      key,
      platform: s.platform,
      nodeId: s.nodeId,
      at: s.at || null,
      complete: !!s.complete,
      liveCount: Number(s.liveCount || 0),
      issueCount: (s.issues || []).filter((i) => !dismissed.has(i.key)).length,
    })
    for (const i of s.issues || []) {
      if (!dismissed.has(i.key)) issues.push(i)
    }
  }
  scopes.sort((a, b) => String(a.key).localeCompare(String(b.key)))
  const kindOrder = { revived: 0, missing: 1, unclaimed: 2 }
  issues.sort((a, b) => {
    const d = (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9)
    if (d) return d
    return String(a.product_no || '').localeCompare(String(b.product_no || ''))
  })
  return { updatedAt: (report && report.updatedAt) || null, scopes, issues }
}

module.exports = { emptyReport, scopeKey, codeCandidatesFromTitle, computeHealthIssues, flattenReport }
