<script setup>
  import {
    product_no, product_name, product_content, amazon_price, sku,
    selled_num, comment, amazon_url, product_img_dir, product_img, submit,
  } from '../store';
</script>

<template>
  <a-form layout="vertical" class="form-narrow">
    <a-form-item label="商品管理番号">
      <a-input v-model:value="product_no" placeholder="商品管理番号" />
    </a-form-item>
    <a-form-item label="商品タイトル">
      <a-input v-model:value="product_name" placeholder="商品タイトル" />
    </a-form-item>
    <a-form-item label="商品詳細">
      <a-textarea v-model:value="product_content" placeholder="商品詳細" :auto-size="{ minRows: 2, maxRows: 5 }" />
    </a-form-item>
    <a-form-item label="Amazon値段">
      <a-input-number v-model:value="amazon_price" prefix="￥" style="width: 100%" placeholder="Amazon値段" />
    </a-form-item>
    <a-form-item label="在庫数">
      <a-input-number v-model:value="sku" style="width: 100%" placeholder="在庫数" />
    </a-form-item>
    <a-form-item label="販売数">
      <a-input-number v-model:value="selled_num" style="width: 100%" placeholder="販売数" />
    </a-form-item>
    <a-form-item label="Amazon商品リンク">
      <a-input v-model:value="amazon_url" placeholder="Amazon商品リンク" />
    </a-form-item>
    <a-form-item label="備考">
      <a-input v-model:value="comment" placeholder="備考" />
    </a-form-item>
    <a-form-item label="写真パス">
      <a-input v-model:value="product_img_dir" placeholder="写真パス" />
    </a-form-item>
    <a-form-item label="メイン写真のパス">
      <a-input v-model:value="product_img" placeholder="メイン写真のパス，「.jpg」を含めてください。参照：D:\project\1.jpg" />
    </a-form-item>
    <a-form-item class="form-actions">
      <a-button type="primary" @click="submit">追加</a-button>
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
