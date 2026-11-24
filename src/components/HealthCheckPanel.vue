<script setup>
  import { computed } from 'vue'
  import {
    healthReport, healthIssues, startHealthScan, dismissHealthIssue,
    saveListing, setListingState, nodeLabel, platformName, urlClick,
  } from '../store'

  const scopes = computed(() => (healthReport.value && healthReport.value.scopes) || [])
  const updatedAt = computed(() => (healthReport.value && healthReport.value.updatedAt) || null)
  const fmtTime = (iso) => {
    if (!iso) return ''
    const d = new Date(iso)
    return isNaN(d.getTime()) ? iso : d.toLocaleString('ja-JP')
  }
  const itemUrl = (issue) =>
    issue.platform === 'yahoo'
      ? 'https://auctions.yahoo.co.jp/jp/auction/' + issue.listingId
      : 'https://jp.mercari.com/item/' + issue.listingId

  const KIND = {
    missing: { label: '不在售', color: 'red', desc: '记录称出品中，但该账号的在售列表里没有（可能已卖出/结束，或 ID 已漂移）' },
    revived: { label: '还在卖', color: 'orange', desc: '记录称已售/未出品，但实际还在卖' },
    unclaimed: { label: '无人认领', color: 'gold', desc: '在售列表里有，但没有任何记录绑定它' },
  }

  const onMarkUnknown = (issue) => {
    setListingState(issue.recordId, 'unknown')
    dismissHealthIssue(issue.key)
  }
  const onMarkLive = (issue) => {
    setListingState(issue.recordId, 'live')
    dismissHealthIssue(issue.key)
  }
  const onRebind = (issue) => {
    const sug = issue.suggestion
    if (!sug) return
    saveListing({
      id: sug.recordId,
      product_no: sug.product_no,
      condition_id: sug.condition_id,
      platform: issue.platform,
      itemUrl: itemUrl(issue),
      auto_restock: sug.auto_restock,
      node_id: issue.nodeId,
    })
    dismissHealthIssue(issue.key)
    if (sug.pairedKey) dismissHealthIssue(sug.pairedKey)
  }
</script>

<template>
  <div class="health-panel">
    <div class="health-head">
      <span class="health-name">绑定体检</span>
      <a-button size="small" type="primary" @click="startHealthScan">开始体检</a-button>
      <span v-if="updatedAt" class="health-meta">上次扫描：{{ fmtTime(updatedAt) }}</span>
      <span v-for="sc in scopes" :key="sc.key" class="health-meta">
        {{ platformName(sc.platform) }} / {{ nodeLabel(sc.nodeId) }}：在售 {{ sc.liveCount }} 件<template v-if="!sc.complete">（扫描不完全，「不在售」判定已跳过）</template>
      </span>
    </div>
    <div v-if="!healthReport" class="health-empty">
      还没有扫描过。点「开始体检」，各浏览器会依次拉取自己账号的在售列表，与记录逐条对照。
    </div>
    <div v-else-if="!healthIssues.length" class="health-empty">没有发现异常 ✅</div>
    <div v-for="issue in healthIssues" :key="issue.key" class="health-row">
      <a-tag :color="KIND[issue.kind].color">{{ KIND[issue.kind].label }}</a-tag>
      <span class="health-pno">{{ issue.product_no || '（未知商品）' }}</span>
      <span>{{ platformName(issue.platform) }} / {{ nodeLabel(issue.nodeId) }}</span>
      <a class="link" @click="urlClick(itemUrl(issue))">{{ issue.listingId }}</a>
      <span v-if="issue.title" class="health-listing-title">{{ issue.title }}</span>
      <span class="health-desc">{{ KIND[issue.kind].desc }}</span>
      <span class="health-actions">
        <a-button v-if="issue.kind === 'missing'" size="small" @click="onMarkUnknown(issue)">标记待确认</a-button>
        <a-button v-if="issue.kind === 'revived'" size="small" @click="onMarkLive(issue)">改回出品中</a-button>
        <a-button v-if="issue.kind === 'unclaimed' && issue.suggestion" size="small" type="primary" @click="onRebind(issue)">改绑到 {{ issue.suggestion.product_no }}</a-button>
        <a-button size="small" type="text" @click="dismissHealthIssue(issue.key)">忽略</a-button>
      </span>
    </div>
  </div>
</template>

<style scoped>
  .health-panel {
    margin: 8px 0 12px;
    padding: 10px 12px;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    background: #fbfcfe;
  }
  .health-head {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .health-name {
    font-weight: 600;
  }
  .health-meta {
    color: #6b7280;
    font-size: 12px;
  }
  .health-empty {
    margin-top: 8px;
    color: #6b7280;
    font-size: 12px;
  }
  .health-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px dashed #e5e7eb;
  }
  .health-pno {
    font-weight: 600;
  }
  .health-listing-title {
    color: #374151;
    max-width: 420px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .health-desc {
    color: #6b7280;
    font-size: 12px;
  }
  .health-actions {
    margin-left: auto;
    display: inline-flex;
    gap: 4px;
  }
  .link {
    cursor: pointer;
  }
</style>
