<script setup>
  import {
    yahooBindingFlag,
    yahooBindingProductNo,
    yahooBindingUrl,
    yahooBindingAutoRestock,
    yahooBindingPending,
    saveYahooBinding,
  } from '../store';
</script>

<template>
  <a-modal
    v-model:open="yahooBindingFlag"
    title="雅虎拍卖出品绑定"
    :confirm-loading="yahooBindingPending"
    @ok="saveYahooBinding"
  >
    <a-form layout="vertical">
      <a-form-item label="商品管理番号">
        <a-input :value="yahooBindingProductNo" disabled />
      </a-form-item>
      <a-form-item label="Yahoo!オークション 商品 URL 或 ID">
        <a-input
          v-model:value="yahooBindingUrl"
          placeholder="https://auctions.yahoo.co.jp/jp/auction/… または o123456789 のような ID"
        />
      </a-form-item>
      <a-form-item label="卖出后自动补货">
        <a-switch v-model:checked="yahooBindingAutoRestock" />
      </a-form-item>
    </a-form>
    <a-alert
      type="info"
      show-icon
      message="保存绑定不会立即出品；开启自动补货后，扩展检测到该商品已付款、等待发货时，才会扣库存并创建出品任务（雅虎再出品会复用同一个拍卖 ID）。"
    />
  </a-modal>
</template>
