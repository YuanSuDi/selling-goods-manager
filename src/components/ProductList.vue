<script setup>
  import { ref, reactive, computed } from 'vue'
  import { EditOutlined, CheckOutlined } from '@ant-design/icons-vue';
  import { cloneDeep } from 'lodash-es';
  import {
    NO_IMAGE, dataSource, isLoading, lodingTip, currentItemNo,
    urlClick, openImgDir, selledItem, editInfo, openMercariBinding, openYahooBinding,
    listSearch, noPrefixes, addNoPrefix, removeNoPrefix, clearCategoryFilter,
    refDetailFlag, refDetailProductNo, refDetailProduct, openRefDetail,
  } from '../store';
  import { normalizeProductImageUrl } from '../utils/product-image'

  const pagination = ref({
    position: ['bottomRight'],
    showTotal: () => `トータル件数： ${dataSource.value.length} 件`
  })

  const compareStrings = (str1, str2) => {
     // 提取字符串中的字母部分
    const letters1 = str1.match(/[a-zA-Z]+/);
    const letters2 = str2.match(/[a-zA-Z]+/);

    // 如果两个字符串都有字母部分
    if (letters1 && letters2) {
        const letter1 = letters1[0];
        const letter2 = letters2[0];

        // 比较字母部分
        if (letter1 !== letter2) {
            return letter1.localeCompare(letter2);
        } else {
            // 如果字母相同，提取数字部分
            const number1 = parseInt(str1.match(/\d+/)[0], 10);
            const number2 = parseInt(str2.match(/\d+/)[0], 10);
            return number1 - number2;
        }
    } else {
        // 如果其中一个字符串没有字母部分，按原顺序排列
        return str1.localeCompare(str2);
    }
  }

  const columns = [
    {
      title: '商品管理番号',
      dataIndex: 'product_no',
      key: 'product_no',
      sorter: {
        compare: (a, b) => compareStrings(a.product_no, b.product_no) ,
        multiple: 1,
      },
      width: 100,
      resizable: true,
    },
    {
      title: '商品写真',
      dataIndex: 'product_img',
      key: 'product_img',
      width: 100,
      height: 100,
      resizable: true,
    },
    {
    title: '商品タイトル',
    dataIndex: 'product_name',
    key: 'product_name',
    width: 240,
      resizable: true,
  },
  {
    title: '商品詳細',
    dataIndex: 'product_content',
    key: 'product_content',
    width: 200,
    resizable: true,
  },
  {
    title: 'Amazon値段',
    dataIndex: 'amazon_price',
    key: 'amazon_price',
    width: 90,
  },
  {
    title: '在庫数',
    key: 'sku',
    dataIndex: 'sku',
    width: 64,
  },
  {
    title: '販売数',
    dataIndex: 'selled_num',
    key: 'selled_num',
    width: 64,
  },
  {
    title: '商品リンク',
    dataIndex: 'amazon_url',
    key: 'amazon_url',
    width: 76,
  },
  {
    title: '参照',
    key: 'refs',
    width: 132,
  },
  {
    title: '備考',
    dataIndex: 'comment',
    key: 'comment',
    width: 200,
  }
  ,
  {
    title: '操作',
    dataIndex: 'do',
    key: 'do',
    width: 174,
  },
  ]

  //用商品名检索
  const onSearchByName = searchValue => {
    listSearch.nameSearch = searchValue
    listSearch.activeFilter = 'name'
    isLoading.value = true
    window.ipcRenderer.send('searchByName', searchValue)
  };

  const onSearchByNo = searchValue => {
    listSearch.searchNo = searchValue
    listSearch.activeFilter = 'no'
    lodingTip.value = "検索中..."
    isLoading.value = true
    window.ipcRenderer.send('searchByNo', searchValue)
  };

  //商品管理番号の種類で絞り込む。種類リストは store の noPrefixes
  //（「種類管理」から追加・削除でき、localStorage に保存される）。
  const options = computed(() => noPrefixes.value.map((p) => ({ value: p, label: p })));
  const filterOption = (input, option) => {
    return option.value.toLowerCase().indexOf(input.toLowerCase()) >= 0;
  };
  const handleChange = searchValue => {
    listSearch.selectedCategory = searchValue
    listSearch.activeFilter = 'category'
    window.ipcRenderer.send('searchBySelectNo', searchValue)
  };

  //種類の追加・削除
  const prefixModalFlag = ref(false);
  const newPrefix = ref('');
  const prefixError = ref('');
  const openPrefixModal = () => {
    newPrefix.value = ''
    prefixError.value = ''
    prefixModalFlag.value = true
  };
  const submitNewPrefix = () => {
    const res = addNoPrefix(newPrefix.value)
    if (res.ok) {
      newPrefix.value = ''
      prefixError.value = ''
    } else {
      prefixError.value = res.error
    }
  };
  const onRemovePrefix = (p) => {
    removeNoPrefix(p)
  };

  //删除提示框
  const deleteAlertFlag = ref(false);
  //删除商品
  const deleteItem = product_no => {
    deleteAlertFlag.value = true
    currentItemNo.value = product_no
  };
  const deleteConfirmed = () => {
    deleteAlertFlag.value = false
    lodingTip.value = "削除中..."
    isLoading.value = true
    window.ipcRenderer.send('deleteItem', currentItemNo.value)
  }

  //入库添加
  let addProductFlag = ref(false);
  let addProductCount = ref(0);
  const addProduct = product_no => {
    addProductFlag.value = true
    currentItemNo.value = product_no
  };
  const addProductConfirmed = () => {
    addProductFlag.value = false
    let sku = 0
    for (let i = 0; i < dataSource.value.length; i++) {
      if (dataSource.value[i].product_no === currentItemNo.value) {
        dataSource.value[i].sku = dataSource.value[i].sku + addProductCount.value
        sku = dataSource.value[i].sku
        break;
      }
    }
    let data = { product_no: currentItemNo.value, sku: sku }
    window.ipcRenderer.send('addProductCount', data)
    currentItemNo.value = ""
    addProductCount.value = 0
  }

  //编辑备注
  const editableData = reactive({});
  const editComment = product_no => {
    for (let i = 0; i < dataSource.value.length; i++) {
      if (dataSource.value[i].product_no === product_no) {
        editableData[product_no] = { product_no: product_no, comment: cloneDeep(dataSource.value[i].comment) }
        break;
      }
    }
  };
  const saveComment = product_no => {
    for (let i = 0; i < dataSource.value.length; i++) {
      if (dataSource.value[i].product_no === product_no) {
        dataSource.value[i].comment = editableData[product_no].comment
        break;
      }
    }
    let data = { product_no: product_no, comment: editableData[product_no].comment }
    window.ipcRenderer.send('saveComment', data)
    delete editableData[product_no];
  };
</script>

<template>
  <div class="toolbar">
    <a-select
      show-search
      allow-clear
      placeholder="商品管理番号種類"
      style="width: 190px"
      :options="options"
      :filter-option="filterOption"
      v-model:value="listSearch.selectedCategory"
      @select="handleChange"
      @clear="clearCategoryFilter"
    ></a-select>
    <a-button @click="openPrefixModal">種類管理</a-button>
    <a-input-search
      v-model:value="listSearch.searchNo"
      placeholder="番号を入力"
      style="width: 210px"
      enter-button
      @search="onSearchByNo"
    />
    <a-input-search
      v-model:value="listSearch.nameSearch"
      placeholder="商品名を入力"
      style="width: 210px"
      enter-button
      @search="onSearchByName"
    />
  </div>

  <a-table :dataSource="dataSource" :columns="columns" rowKey="product_no" :pagination="pagination" :scroll="{ x: 1440 }">
    <template #expandedRowRender="{ record }">
      <div class="expanded">
        <div class="expanded-name">{{ record.product_name }}</div>
        <div style="white-space: pre-line;">{{ record.product_content }}</div>
      </div>
    </template>
    <template #expandColumnTitle>
      <span style="color: #9aa1ad">詳細</span>
    </template>

    <template #bodyCell="{ column, record }">
      <template v-if="column.key === 'amazon_url'">
        <a class="link" @click="urlClick(record.amazon_url)">リンク</a>
      </template>
      <template v-else-if="column.key === 'product_img'">
        <a-image :width="84" :src="normalizeProductImageUrl(record.product_img, record.product_img_dir)" class="thumb" :fallback="NO_IMAGE" />
      </template>
      <template v-else-if="column.key === 'product_name'">
        <span class="name-cell">{{ record.product_name.substr(0, 60) }}</span>
      </template>
      <template v-else-if="column.key === 'product_content'">
        <span class="content-cell">{{ record.product_content.substr(0, 40).concat("...") }}</span>
      </template>
      <template v-else-if="column.key === 'sku'">
        <a-tag v-if="record.sku == 0" color="red">SOLD OUT</a-tag>
        <span v-else class="stock-num">{{ record.sku }}</span>
      </template>
      <template v-else-if="column.key === 'do'">
        <div class="ops">
          <div class="ops-row">
            <a-button v-if="record.sku != 0" size="small" @click="selledItem(record.product_no)">一つ売り</a-button>
            <a-button size="small" @click="addProduct(record.product_no)">入荷</a-button>
          </div>
          <div class="ops-row">
            <a-button type="text" size="small" @click="openImgDir(record.product_img_dir)">写真</a-button>
            <a-button type="text" size="small" @click="editInfo(record.product_no)">編集</a-button>
            <a-button type="text" size="small" danger @click="deleteItem(record.product_no)">削除</a-button>
          </div>
        </div>
      </template>
      <template v-else-if="column.key === 'refs'">
        <div class="refs-cell" title="クリックで参照詳細" @click="openRefDetail(record.product_no)">
          <template v-if="record.mercari_ref || record.yahoo_ref">
            <a-tag v-if="record.mercari_ref" :color="record.list_error ? 'red' : (record.auto_restock ? 'green' : 'blue')">メルカリ{{ record.list_error ? ' エラー' : (record.auto_restock ? ' 自動' : '') }}</a-tag>
            <a-tag v-if="record.yahoo_ref" :color="record.yahoo_list_error ? 'red' : (record.yahoo_auto_restock ? 'green' : 'blue')">ヤフオク{{ record.yahoo_list_error ? ' エラー' : (record.yahoo_auto_restock ? ' 自動' : '') }}</a-tag>
          </template>
          <span v-else class="ref-none">未設定</span>
        </div>
      </template>
      <template v-else-if="column.key === 'comment'">
        <div class="editable-cell">
          <div v-if="editableData[record.product_no]" class="editable-cell-input-wrapper">
            <a-textarea v-model:value="editableData[record.product_no].comment" allow-clear />
            <CheckOutlined class="editable-cell-icon-check" @click="saveComment(record.product_no)" />
          </div>
          <div v-else class="editable-cell-text-wrapper">
            <span style="white-space: pre-line;">{{ record.comment || ' ' }}</span>
            <EditOutlined class="editable-cell-icon" @click="editComment(record.product_no)" />
          </div>
        </div>
      </template>
    </template>
  </a-table>

  <a-modal v-model:open="deleteAlertFlag" title="削除確認" @ok="deleteConfirmed">
    <p>削除してよろしいですか。</p>
  </a-modal>
  <a-modal v-model:open="addProductFlag" title="商品入库" @ok="addProductConfirmed">
    <a-form layout="vertical">
      <a-form-item label="入荷数">
        <a-input-number v-model:value="addProductCount" style="width: 100%" />
      </a-form-item>
    </a-form>
  </a-modal>
  <a-modal v-model:open="prefixModalFlag" title="商品管理番号の種類管理" :footer="null">
    <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px;">
      <a-tag v-for="p in noPrefixes" :key="p" closable @close.prevent="onRemovePrefix(p)">{{ p }}</a-tag>
      <span v-if="!noPrefixes.length" style="color: #999;">種類が登録されていません</span>
    </div>
    <div style="display: flex; gap: 8px;">
      <a-input v-model:value="newPrefix" placeholder="追加する種類（英字のみ、例：AY）" @pressEnter="submitNewPrefix" />
      <a-button type="primary" @click="submitNewPrefix">追加</a-button>
    </div>
    <div v-if="prefixError" style="color: #ff4d4f; margin-top: 8px;">{{ prefixError }}</div>
    <p style="color: #999; margin-top: 12px;">※ タグの × で削除できます。削除した種類で絞り込み中だった場合は絞り込みが解除されます。追加・削除は自動で保存されます。</p>
  </a-modal>
  <a-modal v-model:open="refDetailFlag" :title="'参照詳細（' + refDetailProductNo + '）'" :footer="null">
    <template v-if="refDetailProduct">
      <div class="ref-detail-block">
        <div class="ref-detail-head">
          <span class="ref-detail-name">メルカリ</span>
          <a-button size="small" @click="refDetailFlag = false; openMercariBinding(refDetailProduct.product_no)">バインド変更</a-button>
        </div>
        <template v-if="refDetailProduct.mercari_ref">
          <div class="ref-detail-line">参照：<a class="link" @click="urlClick(refDetailProduct.mercari_ref)">{{ refDetailProduct.mercari_ref }}</a></div>
          <div class="ref-detail-line">自動補充：{{ refDetailProduct.auto_restock ? 'ON' : 'OFF' }}</div>
          <div v-if="refDetailProduct.list_error" class="ref-detail-line" style="color: #ff4d4f;">エラー：{{ refDetailProduct.list_error }}</div>
        </template>
        <div v-else class="ref-none">未設定</div>
      </div>
      <div class="ref-detail-block">
        <div class="ref-detail-head">
          <span class="ref-detail-name">Yahoo!オークション</span>
          <a-button size="small" @click="refDetailFlag = false; openYahooBinding(refDetailProduct.product_no)">バインド変更</a-button>
        </div>
        <template v-if="refDetailProduct.yahoo_ref">
          <div class="ref-detail-line">参照：<a class="link" @click="urlClick(refDetailProduct.yahoo_ref)">{{ refDetailProduct.yahoo_ref }}</a></div>
          <div class="ref-detail-line">自動補充：{{ refDetailProduct.yahoo_auto_restock ? 'ON' : 'OFF' }}</div>
          <div v-if="refDetailProduct.yahoo_list_error" class="ref-detail-line" style="color: #ff4d4f;">エラー：{{ refDetailProduct.yahoo_list_error }}</div>
        </template>
        <div v-else class="ref-none">未設定</div>
      </div>
    </template>
  </a-modal>
</template>

<style lang="less" scoped>
.toolbar {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin: 8px 0 14px;
}
.link {
  color: #2e6be6;
  cursor: pointer;
}
.thumb {
  :deep(img) {
    border-radius: 6px;
    border: 1px solid #eceef1;
    object-fit: cover;
  }
}
.name-cell {
  font-weight: 500;
  color: #1f2329;
}
.content-cell {
  color: #5f6672;
}
.stock-num {
  font-weight: 600;
}
.ops {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ops-row {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  align-items: center;
}
.expanded {
  padding: 2px 8px;
}
.expanded-name {
  font-weight: 600;
  margin-bottom: 6px;
}
.ref-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ref-tags {
  display: flex;
  gap: 4px;
}
.ref-none {
  color: #b6bcc6;
}
.refs-cell {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  cursor: pointer;
}
.ref-detail-block {
  padding: 10px 0;
  border-bottom: 1px solid #f0f0f0;
}
.ref-detail-block:last-child {
  border-bottom: none;
}
.ref-detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.ref-detail-name {
  font-weight: 600;
}
.ref-detail-line {
  margin: 2px 0;
  word-break: break-all;
}
.editable-cell {
  position: relative;

  .editable-cell-input-wrapper,
  .editable-cell-text-wrapper {
    padding-right: 24px;
  }

  .editable-cell-text-wrapper {
    padding: 5px 24px 5px 5px;
  }

  .editable-cell-icon,
  .editable-cell-icon-check {
    position: absolute;
    right: 0;
    width: 20px;
    cursor: pointer;
  }

  .editable-cell-icon {
    margin-top: 4px;
    display: none;
  }

  .editable-cell-icon-check {
    line-height: 28px;
  }

  .editable-cell-icon:hover,
  .editable-cell-icon-check:hover {
    color: #2e6be6;
  }

  .editable-add-btn {
    margin-bottom: 8px;
  }
}
.editable-cell:hover .editable-cell-icon {
  display: inline-block;
}
</style>
