<script setup>
import { computed, ref, watch } from 'vue'
import {
  tdocState,
  tdocSheets,
  tdocSaveSettings,
  tdocListSheets,
  tdocSyncNow,
  tdocImport,
  tdocImportAll,
  tdocPush,
  tdocResolve,
} from '../store'

const settings = computed(() => (tdocState.value && tdocState.value.settings) || null)
const lastRun = computed(() => (tdocState.value && tdocState.value.lastRun) || null)
const syncing = computed(() => !!(tdocState.value && tdocState.value.syncing))
const logs = computed(() => (tdocState.value && tdocState.value.log) || [])

const tokenInput = ref('')
const fileIdInput = ref('')
const sheetIdInput = ref('')
const idFieldInput = ref('编号')
const nameFieldInput = ref('产品名称')
const autoEnabledInput = ref(false)
const intervalInput = ref(30)
const formLoaded = ref(false)

watch(
  settings,
  (s) => {
    if (!s || formLoaded.value) return
    fileIdInput.value = s.fileId || ''
    sheetIdInput.value = s.sheetId || ''
    idFieldInput.value = s.idField || '编号'
    nameFieldInput.value = s.nameField || '产品名称'
    autoEnabledInput.value = !!s.autoEnabled
    intervalInput.value = s.intervalMin || 30
    formLoaded.value = true
  },
  { immediate: true }
)

const sheetOptions = computed(() => {
  const res = tdocSheets.value
  if (!res || !res.ok) return []
  return (res.sheets || []).map((s) => ({ value: s.sheet_id, label: s.title }))
})
const sheetsError = computed(() => {
  const res = tdocSheets.value
  return res && !res.ok ? res.error : ''
})

const saveSettings = () => {
  tdocSaveSettings({
    token: tokenInput.value,
    fileId: fileIdInput.value,
    sheetId: sheetIdInput.value,
    idField: idFieldInput.value,
    nameField: nameFieldInput.value,
    autoEnabled: autoEnabledInput.value,
    intervalMin: Number(intervalInput.value) || 30,
  })
  tokenInput.value = ''
}

const loadSheets = () => {
  tdocListSheets({ token: tokenInput.value, fileId: fileIdInput.value })
}

const fmtTime = (iso) => {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString('ja-JP', { hour12: false })
  } catch (e) {
    return iso
  }
}

const stockText = (stocks) => {
  const parts = Object.entries(stocks || {})
    .filter(([, q]) => Number(q) > 0)
    .map(([name, q]) => `${name}×${q}`)
  return parts.length ? parts.join('、') : '（全状态为 0）'
}

const docOnly = computed(() => (lastRun.value && lastRun.value.docOnly) || [])
const mgrOnly = computed(() => (lastRun.value && lastRun.value.mgrOnly) || [])
const duplicates = computed(() => (lastRun.value && lastRun.value.duplicates) || [])
const conflicts = computed(() => (lastRun.value && lastRun.value.conflicts) || [])
const unmapped = computed(() => (lastRun.value && lastRun.value.unmapped) || [])
</script>

<template>
  <div class="tdoc-panel">
    <div class="tdoc-card">
      <div class="tdoc-card-title">连接设置</div>
      <div class="tdoc-form">
        <label>腾讯文档 Token</label>
        <a-input-password
          v-model:value="tokenInput"
          :placeholder="settings && settings.tokenSet ? '已设置（留空表示不修改）' : '粘贴腾讯文档 MCP Token'"
          style="max-width: 460px"
        />
        <label>文档 ID</label>
        <span>
          <a-input
            v-model:value="fileIdInput"
            placeholder="文档的 file_id（文档链接 /smartsheet/ 后一段）"
            style="max-width: 380px"
          />
          <a-button style="margin-left: 8px" @click="loadSheets">读取子表</a-button>
        </span>
        <label>子表</label>
        <span>
          <a-select
            v-if="sheetOptions.length"
            v-model:value="sheetIdInput"
            :options="sheetOptions"
            style="width: 280px"
            placeholder="选择子表"
          />
          <a-input
            v-else
            v-model:value="sheetIdInput"
            placeholder="先点「读取子表」，或手动填 sheet_id"
            style="max-width: 380px"
          />
          <span v-if="sheetsError" class="tdoc-error">{{ sheetsError }}</span>
        </span>
        <label>ID 字段名</label>
        <a-input v-model:value="idFieldInput" style="max-width: 200px" />
        <label>名称字段名</label>
        <a-input v-model:value="nameFieldInput" style="max-width: 200px" />
        <label>自动同步</label>
        <span>
          <a-switch v-model:checked="autoEnabledInput" />
          <span style="margin: 0 6px 0 12px">间隔（分钟）</span>
          <a-input-number v-model:value="intervalInput" :min="5" :max="1440" style="width: 90px" />
        </span>
      </div>
      <div style="margin-top: 10px">
        <a-button type="primary" @click="saveSettings">保存设置</a-button>
        <span class="tdoc-hint">
          状态列按「列名 = 管理器状态名」自动对应；对不上的列不会同步，你在管理器里改状态名后下次同步自动对上。
        </span>
      </div>
    </div>

    <div class="tdoc-card">
      <div class="tdoc-card-title">
        库存同步
        <a-button
          type="primary"
          :loading="syncing"
          :disabled="syncing"
          style="margin-left: 12px"
          @click="tdocSyncNow"
        >
          立即同步
        </a-button>
      </div>
      <div v-if="lastRun" class="tdoc-status">
        <div>
          上次同步：{{ fmtTime(lastRun.at) }}（{{ lastRun.trigger }}）
          <a-tag v-if="lastRun.ok" color="green">成功</a-tag>
          <a-tag v-else color="red">失败</a-tag>
          <span v-if="!lastRun.ok" class="tdoc-error">{{ lastRun.error }}</span>
        </div>
        <div v-if="lastRun.ok && lastRun.summary" class="tdoc-summary">
          文档商品 {{ lastRun.summary.sheetCount }} 件 / 程序商品 {{ lastRun.summary.managerCount }} 件；
          已同步：程序 ← {{ lastRun.summary.toManager }} 件、文档 ← {{ lastRun.summary.toSheet }} 件；
          待处理：冲突 {{ lastRun.summary.conflicts }}、文档独有 {{ lastRun.summary.docOnly }}、
          程序独有 {{ lastRun.summary.mgrOnly }}、编号重复 {{ lastRun.summary.duplicates }}
          <span v-if="lastRun.summary.invalid">、无编号行 {{ lastRun.summary.invalid }}</span>
        </div>
      </div>
      <div v-else class="tdoc-hint">还没有同步过。先保存设置，再点「立即同步」。</div>

      <div v-if="duplicates.length" class="tdoc-section">
        <div class="tdoc-section-title" style="color: #cf1322">
          ⚠ 文档内编号重复（这些商品已跳过同步，请在文档里改成唯一编号）
        </div>
        <div v-for="d in duplicates" :key="d.id" class="tdoc-row">
          <span class="tdoc-id">{{ d.id }}</span>
          <span>出现 {{ d.count }} 条</span>
        </div>
      </div>

      <div v-if="conflicts.length" class="tdoc-section">
        <div class="tdoc-section-title" style="color: #d46b08">
          ⚠ 库存冲突（文档和程序都改过，需要你选一边）
        </div>
        <div v-for="c in conflicts" :key="c.id + c.cond" class="tdoc-row">
          <span class="tdoc-id">{{ c.id }}</span>
          <span>{{ c.cond }}：文档 {{ c.sheetQty }} 件 / 程序 {{ c.mgrQty }} 件（上次同步 {{ c.snapQty }} 件）</span>
          <a-button size="small" @click="tdocResolve(c.id, c.cond, true)">采用文档</a-button>
          <a-button size="small" @click="tdocResolve(c.id, c.cond, false)">采用程序</a-button>
        </div>
      </div>

      <div v-if="docOnly.length" class="tdoc-section">
        <div class="tdoc-section-title">
          文档有、程序没有（{{ docOnly.length }} 件）
          <a-button size="small" style="margin-left: 8px" @click="tdocImportAll">全部导入</a-button>
        </div>
        <div v-for="p in docOnly" :key="p.id" class="tdoc-row">
          <span class="tdoc-id">{{ p.id }}</span>
          <span>{{ p.name }}</span>
          <span class="tdoc-stocks">{{ stockText(p.stocks) }}</span>
          <a-button size="small" type="primary" @click="tdocImport(p.id)">导入</a-button>
        </div>
      </div>

      <div v-if="mgrOnly.length" class="tdoc-section">
        <div class="tdoc-section-title">程序有、文档没有（{{ mgrOnly.length }} 件，不会自动同步）</div>
        <div v-for="p in mgrOnly" :key="p.id" class="tdoc-row">
          <span class="tdoc-id">{{ p.id }}</span>
          <span>{{ p.name }}</span>
          <span class="tdoc-stocks">{{ stockText(p.stocks) }}</span>
          <a-button size="small" @click="tdocPush(p.id)">同步到文档</a-button>
        </div>
      </div>

      <div v-if="unmapped.length" class="tdoc-section">
        <div class="tdoc-section-title">未对应的数字列（未同步）</div>
        <div>
          <a-tag v-for="t in unmapped" :key="t" color="orange">{{ t }}</a-tag>
          <span class="tdoc-hint">在管理器里把状态名改成和列名一致，下次同步就会对上。</span>
        </div>
      </div>
    </div>

    <div class="tdoc-card" v-if="logs.length">
      <div class="tdoc-card-title">同步日志</div>
      <div v-for="(l, i) in logs" :key="i" class="tdoc-log-line">
        <span class="tdoc-log-time">{{ fmtTime(l.at) }}</span> {{ l.text }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.tdoc-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.tdoc-card {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 12px 14px;
}
.tdoc-card-title {
  font-weight: 600;
  margin-bottom: 10px;
}
.tdoc-form {
  display: grid;
  grid-template-columns: 110px 1fr;
  row-gap: 10px;
  align-items: center;
}
.tdoc-form label {
  color: #555;
}
.tdoc-hint {
  color: #8c8c8c;
  font-size: 12px;
  margin-left: 10px;
}
.tdoc-error {
  color: #cf1322;
  margin-left: 8px;
}
.tdoc-status {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.tdoc-summary {
  color: #555;
}
.tdoc-section {
  margin-top: 14px;
  border-top: 1px dashed #e5e7eb;
  padding-top: 10px;
}
.tdoc-section-title {
  font-weight: 600;
  margin-bottom: 6px;
}
.tdoc-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 3px 0;
  flex-wrap: wrap;
}
.tdoc-id {
  font-family: monospace;
  background: #f5f5f5;
  padding: 0 6px;
  border-radius: 4px;
}
.tdoc-stocks {
  color: #555;
}
.tdoc-log-line {
  padding: 2px 0;
  color: #444;
}
.tdoc-log-time {
  color: #8c8c8c;
  font-family: monospace;
  margin-right: 6px;
}
</style>
