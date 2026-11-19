<script setup>
  import {
    dataSource, editInfoFlag, editInfoByTitle, editInfoByContent,
    editInfoByPrice, editInfoByProductNo, editInfoByUrl,
    editInfoByMainImg, selectMainImage,
  } from '../store';
  import { normalizeProductImageUrl } from '../utils/product-image'

  const editInfoConfirmed = () => {
    const mainImage = normalizeProductImageUrl(editInfoByMainImg.value)
    let data = { product_no: editInfoByProductNo.value, product_name: editInfoByTitle.value,
       product_content: editInfoByContent.value, amazon_price: editInfoByPrice.value,
       amazon_url: editInfoByUrl.value, product_img: mainImage }
    window.ipcRenderer.send('editInfo', data)
    for (let i = 0; i < dataSource.value.length; i++) {
      if (dataSource.value[i].product_no === editInfoByProductNo.value) {
        dataSource.value[i].product_name = editInfoByTitle.value
        dataSource.value[i].product_content = editInfoByContent.value
        dataSource.value[i].amazon_price = editInfoByPrice.value
        dataSource.value[i].amazon_url = editInfoByUrl.value
        dataSource.value[i].product_img = mainImage
      }
    }
    editInfoFlag.value = false
    editInfoByTitle.value = ""
    editInfoByContent.value = ""
    editInfoByProductNo.value = ""
    editInfoByPrice.value = 0
    editInfoByUrl.value = ""
    editInfoByMainImg.value = ""
  }
</script>

<template>
  <a-modal v-model:open="editInfoFlag" title="商品情報編集" @ok="editInfoConfirmed" width="50%">
    <a-form layout="vertical">
      <a-form-item label="商品名">
        <a-input v-model:value="editInfoByTitle" />
      </a-form-item>
      <a-form-item label="商品詳細">
        <a-textarea v-model:value="editInfoByContent" :auto-size="{ minRows: 5, maxRows: 30 }" />
      </a-form-item>
      <a-form-item label="商品値段">
        <a-input-number v-model:value="editInfoByPrice" style="width: 100%" />
      </a-form-item>
      <a-form-item label="商品URL">
        <a-input v-model:value="editInfoByUrl" />
      </a-form-item>
      <a-form-item label="メイン写真パス">
        <a-input v-model:value="editInfoByMainImg" placeholder="画像ファイルの絶対パスまたは imgp:// パス" />
        <a-button size="small" class="image-select-button" @click="selectMainImage">画像を選択</a-button>
      </a-form-item>
    </a-form>
  </a-modal>
</template>
