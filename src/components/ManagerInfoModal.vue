<script setup>
  import { mgrInfoFlag, mgrInfo } from '../store';
</script>

<template>
  <a-modal v-model:open="mgrInfoFlag" title="拡張機能との連携情報" :footer="null">
    <a-descriptions bordered size="small" :column="1">
      <a-descriptions-item label="ポート">{{ mgrInfo.port }}</a-descriptions-item>
      <a-descriptions-item label="トークン"><span class="token">{{ mgrInfo.token }}</span></a-descriptions-item>
      <a-descriptions-item label="状態">{{ mgrInfo.running ? '起動中' : '未起動' }}</a-descriptions-item>
    </a-descriptions>
    <p class="mgr-note">拡張機能（フリマコピー）のポップアップ「出品管理プログラム連携」に、同じトークンを入力して有効にしてください。</p>
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
</style>
