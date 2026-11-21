<script setup>
  import { ref, computed } from 'vue';
  import { taskModalFlag, taskList, requestTaskList, nodeLabel, platformName } from '../store';

  const taskColumns = [
    { title: '商品番号', dataIndex: 'product_no', key: 'product_no', width: 110 },
    { title: '起動元', dataIndex: 'trigger', key: 'trigger', width: 100 },
    { title: '自動出品', dataIndex: 'autoSubmit', key: 'autoSubmit', width: 95 },
    { title: 'サイト', key: 'platform', width: 110 },
    { title: '参照商品', key: 'itemUrl', width: 120 },
    { title: 'ノード', key: 'node', width: 160 },
    { title: '状態', key: 'status', width: 90 },
    { title: '作成', key: 'createdAt', width: 150 },
    { title: '結果', key: 'result' },
    { title: '操作', key: 'taskActions', width: 170 },
  ];
  const TASK_STATUS = {
    pending: { label: '実行待ち', color: 'gold' },
    running: { label: '実行中', color: 'blue' },
    done: { label: '完了', color: 'green' },
    failed: { label: '失敗', color: 'red' },
    stopped: { label: '停止', color: 'default' },
    manual: { label: '手動対応', color: 'red' },
  };
  const taskStatusMeta = (s) => TASK_STATUS[s] || { label: s || '?', color: 'default' };
  // 起動元（trigger）の表示名。未知の値は誤解を避けるためそのまま出す。
  const TRIGGER_LABELS = {
    manual: '手動',
    'manual-sale': '手動売却',
    'mercari-todo': '売出監視',
    'yahoo-sold': 'ヤフオク売却',
    claim: '所有権確認',
    'auto-delist': '自動下架',
  };
  const triggerLabel = (t) => TRIGGER_LABELS[t] || t || '手動';
  // ---- 検索・絞り込み（件数が増えても要対応を見失わないため） ----
  const searchText = ref('');
  const statusFilter = ref('all');
  const platformFilter = ref('all');
  const actionOnly = ref(false);
  // 要対応（手動対応・失敗）を先頭に、その中では新しい順。
  const STATUS_WEIGHT = { manual: 0, failed: 1, running: 2, pending: 3, stopped: 4, done: 5 };
  const isActionNeeded = (t) => t.status === 'manual' || t.status === 'failed';
  const displayTasks = computed(() => {
    const q = searchText.value.trim().toLowerCase();
    let list = (taskList.value || []).filter((t) => {
      if (actionOnly.value && !isActionNeeded(t)) return false;
      if (statusFilter.value !== 'all' && t.status !== statusFilter.value) return false;
      if (platformFilter.value !== 'all' && (t.platform || 'mercari') !== platformFilter.value) return false;
      if (q) {
        const hay = [t.product_no, t.title, t.itemUrl, mercariIdOf(t.itemUrl), t.id]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    list = list.slice().sort((a, b) => {
      const wa = STATUS_WEIGHT[a.status] != null ? STATUS_WEIGHT[a.status] : 6;
      const wb = STATUS_WEIGHT[b.status] != null ? STATUS_WEIGHT[b.status] : 6;
      if (wa !== wb) return wa - wb;
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });
    return list;
  });
  const fmtTime = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '—' : d.toLocaleString('ja-JP');
  };
  const mercariIdOf = (url) => {
    const s = String(url || '');
    const m = s.match(/(m\d{6,})/);
    if (m) return m[1];
    const y = s.match(/\/auction\/([a-zA-Z]?\d+)/) || s.match(/^([a-zA-Z]?\d+)$/);
    return y ? y[1] : url || '—';
  };
  const targetNodeLabel = (rec) => {
    if (rec.node_id === '*') return '全ノード（確認）';
    if (!rec.node_id) return '既定プール';
    return nodeLabel(rec.node_id);
  };
  const executorOf = (rec) =>
    (rec.result && rec.result.executedBy) || rec.claimedBy || null;
  const hasOtherActiveRelist = (rec) =>
    taskList.value.some(
      (t) =>
        t.id !== rec.id &&
        t.type === 'relist' &&
        t.product_no === rec.product_no &&
        (t.status === 'pending' || t.status === 'running')
    );
  const stopTask = (rec) => window.ipcRenderer.send('task_stop', rec.id);
  const startTask = (rec) => window.ipcRenderer.send('task_start', rec.id);
  const deleteTask = (rec) => window.ipcRenderer.send('task_delete', rec.id);
</script>

<template>
  <a-modal v-model:open="taskModalFlag" title="出品タスク" width="82%" :footer="null">
    <div class="task-toolbar">
      <span class="task-hint">「実行待ち」「実行中」が自動追加中のタスクです。実行中のタスクは拡張機能が処理中の場合があり、停止しても出品が完了することがあります（結果は記録されます）。削除したタスクの結果は記録されません。</span>
      <a-button size="small" @click="requestTaskList">更新</a-button>
    </div>
    <div class="task-filters">
      <a-input
        v-model:value="searchText"
        size="small"
        allow-clear
        placeholder="商品番号・商品名・リンクIDで検索"
        style="width: 260px"
      />
      <a-select
        v-model:value="statusFilter"
        size="small"
        style="width: 120px"
        :options="[
          { value: 'all', label: '状態：すべて' },
          { value: 'manual', label: '手動対応' },
          { value: 'failed', label: '失敗' },
          { value: 'pending', label: '実行待ち' },
          { value: 'running', label: '実行中' },
          { value: 'stopped', label: '停止' },
          { value: 'done', label: '完了' },
        ]"
      />
      <a-select
        v-model:value="platformFilter"
        size="small"
        style="width: 130px"
        :options="[
          { value: 'all', label: 'サイト：すべて' },
          { value: 'mercari', label: 'メルカリ' },
          { value: 'yahoo', label: 'ヤフオク' },
        ]"
      />
      <span class="action-only">
        <a-switch v-model:checked="actionOnly" size="small" />
        <span>要対応のみ（手動対応・失敗）</span>
      </span>
      <span class="task-count">{{ displayTasks.length }} 件</span>
    </div>
    <a-table :dataSource="displayTasks" :columns="taskColumns" :pagination="{ pageSize: 8 }" rowKey="id" size="middle">
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'status'">
          <a-tag :color="taskStatusMeta(record.status).color">{{ taskStatusMeta(record.status).label }}</a-tag>
        </template>
        <template v-else-if="column.key === 'trigger'">
          {{ triggerLabel(record.trigger) }}
        </template>
        <template v-else-if="column.key === 'autoSubmit'">
          <a-tag :color="record.autoSubmit ? 'green' : 'default'">{{ record.autoSubmit ? 'ON' : 'OFF' }}</a-tag>
        </template>
        <template v-else-if="column.key === 'platform'">
          <a-tag :color="record.platform === 'yahoo' ? 'orange' : 'blue'">{{ platformName(record.platform) }}</a-tag>
          <div v-if="record.type === 'verify'" class="task-node-sub">所有権確認</div>
          <div v-if="record.type === 'delist'" class="task-node-sub">自動下架</div>
          <div v-if="record.type === 'manual-delist'" class="task-node-sub">手動下架</div>
        </template>
        <template v-else-if="column.key === 'itemUrl'">
          <a v-if="record.itemUrl" :href="record.itemUrl" target="_blank">{{ mercariIdOf(record.itemUrl) }}</a>
          <span v-else>—</span>
        </template>
        <template v-else-if="column.key === 'node'">
          <div>対象：{{ targetNodeLabel(record) }}</div>
          <div v-if="executorOf(record)" class="task-node-sub">実行：{{ nodeLabel(executorOf(record)) }}</div>
        </template>
        <template v-else-if="column.key === 'createdAt'">
          {{ fmtTime(record.createdAt) }}
        </template>
        <template v-else-if="column.key === 'result'">
          <span v-if="record.type === 'manual-delist'" class="task-err">{{ record.manualReason || '手動で下架してください' }}</span>
          <a v-else-if="record.result && record.result.ok && record.result.listingUrl" :href="record.result.listingUrl" target="_blank">{{ mercariIdOf(record.result.listingUrl) }}</a>
          <span v-else-if="record.result && record.result.message" class="task-err">{{ record.result.message }}</span>
          <span v-else class="task-none">—</span>
        </template>
        <template v-else-if="column.key === 'taskActions'">
          <a-space>
            <a-button v-if="record.status === 'pending' || record.status === 'running'" size="small" @click="stopTask(record)">停止</a-button>
            <a-button v-if="record.status === 'stopped' || record.status === 'failed'" size="small" type="primary" :disabled="record.type === 'relist' && hasOtherActiveRelist(record)" @click="startTask(record)">起動</a-button>
            <a-popconfirm title="このタスクを削除しますか？" ok-text="削除" cancel-text="キャンセル" @confirm="deleteTask(record)">
              <a-button size="small" type="text" danger>削除</a-button>
            </a-popconfirm>
          </a-space>
        </template>
      </template>
    </a-table>
  </a-modal>
</template>

<style lang="less" scoped>
.task-toolbar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}
.task-filters {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 12px;
}
.action-only {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #555;
}
.task-count {
  color: #8a919c;
  font-size: 12px;
}
.task-hint {
  color: #8a919c;
  font-size: 12px;
  line-height: 1.6;
}
.task-err {
  color: #cf3f30;
  font-size: 12px;
}
.task-none {
  color: #b6bcc6;
}
.task-node-sub {
  color: #8a919c;
  font-size: 12px;
}
</style>
