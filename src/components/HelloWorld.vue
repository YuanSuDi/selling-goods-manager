<script setup>
  // 画面シェル（旧単一ファイルから分割）。状態と IPC は ../store.js に集約し、
  // 一覧・追加フォーム・各モーダルは個別コンポーネントに分かれている。
  import { PlusOutlined, UnorderedListOutlined, ShopOutlined, LinkOutlined, FolderOpenOutlined, CloudSyncOutlined } from '@ant-design/icons-vue';
  import {
    activeKey, alertDisFlg, alertMsg, alertDisFlgHandleClose,
    successFlg, successMsg, activeTaskCount, openTaskModal, showManagerInfo,
  } from '../store';
  import ProductList from './ProductList.vue';
  import ProductAddForm from './ProductAddForm.vue';
  import ProductQuickAdd from './ProductQuickAdd.vue';
  import ProductImageDownload from './ProductImageDownload.vue';
  import TdocSyncPanel from './TdocSyncPanel.vue';
  import EditProductModal from './EditProductModal.vue';
  import MercariBindingModal from './MercariBindingModal.vue';
  import YahooBindingModal from './YahooBindingModal.vue';
  import ManagerInfoModal from './ManagerInfoModal.vue';
  import TaskManagerModal from './TaskManagerModal.vue';

  const openUserDataFolder = () => window.ipcRenderer.send('open_user_data_folder');
</script>

<template>
  <div class="page">
    <header class="page-header">
      <div class="page-title">
        <ShopOutlined class="page-title-icon" />
        <div>
          <h1>商品管理</h1>
          <p>在庫・出品マネージャー</p>
        </div>
      </div>
      <div class="header-actions">
        <a-badge :count="activeTaskCount" size="small">
          <a-button @click="openTaskModal">
            <template #icon><UnorderedListOutlined /></template>
            出品タスク
          </a-button>
        </a-badge>
        <a-button @click="showManagerInfo">
          <template #icon><LinkOutlined /></template>
          連携情報
        </a-button>
        <a-button @click="openUserDataFolder">
          <template #icon><FolderOpenOutlined /></template>
          用户数据位置
        </a-button>
      </div>
    </header>

    <div class="page-body">
      <a-alert
        v-if="alertDisFlg"
        class="page-alert"
        v-model:message="alertMsg"
        type="error"
        closable
        :after-close="alertDisFlgHandleClose"
        show-icon
      />
      <a-alert
        v-if="successFlg"
        class="page-alert"
        :message="successMsg"
        type="success"
        closable
        @close="successFlg = false"
        show-icon
      />

      <div class="card">
        <a-tabs v-model:activeKey="activeKey">
          <a-tab-pane key="1">
            <template #tab>
              <span>
                <UnorderedListOutlined />
                商品リスト
              </span>
            </template>
            <ProductList />
          </a-tab-pane>

          <a-tab-pane key="2">
            <template #tab>
              <span>
                <PlusOutlined />
                商品を追加
              </span>
            </template>
            <ProductAddForm />
          </a-tab-pane>

          <a-tab-pane key="3">
            <template #tab>
              <span>
                <PlusOutlined />
                商品を快速追加
              </span>
            </template>
            <ProductQuickAdd />
          </a-tab-pane>

          <a-tab-pane key="4">
            <template #tab>
              <span>
                <PlusOutlined />
                商品画像をダウンロード
              </span>
            </template>
            <ProductImageDownload />
          </a-tab-pane>

          <a-tab-pane key="5">
            <template #tab>
              <span>
                <CloudSyncOutlined />
                腾讯文档同步
              </span>
            </template>
            <TdocSyncPanel />
          </a-tab-pane>
        </a-tabs>
      </div>
    </div>

    <EditProductModal />
    <MercariBindingModal />
    <YahooBindingModal />
    <ManagerInfoModal />
    <TaskManagerModal />
  </div>
</template>

<style lang="less" scoped>
.page {
  min-height: 100vh;
  background: #f4f5f7;
}
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 24px;
  background: #fff;
  border-bottom: 1px solid #e8eaed;
}
.page-title {
  display: flex;
  align-items: center;
  gap: 12px;

  h1 {
    font-size: 17px;
    font-weight: 600;
    margin: 0;
    line-height: 1.3;
  }

  p {
    margin: 0;
    font-size: 12px;
    color: #8a919c;
  }
}
.page-title-icon {
  font-size: 24px;
  color: #2e6be6;
}
.page-body {
  padding: 16px 24px 24px;
}
.page-alert {
  margin-bottom: 12px;
}
.card {
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 1px 3px rgba(16, 24, 40, 0.06);
  padding: 4px 16px 16px;
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
</style>
