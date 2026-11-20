<script setup>
  import { ref, reactive, computed, watch } from 'vue'
  import { EditOutlined, CheckOutlined } from '@ant-design/icons-vue';
  import { cloneDeep } from 'lodash-es';
  import {
    NO_IMAGE, dataSource, isLoading, lodingTip, currentItemNo,
    urlClick, openImgDir, selledItem, editInfo,
    listSearch, noPrefixes, addNoPrefix, removeNoPrefix, clearCategoryFilter,
    refDetailFlag, refDetailProductNo, refDetailProduct, openRefDetail,
    conditions, nodes, defaultCondition, conditionName, nodeLabel,
    recordsFor, recordsForCondition, conditionStock, conditionSold, stockedConditions,
    platformName, saveCondition, deleteConditionById, saveListing, deleteListingById,
    relistListing, claimListing, fixListingNode,
  } from '../store';
  import { normalizeProductImageUrl } from '../utils/product-image'

  // ---- 自動補充フィルタ（検索結果に重ねる表示フィルタ） ----
  const autoFilter = ref('all')
  const hasAutoRestock = (p) => {
    const recs = recordsFor(p.product_no)
    if (recs.length) return recs.some((r) => r.auto_restock)
    return !!p.auto_restock
  }
  const visibleData = computed(() => {
    if (autoFilter.value === 'auto') return dataSource.value.filter(hasAutoRestock)
    if (autoFilter.value === 'none') return dataSource.value.filter((p) => !hasAutoRestock(p))
    return dataSource.value
  })

  const pagination = ref({
    position: ['bottomRight'],
    showTotal: () => `トータル件数： ${visibleData.value.length} 件`
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

  //入库添加（v0.2.0: 状態を選んで、その状態の在庫を増やす）
  let addProductFlag = ref(false);
  let addProductCount = ref(0);
  let addCondId = ref(null);
  const addProduct = product_no => {
    addProductFlag.value = true
    currentItemNo.value = product_no
    const dc = defaultCondition.value
    addCondId.value = dc ? dc._id : null
  };
  const addProductConfirmed = () => {
    addProductFlag.value = false
    const rec = dataSource.value.find((p) => p.product_no === currentItemNo.value)
    const condId = addCondId.value || (defaultCondition.value && defaultCondition.value._id)
    if (!rec || !condId) return
    const cur = rec.condition_stock ? Number(rec.condition_stock[condId] || 0) : Number(rec.sku || 0)
    let data = { product_no: currentItemNo.value, condition_id: condId, sku: cur + addProductCount.value }
    window.ipcRenderer.send('addProductCount', data)
    currentItemNo.value = ""
    addProductCount.value = 0
  }

  // ---- v0.2.0: 状態別表示ヘルパー ----
  const mapLines = (map) => {
    if (!map) return []
    return Object.keys(map)
      .filter((id) => Number(map[id] || 0) > 0)
      .map((id) => ({ id, name: conditionName(id), count: Number(map[id]) }))
  };
  const nodeOptions = computed(() => [
    { value: '', label: '未割当（既定プール）' },
    ...nodes.value.map((n) => ({ value: n._id, label: n.name || ('無名（' + String(n._id).slice(0, 6) + '）') })),
  ]);

  // ---- 1件販売（状態→売れた出品の順に選択） ----
  const salePickFlag = ref(false);
  const salePickStep = ref('condition');
  const salePickProductNo = ref('');
  const salePickCondId = ref(null);
  const salePickRecordId = ref(null);
  const salePickProduct = computed(
    () => dataSource.value.find((p) => p.product_no === salePickProductNo.value) || null
  );
  const salePickRecords = computed(() =>
    salePickCondId.value
      ? recordsForCondition(salePickProductNo.value, salePickCondId.value)
      : []
  );
  const doSell = () => {
    selledItem(salePickProductNo.value, salePickCondId.value, salePickRecordId.value)
    salePickFlag.value = false
  };
  const onSellClick = (record) => {
    const stocked = stockedConditions(record)
    if (!stocked.length) return
    salePickProductNo.value = record.product_no
    salePickCondId.value = stocked[0].id
    salePickRecordId.value = null
    if (stocked.length > 1) {
      salePickStep.value = 'condition'
      salePickFlag.value = true
      return
    }
    // 状態が1つでも、その状態の出品レコードが複数あれば売れた出品を選ぶ
    const recs = recordsForCondition(record.product_no, stocked[0].id)
    if (recs.length > 1) {
      salePickStep.value = 'record'
      salePickRecordId.value = recs[0]._id
      salePickFlag.value = true
    } else {
      selledItem(record.product_no, stocked[0].id, recs.length === 1 ? recs[0]._id : null)
    }
  };
  const confirmSalePick = () => {
    if (salePickStep.value === 'condition') {
      const recs = salePickRecords.value
      if (recs.length > 1) {
        salePickRecordId.value = recs[0]._id
        salePickStep.value = 'record'
        return
      }
      salePickRecordId.value = recs.length === 1 ? recs[0]._id : null
    }
    doSell()
  };

  // ---- 状態管理モーダル ----
  const condMgrFlag = ref(false);
  const condDrafts = reactive({});
  const newCondName = ref('');
  const openConditionManager = () => {
    conditions.value.forEach((c) => { condDrafts[c._id] = c.name })
    newCondName.value = ''
    condMgrFlag.value = true
  };
  // モーダルを開いた後に追加された状態は下書きが無いと空欄に見えるため、
  // 未登録の下書きだけを随時補う（編集中の下書きは上書きしない）。
  watch(conditions, (list) => {
    list.forEach((c) => {
      if (!(c._id in condDrafts)) condDrafts[c._id] = c.name
    })
  });
  const saveCondRename = (c) => {
    const name = String(condDrafts[c._id] || '').trim()
    if (name && name !== c.name) saveCondition({ id: c._id, name })
  };
  const addCond = () => {
    const name = newCondName.value.trim()
    if (!name) return
    saveCondition({ name })
    newCondName.value = ''
  };
  const removeCond = (c) => {
    deleteConditionById(c._id)
  };

  // ---- 出品レコード編集モーダル ----
  const listingEditFlag = ref(false);
  const listingEdit = reactive({
    id: null, product_no: '', condition_id: null, platform: 'mercari',
    listing: '', node_id: '', auto_restock: true, quota: null,
  });
  const openListingEdit = (record, conditionId) => {
    if (record) {
      listingEdit.id = record._id
      listingEdit.product_no = record.product_no
      listingEdit.condition_id = record.condition_id
      listingEdit.platform = record.platform
      listingEdit.listing = record.listing_url || record.listing_id || ''
      listingEdit.node_id = record.node_id || ''
      listingEdit.auto_restock = !!record.auto_restock
      listingEdit.quota = record.quota != null ? record.quota : null
    } else {
      listingEdit.id = null
      listingEdit.product_no = refDetailProductNo.value
      listingEdit.condition_id = conditionId
      listingEdit.platform = 'mercari'
      listingEdit.listing = ''
      listingEdit.node_id = ''
      listingEdit.auto_restock = true
      listingEdit.quota = null
    }
    listingEditFlag.value = true
  };
  const submitListingEdit = () => {
    saveListing({
      id: listingEdit.id || undefined,
      product_no: listingEdit.product_no,
      condition_id: listingEdit.condition_id,
      platform: listingEdit.platform,
      listing: listingEdit.listing,
      node_id: listingEdit.node_id || '',
      auto_restock: listingEdit.auto_restock,
      quota: listingEdit.quota === '' ? null : listingEdit.quota,
    })
    listingEditFlag.value = false
  };
  const delListingFlag = ref(false);
  const delListingTarget = ref(null);
  const askDeleteListing = (record) => {
    delListingTarget.value = record
    delListingFlag.value = true
  };
  const confirmDeleteListing = () => {
    if (delListingTarget.value) deleteListingById(delListingTarget.value._id)
    delListingFlag.value = false
    delListingTarget.value = null
  };

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
    <a-button @click="openConditionManager">状態管理</a-button>
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
    <a-select
      v-model:value="autoFilter"
      style="width: 170px"
      :options="[
        { value: 'all', label: '自動補充：すべて' },
        { value: 'auto', label: '自動補充：あり' },
        { value: 'none', label: '自動補充：なし' },
      ]"
    ></a-select>
  </div>

  <a-table :dataSource="visibleData" :columns="columns" rowKey="product_no" :pagination="pagination" :scroll="{ x: 1440 }">
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
        <template v-else>
          <span class="stock-num">{{ record.sku }}</span>
          <div v-if="mapLines(record.condition_stock).length > 1" class="stock-lines">
            <div v-for="l in mapLines(record.condition_stock)" :key="l.id">{{ l.name }} {{ l.count }}</div>
          </div>
        </template>
      </template>
      <template v-else-if="column.key === 'selled_num'">
        <span>{{ record.selled_num }}</span>
        <div v-if="mapLines(record.condition_sold).length > 1" class="stock-lines">
          <div v-for="l in mapLines(record.condition_sold)" :key="l.id">{{ l.name }} {{ l.count }}</div>
        </div>
      </template>
      <template v-else-if="column.key === 'do'">
        <div class="ops">
          <div class="ops-row">
            <a-button v-if="record.sku != 0" size="small" @click="onSellClick(record)">1件販売</a-button>
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
          <template v-if="recordsFor(record.product_no).length">
            <a-tag
              v-for="r in recordsFor(record.product_no)"
              :key="r._id"
              :color="r.error ? 'red' : (r.auto_restock ? 'green' : 'blue')"
            >{{ platformName(r.platform) }}{{ r.error ? ' エラー' : (r.auto_restock ? ' 自動' : '') }}{{ r.node_id ? ' ·' + nodeLabel(r.node_id) : '' }}</a-tag>
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
      <a-form-item label="状態">
        <a-select
          v-model:value="addCondId"
          style="width: 100%"
          :options="conditions.map((c) => ({ value: c._id, label: c.name + (c.isDefault ? '（既定）' : '') }))"
        />
      </a-form-item>
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
  <a-modal v-model:open="refDetailFlag" :title="'参照詳細（' + refDetailProductNo + '）'" :footer="null" width="760px">
    <template v-if="refDetailProduct">
      <p style="color: #999; margin-top: 0;">状態ごとに在庫と出品レコード（プラットフォーム × ブラウザ）を管理します。</p>
      <div v-for="cond in conditions" :key="cond._id" class="ref-detail-block">
        <div class="ref-detail-head">
          <span class="ref-detail-name">
            {{ cond.name }}
            <a-tag v-if="cond.isDefault" color="default">既定</a-tag>
          </span>
          <span class="ref-detail-stock">在庫 {{ conditionStock(refDetailProduct, cond._id) }} / 販売 {{ conditionSold(refDetailProduct, cond._id) }}</span>
          <a-button size="small" @click="openListingEdit(null, cond._id)">レコード追加</a-button>
        </div>
        <div
          v-for="r in recordsForCondition(refDetailProduct.product_no, cond._id)"
          :key="r._id"
          class="rec-row"
        >
          <div class="rec-main">
            <a-tag :color="r.error ? 'red' : (r.auto_restock ? 'green' : 'blue')">{{ platformName(r.platform) }}</a-tag>
            <a class="link" @click="urlClick(r.listing_url)">{{ r.listing_id }}</a>
            <span class="rec-meta">ノード：{{ nodeLabel(r.node_id) }}</span>
            <span class="rec-meta">自動補充：{{ r.auto_restock ? 'ON' : 'OFF' }}</span>
            <span class="rec-meta">配額：{{ r.quota != null ? r.quota : '無制限' }}（販売 {{ r.sold_count || 0 }}）</span>
          </div>
          <div v-if="r.error" class="rec-error">エラー：{{ r.error }}</div>
          <div class="rec-ops">
            <a-button size="small" @click="openListingEdit(r)">編集</a-button>
            <a-button
              size="small"
              :disabled="conditionStock(refDetailProduct, cond._id) <= 0"
              @click="relistListing(r._id)"
            >補充出品</a-button>
            <a-button v-if="!r.node_id" size="small" @click="claimListing(r._id)">所有権を確認</a-button>
            <a-select
              size="small"
              style="width: 170px"
              :value="r.node_id || ''"
              :options="nodeOptions"
              @change="(v) => fixListingNode(r._id, v)"
            />
            <a-button size="small" danger @click="askDeleteListing(r)">削除</a-button>
          </div>
        </div>
        <div v-if="!recordsForCondition(refDetailProduct.product_no, cond._id).length" class="ref-none">レコードなし</div>
      </div>
    </template>
  </a-modal>

  <a-modal v-model:open="salePickFlag" :title="salePickStep === 'condition' ? '販売する状態を選択' : '売れた出品を選択'" @ok="confirmSalePick">
    <a-radio-group v-if="salePickStep === 'condition' && salePickProduct" v-model:value="salePickCondId" style="display: flex; flex-direction: column; gap: 8px;">
      <a-radio v-for="c in stockedConditions(salePickProduct)" :key="c.id" :value="c.id">
        {{ c.name }}（在庫 {{ c.count }}）
      </a-radio>
    </a-radio-group>
    <template v-else>
      <a-radio-group v-model:value="salePickRecordId" style="display: flex; flex-direction: column; gap: 8px;">
        <a-radio v-for="r in salePickRecords" :key="r._id" :value="r._id">
          {{ platformName(r.platform) }} {{ r.listing_id }}（{{ nodeLabel(r.node_id) }}）<span v-if="!r.auto_restock"> ※自動補充OFF</span>
        </a-radio>
      </a-radio-group>
      <p style="color: #8a919c; font-size: 12px; margin-top: 8px;">売れたのは1点だけです。補充されるのは、ここで選んだ出品だけです。</p>
    </template>
  </a-modal>

  <a-modal v-model:open="condMgrFlag" title="状態管理" :footer="null">
    <div v-for="c in conditions" :key="c._id" class="cond-row">
      <a-input v-model:value="condDrafts[c._id]" style="flex: 1" />
      <a-tag v-if="c.isDefault" color="default">既定</a-tag>
      <a-button size="small" @click="saveCondRename(c)">保存</a-button>
      <a-button size="small" danger :disabled="c.isDefault" @click="removeCond(c)">削除</a-button>
    </div>
    <div style="display: flex; gap: 8px; margin-top: 12px;">
      <a-input v-model:value="newCondName" placeholder="新しい状態（例：九成新）" @pressEnter="addCond" />
      <a-button type="primary" @click="addCond">追加</a-button>
    </div>
    <p style="color: #999; margin-top: 12px;">※ 名前の変更は表示だけに効きます。在庫やレコードがある状態、既定の状態は削除できません。</p>
  </a-modal>

  <a-modal
    v-model:open="listingEditFlag"
    :title="listingEdit.id ? 'レコード編集' : 'レコード追加'"
    @ok="submitListingEdit"
  >
    <a-form layout="vertical">
      <a-form-item label="プラットフォーム">
        <a-select
          v-model:value="listingEdit.platform"
          :disabled="!!listingEdit.id"
          :options="[{ value: 'mercari', label: 'メルカリ' }, { value: 'yahoo', label: 'ヤフオク' }]"
        />
      </a-form-item>
      <a-form-item label="商品リンクまたはID">
        <a-input v-model:value="listingEdit.listing" placeholder="例：https://jp.mercari.com/item/m12345678901 / w123456789" />
      </a-form-item>
      <a-form-item label="ノード（ブラウザ）">
        <a-select v-model:value="listingEdit.node_id" :options="nodeOptions" />
      </a-form-item>
      <a-form-item label="自動補充">
        <a-switch v-model:checked="listingEdit.auto_restock" />
      </a-form-item>
      <a-form-item label="配額（このレコードが売れる上限、空欄＝無制限）">
        <a-input-number v-model:value="listingEdit.quota" style="width: 100%" :min="0" placeholder="無制限" />
      </a-form-item>
    </a-form>
  </a-modal>

  <a-modal v-model:open="delListingFlag" title="レコード削除確認" @ok="confirmDeleteListing">
    <p>この出品レコードを削除してよろしいですか。（プラットフォーム側の出品は削除されません）</p>
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
.stock-lines {
  font-size: 11px;
  color: #8a919c;
  line-height: 1.5;
}
.ref-detail-stock {
  color: #5f6672;
  font-size: 12px;
}
.rec-row {
  padding: 8px 10px;
  margin: 6px 0;
  border: 1px solid #eceef1;
  border-radius: 8px;
}
.rec-main {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.rec-meta {
  color: #5f6672;
  font-size: 12px;
}
.rec-error {
  color: #ff4d4f;
  font-size: 12px;
  margin-top: 4px;
  word-break: break-all;
}
.rec-ops {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
  margin-top: 8px;
}
.cond-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
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
