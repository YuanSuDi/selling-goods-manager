<script setup>
  import {
    product_no, amazon_url, comment, product_img_dir,
    isLoading, lodingTip, speedSubmit, selectImageDir,
  } from '../store';
</script>

<template>
  <a-form layout="vertical" class="form-narrow">
    <a-form-item label="商品管理番号">
      <a-input v-model:value="product_no" placeholder="商品管理番号" />
    </a-form-item>
    <a-form-item label="Amazon商品リンク">
      <a-input v-model:value="amazon_url" placeholder="Amazon商品リンク" />
    </a-form-item>
    <a-form-item label="備考">
      <a-input v-model:value="comment" placeholder="備考" />
    </a-form-item>
    <a-form-item label="写真パス">
      <div style="display: flex; gap: 8px">
        <a-input v-model:value="product_img_dir" placeholder="写真パス" style="flex: 1" />
        <a-button @click="selectImageDir">フォルダを選択</a-button>
      </div>
    </a-form-item>
    <a-form-item class="form-actions">
      <a-spin :tip="lodingTip" :spinning="isLoading">
        <a-button type="primary" @click="speedSubmit">追加</a-button>
      </a-spin>
    </a-form-item>
  </a-form>
</template>

<style lang="less" scoped>
.form-narrow {
  max-width: 680px;
  padding-top: 8px;
}
.form-actions {
  margin-bottom: 0;
}
</style>
