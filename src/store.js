// 共有ストア（旧 HelloWorld.vue の単一ファイル構成から分割）。
// 複数コンポーネントで使う状態・IPC 通信・共通アクションをここに集約する。
// 各 ref / 関数の名前と挙動は分割前と同一（コンポーネント側は import して使う）。
import { ref, reactive, computed, watch } from 'vue'
import { cloneDeep } from 'lodash-es'
import { normalizeProductImageUrl } from './utils/product-image'

// 主图加载失败时的占位图（灰色底 + 图片图标的内嵌 SVG）
export const NO_IMAGE = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="84" height="84"><rect width="84" height="84" fill="#eef0f3"/><g fill="none" stroke="#b6bcc6" stroke-width="2"><rect x="22" y="26" width="40" height="32" rx="3"/><circle cx="32" cy="36" r="3.5"/><path d="M24 56l11-11 8 8 6-6 9 9"/></g></svg>'
)

const ipc = window.ipcRenderer

// ---- 全体で共有する状態 ----
export const dataSource = ref([])
export const activeKey = ref('1')
export const isLoading = ref(true)
export const lodingTip = ref('加载中...')
export const currentItemNo = ref('')

const listSearchStorageKey = 'selling-goods-manager:list-search'
const listSearchFilters = ['name', 'no', 'category']
function loadListSearch() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(listSearchStorageKey) || '{}')
    return {
      nameSearch: typeof saved.nameSearch === 'string' ? saved.nameSearch : '',
      searchNo: typeof saved.searchNo === 'string' ? saved.searchNo : '',
      selectedCategory: typeof saved.selectedCategory === 'string' ? saved.selectedCategory : undefined,
      activeFilter: listSearchFilters.includes(saved.activeFilter) ? saved.activeFilter : null,
    }
  } catch (error) {
    console.warn('[store] Unable to restore product search conditions:', error)
    return { nameSearch: '', searchNo: '', selectedCategory: undefined, activeFilter: null }
  }
}

export const listSearch = reactive(loadListSearch())
watch(listSearch, () => {
  try {
    window.localStorage.setItem(listSearchStorageKey, JSON.stringify(listSearch))
  } catch (error) {
    console.error('[store] Unable to save product search conditions:', error)
  }
}, { deep: true, flush: 'sync' })

export const applyListSearch = () => {
  if (listSearch.activeFilter === 'name') {
    isLoading.value = true
    ipc.send('searchByName', listSearch.nameSearch)
  } else if (listSearch.activeFilter === 'no') {
    lodingTip.value = '検索中...'
    isLoading.value = true
    ipc.send('searchByNo', listSearch.searchNo)
  } else if (listSearch.activeFilter === 'category' && listSearch.selectedCategory) {
    isLoading.value = true
    ipc.send('searchBySelectNo', listSearch.selectedCategory)
  }
}

// ---- 商品管理番号の種類（接頭辞）リスト ----
// 初期値は従来コードに直書きされていた種類。追加・削除は商品一覧の
// ツールバー「種類管理」から行い、検索条件と同じく localStorage に保存する。
const noPrefixStorageKey = 'selling-goods-manager:no-prefixes'
const defaultNoPrefixes = ['A', 'B', 'O', 'M', 'OT', 'C', 'D', 'E', 'F', 'G']
function loadNoPrefixes() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(noPrefixStorageKey) || 'null')
    if (Array.isArray(saved)) {
      return [...new Set(
        saved
          .filter((p) => typeof p === 'string')
          .map((p) => p.trim().toUpperCase())
          .filter((p) => /^[A-Z]+$/.test(p))
      )]
    }
  } catch (error) {
    console.warn('[store] Unable to restore product number prefixes:', error)
  }
  return [...defaultNoPrefixes]
}
export const noPrefixes = ref(loadNoPrefixes())
watch(noPrefixes, () => {
  try {
    window.localStorage.setItem(noPrefixStorageKey, JSON.stringify(noPrefixes.value))
  } catch (error) {
    console.error('[store] Unable to save product number prefixes:', error)
  }
}, { deep: true })
export const addNoPrefix = (raw) => {
  const prefix = String(raw || '').trim().toUpperCase()
  if (!/^[A-Z]+$/.test(prefix)) {
    return { ok: false, error: '種類は英字のみで入力してください（例：AY）' }
  }
  if (noPrefixes.value.includes(prefix)) {
    return { ok: false, error: 'その種類は既に登録されています' }
  }
  noPrefixes.value = [...noPrefixes.value, prefix]
  return { ok: true, prefix }
}
export const removeNoPrefix = (raw) => {
  const prefix = String(raw || '').trim().toUpperCase()
  noPrefixes.value = noPrefixes.value.filter((p) => p !== prefix)
  // 削除した種類で絞り込み中だった場合は、絞り込みを解除して全件に戻す
  if (listSearch.selectedCategory === prefix) {
    clearCategoryFilter()
  }
}
export const clearCategoryFilter = () => {
  listSearch.selectedCategory = undefined
  if (listSearch.activeFilter === 'category') {
    listSearch.activeFilter = null
    isLoading.value = true
    ipc.send('ping')
  }
}

// 提示消息（エラー / 成功）
export const alertDisFlg = ref(false)
export const alertMsg = ref('test')
export const successFlg = ref(false)
export const successMsg = ref('')
export const alertDisFlgHandleClose = () => {
  alertDisFlg.value = false
}

// ---- 商品追加フォームの入力欄（3つの追加タブで共有） ----
export const product_no = ref('')
export const product_name = ref('')
export const product_content = ref('')
export const amazon_price = ref(0)
export const sku = ref(0)
export const selled_num = ref(0)
export const comment = ref('')
export const amazon_url = ref('')
export const product_img_dir = ref('')
export const product_img = ref('')

function resetProductForm() {
  product_no.value = ''
  product_name.value = ''
  product_content.value = ''
  amazon_price.value = 0
  sku.value = 0
  selled_num.value = 0
  comment.value = ''
  amazon_url.value = ''
  product_img_dir.value = ''
  product_img.value = ''
}

let initialProductLoadComplete = false

// ---- 渲染进程的监听 ----
ipc.on('pong', (e, arg) => {
  dataSource.value = arg
  isLoading.value = false
  if (!initialProductLoadComplete) {
    initialProductLoadComplete = true
    applyListSearch()
  }
})
ipc.on('products_updated', (e, arg) => {
  if (listSearch.activeFilter) {
    applyListSearch()
  } else {
    dataSource.value = arg
    isLoading.value = false
  }
})
const handleProductAdded = (arg) => {
  dataSource.value = arg
  activeKey.value = '1'
  isLoading.value = false
  resetProductForm()
  applyListSearch()
}
ipc.on('product_added', (e, arg) => {
  handleProductAdded(arg)
})
ipc.on('add_speed_product_data_success', (e, arg) => {
  handleProductAdded(arg)
})
ipc.on('screenshot', (e, arg) => {
  console.log(arg)
})
ipc.on('download_image_done', () => {
  isLoading.value = false
})
ipc.on('add_error_done', (e, msg) => {
  isLoading.value = false
  alertDisFlg.value = true
  alertMsg.value = msg
})
ipc.on('list_task_created', (e, res) => {
  if (res && res.ok) {
    successMsg.value = res.auto
      ? `自動補充：出品タスクを作成しました（${res.task.id}）。拡張機能が有効なら1分以内に実行されます。`
      : `出品タスクを作成しました（${res.task.id}）。拡張機能が有効なら1分以内に実行されます。`
    successFlg.value = true
  } else {
    alertDisFlg.value = true
    alertMsg.value = (res && res.error) || '出品タスクの作成に失敗しました。'
  }
})

ipc.send('ping')

// ---- 共通アクション ----
export const urlClick = (url) => {
  ipc.send('url', url)
}
//打开图片所在位置
export const openImgDir = (dir) => {
  ipc.send('open_dir', dir)
}

// v0.2.0: 状態を指定して販売する。在庫計算はメインプロセス側が
// 状態別在庫に対して行うため、ここでは楽観更新をしない。
export const selledItem = (product_no, condition_id) => {
  ipc.send('selledItem', { product_no, condition_id: condition_id || null })
}

//商品情报提交（手動追加）
export const submit = () => {
  lodingTip.value = '追加中...'
  isLoading.value = true
  ipc.send('add_product_data', {
    product_no: product_no.value,
    product_name: product_name.value,
    product_content: product_content.value,
    amazon_price: amazon_price.value,
    sku: sku.value,
    selled_num: selled_num.value,
    comment: comment.value,
    amazon_url: amazon_url.value,
    product_img_dir: product_img_dir.value.replace(/\\/g, '/'),
    product_img: normalizeProductImageUrl(product_img.value),
  })
}

//商品情报提交（快速追加）
export const speedSubmit = () => {
  lodingTip.value = '追加中...'
  isLoading.value = true
  ipc.send('add_speed_product_data', {
    product_no: product_no.value,
    product_name: product_name.value,
    product_content: product_content.value,
    amazon_price: amazon_price.value,
    sku: sku.value,
    selled_num: selled_num.value,
    comment: comment.value,
    amazon_url: amazon_url.value,
    product_img_dir: product_img_dir.value.replace(/\\/g, '/'),
    product_img: '',
  })
}

//单独下载图片
export const downloadSubmit = () => {
  lodingTip.value = 'ダウンロード中...'
  isLoading.value = true
  ipc.send('download_image', {
    amazon_url: amazon_url.value,
    product_img_dir: product_img_dir.value.replace(/\\/g, '/'),
  })
  resetProductForm()
}

// ---- 商品情報編集モーダルの状態と開く処理 ----
export const editInfoFlag = ref(false)
export const editInfoByTitle = ref('')
export const editInfoByContent = ref('')
export const editInfoByPrice = ref(0)
export const editInfoByProductNo = ref('')
export const editInfoByUrl = ref('')
export const editInfoByMainImg = ref('')

export const editInfo = (product_no) => {
  for (let i = 0; i < dataSource.value.length; i++) {
    if (dataSource.value[i].product_no === product_no) {
      editInfoByTitle.value = cloneDeep(dataSource.value[i].product_name)
      editInfoByContent.value = cloneDeep(dataSource.value[i].product_content)
      editInfoByProductNo.value = cloneDeep(dataSource.value[i].product_no)
      editInfoByPrice.value = cloneDeep(dataSource.value[i].amazon_price)
      editInfoByUrl.value = cloneDeep(dataSource.value[i].amazon_url)
      editInfoByMainImg.value = normalizeProductImageUrl(dataSource.value[i].product_img)
      editInfoFlag.value = true
      break
    }
  }
}

// ---- Mercari 商品の自動出品バインド ----
export const mercariBindingFlag = ref(false)
export const mercariBindingProductNo = ref('')
export const mercariBindingUrl = ref('')
export const mercariBindingAutoRestock = ref(false)
export const mercariBindingPending = ref(false)
export const openMercariBinding = (product_no) => {
  for (let i = 0; i < dataSource.value.length; i++) {
    if (dataSource.value[i].product_no === product_no) {
      mercariBindingProductNo.value = product_no
      mercariBindingUrl.value = dataSource.value[i].mercari_ref || ''
      mercariBindingAutoRestock.value = dataSource.value[i].mercari_ref
        ? !!dataSource.value[i].auto_restock
        : true
      mercariBindingPending.value = false
      mercariBindingFlag.value = true
      break
    }
  }
}
export const saveMercariBinding = () => {
  mercariBindingPending.value = true
  window.ipcRenderer.send('bind_mercari_item', {
    product_no: mercariBindingProductNo.value,
    itemUrl: mercariBindingUrl.value.trim(),
    auto_restock: mercariBindingAutoRestock.value,
  })
}

// ---- Yahoo!オークション商品の自動出品バインド ----
export const yahooBindingFlag = ref(false)
export const yahooBindingProductNo = ref('')
export const yahooBindingUrl = ref('')
export const yahooBindingAutoRestock = ref(false)
export const yahooBindingPending = ref(false)
export const openYahooBinding = (product_no) => {
  for (let i = 0; i < dataSource.value.length; i++) {
    if (dataSource.value[i].product_no === product_no) {
      yahooBindingProductNo.value = product_no
      yahooBindingUrl.value = dataSource.value[i].yahoo_ref || ''
      yahooBindingAutoRestock.value = dataSource.value[i].yahoo_ref
        ? !!dataSource.value[i].yahoo_auto_restock
        : true
      yahooBindingPending.value = false
      yahooBindingFlag.value = true
      break
    }
  }
}
export const saveYahooBinding = () => {
  yahooBindingPending.value = true
  window.ipcRenderer.send('bind_yahoo_item', {
    product_no: yahooBindingProductNo.value,
    itemUrl: yahooBindingUrl.value.trim(),
    auto_restock: yahooBindingAutoRestock.value,
  })
}

// ---- 参照詳細モーダル（商品一覧の「参照」列から開く） ----
export const refDetailFlag = ref(false)
export const refDetailProductNo = ref('')
export const refDetailProduct = computed(
  () => dataSource.value.find((p) => p.product_no === refDetailProductNo.value) || null
)
export const openRefDetail = (product_no) => {
  refDetailProductNo.value = product_no
  refDetailFlag.value = true
}

// ---- 連携情報モーダル ----
export const mgrInfoFlag = ref(false)
export const mgrInfo = ref({})
export const showManagerInfo = () => {
  ipc.send('get_manager_info')
}
ipc.on('manager_info', (e, info) => {
  mgrInfo.value = info || {}
  mgrInfoFlag.value = true
})
ipc.on('mercari_binding_saved', (e, result) => {
  mercariBindingPending.value = false
  if (result && result.ok) {
    mercariBindingFlag.value = false
    successMsg.value = result.itemUrl
      ? `Mercari参照を保存しました。${result.autoRestock ? '売却TODO検出後に自動出品します。' : '自动补货已关闭。'}`
      : 'Mercari参照を解除しました。'
    successFlg.value = true
  } else {
    alertMsg.value = (result && result.error) || 'Mercari商品のバインドに失敗しました。'
    alertDisFlg.value = true
  }
})
ipc.on('yahoo_binding_saved', (e, result) => {
  yahooBindingPending.value = false
  if (result && result.ok) {
    yahooBindingFlag.value = false
    successMsg.value = result.itemUrl
      ? `ヤフオク参照を保存しました。${result.autoRestock ? '売却検出後に自動出品します。' : '自动补货已关闭。'}`
      : 'ヤフオク参照を解除しました。'
    successFlg.value = true
  } else {
    alertMsg.value = (result && result.error) || 'Yahoo!オークション商品のバインドに失敗しました。'
    alertDisFlg.value = true
  }
})

// ---- 出品タスク（ヘッダーのバッジとモーダルで共有） ----
export const taskModalFlag = ref(false)
export const taskList = ref([])
export const activeTaskCount = computed(
  () => taskList.value.filter((t) => t.status === 'pending' || t.status === 'running').length
)
export const requestTaskList = () => ipc.send('list_tasks')
export const openTaskModal = () => {
  taskModalFlag.value = true
  requestTaskList()
}
ipc.on('tasks_list', (e, list) => {
  taskList.value = Array.isArray(list) ? list : []
})
ipc.send('list_tasks')

ipc.on('sale_reported', (e, sale) => {
  const platformName = sale && sale.platform === 'yahoo' ? 'ヤフオク' : 'Mercari'
  successMsg.value = `${platformName}売却を検出しました（${sale.product_no}、在庫残 ${sale.sku}）`
  successFlg.value = true
})

export const selectMainImage = () => ipc.send('select_main_image')
ipc.on('main_image_selected', (e, filePath) => {
  if (filePath) editInfoByMainImg.value = filePath
})

// ---- v0.2.0: 状態（コンディション）・出品レコード・ノード ----
// メインプロセスが正本を持ち、inventory_meta で丸ごと配信する。
export const conditions = ref([])
export const listings = ref([])
export const nodes = ref([])
ipc.on('inventory_meta', (e, meta) => {
  if (!meta) return
  conditions.value = Array.isArray(meta.conditions) ? meta.conditions : []
  listings.value = Array.isArray(meta.listings) ? meta.listings : []
  nodes.value = Array.isArray(meta.nodes) ? meta.nodes : []
})
ipc.send('get_inventory_meta')

export const defaultCondition = computed(
  () => conditions.value.find((c) => c.isDefault) || conditions.value[0] || null
)
export const conditionName = (id) => {
  const c = conditions.value.find((x) => x._id === id)
  return c ? c.name : '不明な状態'
}
export const nodeLabel = (nodeId) => {
  if (!nodeId) return '未割当'
  const n = nodes.value.find((x) => x._id === nodeId)
  if (!n) return '不明なノード'
  return n.name || ('無名（' + String(nodeId).slice(0, 6) + '）')
}
export const recordsFor = (productNo) =>
  listings.value.filter((r) => r.product_no === productNo)
export const recordsForCondition = (productNo, conditionId) =>
  listings.value.filter((r) => r.product_no === productNo && r.condition_id === conditionId)
export const conditionStock = (product, conditionId) =>
  product && product.condition_stock ? Number(product.condition_stock[conditionId] || 0) : 0
export const conditionSold = (product, conditionId) =>
  product && product.condition_sold ? Number(product.condition_sold[conditionId] || 0) : 0
export const stockedConditions = (product) => {
  if (!product || !product.condition_stock) return []
  return Object.keys(product.condition_stock)
    .filter((id) => Number(product.condition_stock[id] || 0) > 0)
    .map((id) => ({ id, name: conditionName(id), count: Number(product.condition_stock[id]) }))
}
export const platformName = (p) => (p === 'yahoo' ? 'ヤフオク' : 'メルカリ')

export const saveCondition = (data) => ipc.send('condition_save', data)
export const deleteConditionById = (id) => ipc.send('condition_delete', { id })
export const saveListing = (data) => ipc.send('listing_save', data)
export const deleteListingById = (id) => ipc.send('listing_delete', { id })
export const relistListing = (id) => ipc.send('listing_relist', { id })
export const claimListing = (id) => ipc.send('listing_claim', { id })
export const fixListingNode = (id, nodeId) => ipc.send('listing_fix_node', { id, node_id: nodeId })
export const renameNode = (nodeId, name) => ipc.send('node_rename', { nodeId, name })
export const deleteNodeById = (nodeId) => ipc.send('node_delete', { nodeId })

const handleMetaResult = (result, okText) => {
  if (result && result.ok) {
    if (okText) {
      successMsg.value = okText
      successFlg.value = true
    }
  } else {
    alertMsg.value = (result && result.error) || '操作に失敗しました。'
    alertDisFlg.value = true
  }
}
ipc.on('condition_result', (e, result) => handleMetaResult(result, '状態を更新しました。'))
ipc.on('listing_result', (e, result) =>
  handleMetaResult(
    result,
    result && result.claimed
      ? '所有権の確認タスクを作成しました。対象ブラウザが次回ポーリングで確認します。'
      : null
  )
)
ipc.on('node_result', (e, result) => handleMetaResult(result, 'ノードを更新しました。'))
ipc.on('node_mismatch', (e, info) => {
  if (!info) return
  alertMsg.value = `売却報告のブラウザとレコードの割当が一致しません（${info.product_no} / ${platformName(info.platform)}）。参照詳細でノード割当を確認してください。`
  alertDisFlg.value = true
})
ipc.on('manual_sale_multi_record', (e, info) => {
  if (!info) return
  alertMsg.value = `${info.product_no}：その状態に自動補充レコードが複数あります。参照詳細から対象レコードの「補充出品」を押してください。`
  alertDisFlg.value = true
})
