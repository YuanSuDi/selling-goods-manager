<script setup>
  import {
    mercariBindingFlag,
    mercariBindingProductNo,
    mercariBindingUrl,
    mercariBindingAutoRestock,
    mercariBindingPending,
    saveMercariBinding,
  } from '../store';
</script>

<template>
  <a-modal
    v-model:open="mercariBindingFlag"
    title="自动出品绑定"
    :confirm-loading="mercariBindingPending"
    @ok="saveMercariBinding"
  >
    <a-form layout="vertical">
      <a-form-item label="商品管理番号">
        <a-input :value="mercariBindingProductNo" disabled />
      </a-form-item>
      <a-form-item label="Mercari 商品 URL 或 ID">
        <a-input
          v-model:value="mercariBindingUrl"
          placeholder="https://jp.mercari.com/item/m… または m 开头的商品 ID"
        />
      </a-form-item>
      <a-form-item label="卖出后自动补货">
        <a-switch v-model:checked="mercariBindingAutoRestock" />
      </a-form-item>
    </a-form>
    <a-alert
      type="info"
      show-icon
      message="保存绑定不会立即出品；开启自动补货后，扩展检测到该商品出现在 TODO 发货待办时，才会扣库存并创建出品任务。"
    />
  </a-modal>
</template>
