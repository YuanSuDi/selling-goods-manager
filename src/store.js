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

export const selledItem = (product_no) => {
  let data = { product_no: product_no, sku: 0, selled_num: 0 }
  for (let i = 0; i < dataSource.value.length; i++) {
    if (dataSource.value[i].product_no === product_no) {
      dataSource.value[i].sku = dataSource.value[i].sku - 1
      dataSource.value[i].selled_num = dataSource.value[i].selled_num + 1
      data.sku = dataSource.value[i].sku
      data.selled_num = dataSource.value[i].selled_num
      break
    }
  }
  ipc.send('selledItem', data)
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
  successMsg.value = `Mercari売却を検出しました（${sale.product_no}、在庫残 ${sale.sku}）`
  successFlg.value = true
})

export const selectMainImage = () => ipc.send('select_main_image')
ipc.on('main_image_selected', (e, filePath) => {
  if (filePath) editInfoByMainImg.value = filePath
})
