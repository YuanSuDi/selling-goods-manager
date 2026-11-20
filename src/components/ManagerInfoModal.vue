<script setup>
  import { ref, reactive, watch } from 'vue';
  import { mgrInfoFlag, mgrInfo, nodes, renameNode, deleteNodeById } from '../store';

  const nodeDrafts = reactive({});
  watch(mgrInfoFlag, (open) => {
    if (open) {
      nodes.value.forEach((n) => { nodeDrafts[n._id] = n.name || '' })
    }
  });
  // 開いた後に現れたノードも空欄にならないよう、未登録の下書きだけ補う。
  watch(nodes, (list) => {
    list.forEach((n) => {
      if (!(n._id in nodeDrafts)) nodeDrafts[n._id] = n.name || ''
    })
  });
  const fmtSeen = (ts) => {
    if (!ts) return '—'
    const d = new Date(ts)
    return d.toLocaleString('ja-JP')
  };
  const delNodeTarget = ref(null);
  const confirmDeleteNode = () => {
    if (delNodeTarget.value) deleteNodeById(delNodeTarget.value)
    delNodeTarget.value = null
  };
</script>

<template>
  <a-modal v-model:open="mgrInfoFlag" title="拡張機能との連携情報" :footer="null" width="640px">
    <a-descriptions bordered size="small" :column="1">
      <a-descriptions-item label="ポート">{{ mgrInfo.port }}</a-descriptions-item>
      <a-descriptions-item label="トークン"><span class="token">{{ mgrInfo.token }}</span></a-descriptions-item>
      <a-descriptions-item label="状態">{{ mgrInfo.running ? '起動中' : '未起動' }}</a-descriptions-item>
    </a-descriptions>
    <p class="mgr-note">拡張機能（フリマコピー）のポップアップ「出品管理プログラム連携」に、同じトークンを入力して有効にしてください。</p>

    <h4 class="nodes-title">ブラウザ（ノード）</h4>
    <p class="mgr-note" style="margin: 0 0 8px;">各 Chrome プロファイルが1つのノードです。名前はここでのみ登録します（重複不可）。名前を付けたノードは、そのノード宛のタスクだけを受け取ります。</p>
    <div v-for="n in nodes" :key="n._id" class="node-row">
      <a-input v-model:value="nodeDrafts[n._id]" :placeholder="'無名（' + String(n._id).slice(0, 6) + '）'" style="flex: 1" />
      <span class="node-seen">最終確認：{{ fmtSeen(n.last_seen) }}</span>
      <a-button size="small" @click="renameNode(n._id, nodeDrafts[n._id])">保存</a-button>
      <a-button size="small" danger @click="delNodeTarget = n._id">削除</a-button>
    </div>
    <div v-if="!nodes.length" style="color: #999;">接続したブラウザはまだありません。拡張機能が連携を有効にしてポーリングすると表示されます。</div>
  </a-modal>

  <a-modal :open="!!delNodeTarget" title="ノード削除確認" @ok="confirmDeleteNode" @cancel="delNodeTarget = null">
    <p>このノードを削除してよろしいですか。（レコードが割り当てられているノードは削除できません）</p>
  </a-modal>
</template>

<style lang="less" scoped>
.token {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  word-break: break-all;
}
.mgr-note {
  margin: 12px 0 0;
  color: #5f6672;
  font-size: 12px;
}
.nodes-title {
  margin: 18px 0 4px;
  font-size: 13px;
  font-weight: 600;
}
.node-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}
.node-seen {
  color: #8a919c;
  font-size: 12px;
  white-space: nowrap;
}
</style>
