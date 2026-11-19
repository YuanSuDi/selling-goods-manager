'use strict'

import { app, protocol, BrowserWindow, ipcMain,shell ,dialog,desktopCapturer, net, Menu, clipboard  } from 'electron'
import  fs   from 'fs'
import { exec  } from 'child_process'
import { pathToFileURL } from 'url'
import { pipeline } from 'stream/promises'
import { autoUpdater } from 'electron-updater'

// createProtocol の自前実装（旧 vue-cli-plugin-electron-builder/lib の置き換え）。
// 新しい Electron では registerFileProtocol が廃止されたため protocol.handle を使う。
// app:// へのリクエストを、アプリのフォルダ（__dirname）内のファイルで返す。
function createProtocol(scheme) {
  protocol.handle(scheme, (request) => {
    let filePath = '/index.html'
    try {
      const u = new URL(request.url)
      if (u.pathname && u.pathname !== '/') filePath = decodeURIComponent(u.pathname)
    } catch (e) {}
    return net.fetch(pathToFileURL(path.join(__dirname, filePath)).href)
  })
}
import axios from 'axios';
import path from 'path';
import puppeteer from 'puppeteer-core';
import crypto from 'crypto';
import Datastore from 'nedb';
import { createManagerServer } from './manager-server';
import { productImagePathFromRequest } from './utils/product-image'
const { prepareUserDataDirectory } = require('./utils/user-data')


const isDevelopment = process.env.NODE_ENV !== 'production'
let db = null
let getAll = null
let tasksDb = null
let userDataDir = ''

function getChromiumExecutablePath() {
  const chromiumRelativePath = path.join(
    'app',
    '.local-chromium',
    'win64-1045629',
    'chrome-win',
    'chrome.exe'
  )
  const candidates = [
    path.join(path.dirname(app.getPath('exe')), chromiumRelativePath),
    path.join(app.getAppPath(), chromiumRelativePath),
    path.resolve(chromiumRelativePath),
  ]
  const executablePath = candidates.find((candidate) => fs.existsSync(candidate))
  if (!executablePath) {
    throw new Error('Bundled Chromium is missing. Expected app/.local-chromium/win64-1045629/chrome-win/chrome.exe.')
  }
  return executablePath
}

function reportImageWorkflowError(sender, operation, error) {
  console.error(`[${operation}] failed`, error)
  if (!sender || sender.isDestroyed()) return
  const detail = error && error.message ? error.message : String(error)
  sender.send('add_error_done', `${operation}失败：${detail}`)
}

// ---- 出品管理プログラム連携サーバ（FurimaCopy 拡張との通信、v0.9.0） --------
// localhost 専用の小さな HTTP サーバを立て、拡張機能へ「自動出品タスク」を
// 渡す。トークンは初回起動時に生成してユーザーデータ領域に保存する
// （拡張機能のポップアップに同じトークンを入力して使う）。
// タスクは tasks.db にも保存し、再起動時に pending 分を復元する。
let managerServer = null
let managerInfo = { port: 17341, token: '', running: false }

// Mercari の参照商品 URL を正規化する。完全な URL でも、m から始まる
// 商品 ID だけでも受け付ける。解釈できなければ null。
function normalizeMercariUrl(input) {
  if (!input) return null
  const s = String(input).trim()
  const m = s.match(/jp\.mercari\.com\/item\/(m\d+)/) || s.match(/^(m\d+)$/)
  return m ? 'https://jp.mercari.com/item/' + m[1] : null
}

// 同じ商品番号または同じMercari商品IDの再出品タスクが実行待ち・実行中なら true。
function hasActiveRelistTask(product_no, itemUrl) {
  if (!managerServer) return false
  for (const t of managerServer.tasks.values()) {
    if (
      t.type === 'relist' &&
      (t.status === 'pending' || t.status === 'running') &&
      (
        (product_no != null && t.product_no === product_no) ||
        (itemUrl && normalizeMercariUrl(t.itemUrl) === itemUrl)
      )
    ) {
      return true
    }
  }
  return false
}

// 参照商品をブラウザでコピーして再出品するタスクを作る。
function createRelistTask(product, autoSubmit, trigger) {
  if (!managerServer) throw new Error('連携サーバが起動していません')
  const itemUrl = normalizeMercariUrl(product.mercari_ref)
  if (!itemUrl) throw new Error('参照商品のURLが未設定です')
  if (hasActiveRelistTask(product.product_no, itemUrl)) {
    throw new Error('同じ商品番号またはMercari商品IDの出品タスクが既に実行待ちです')
  }
  const task = managerServer.addTask({
    product_no: product.product_no,
    platform: 'mercari',
    type: 'relist',
    itemUrl,
    autoSubmit: !!autoSubmit,
    trigger: trigger || 'manual',
  })
  sendTaskList()
  return task
}

// 商品データの変更後、レンダラが現在の検索条件で再取得できるよう通知する。
function refreshRenderer() {
  if (window && !window.isDestroyed()) {
    window.webContents.send('products_updated', getAll())
  }
}

// レンダラーへ最新のタスク一覧を送る（タスク管理画面用）
function sendTaskList() {
  if (!window || window.isDestroyed()) return
  const list = managerServer
    ? [...managerServer.tasks.values()].sort((a, b) =>
        String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
      )
    : []
  window.webContents.send('tasks_list', list)
}

function startManagerServer() {
  if (managerServer) return
  const cfgPath = path.join(userDataDir, 'manager.json')
  let cfg = {}
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (!cfg.token) {
    cfg.token = crypto.randomBytes(16).toString('hex')
    cfg.port = cfg.port || 17341
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
  }
  managerInfo = { port: cfg.port || 17341, token: cfg.token, running: false }
  const persistTask = (task) => {
    tasksDb.update({ id: task.id }, task, { upsert: true }, () => {})
  }
  // 再出品タスクの結果を受けたら、商品の参照 URL を新しい出品 URL で
  // 上書きする（成功時）。失敗時はエラー内容を商品に残し、自動では
  // 再試行しない（次は手動で出品し直す）。
  const handleTaskResult = (task) => {
    persistTask(task)
    sendTaskList()
    if (!task || task.type !== 'relist' || !task.product_no) return
    if (task.result && task.result.ok) {
      const listingUrl = normalizeMercariUrl(task.result.listingUrl)
      const sourceUrl = normalizeMercariUrl(task.itemUrl)
      if (!listingUrl || listingUrl === sourceUrl) {
        const detail = task.result.message &&
          !String(task.result.message).includes('参照 URL は更新されていません')
          ? ' ' + task.result.message
          : ''
        const msg = '出品結果の URL が無効または参照元と同一のため、参照 URL は更新されていません。' + detail
        db.update(
          { product_no: task.product_no },
          { $set: { list_error: msg } },
          () => refreshRenderer()
        )
        return
      }
      db.update(
        { product_no: task.product_no },
        {
          $set: {
            mercari_ref: listingUrl,
            list_error: null,
          },
        },
        () => refreshRenderer()
      )
    } else {
      const msg = (task.result && task.result.message) || '出品に失敗しました'
      db.update(
        { product_no: task.product_no },
        { $set: { list_error: msg } },
        () => refreshRenderer()
      )
    }
  }
  const handleSaleReported = async (sale) => {
    const itemId = String(sale.itemId || '')
    if (!itemId) return { ok: false, matched: false }
    const escapedItemId = itemId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const product = await new Promise((resolve, reject) => {
      db.findOne(
        {
          mercari_ref: new RegExp(
            '(?:^|/)item/' + escapedItemId + '(?:[/?#]|$)|^' + escapedItemId + '$',
            'i'
          ),
        },
        (err, doc) => err ? reject(err) : resolve(doc)
      )
    })
    if (!product) return { ok: true, matched: false, itemId }

    // 同じ出品は一度しか売れないため、処理済みの商品 ID の売却報告は
    // 二度目以降を在庫に反映しない（発送までやることリストに残り続け、
    // スキャンが繰り返し報告しても二重に引かないようにする）。
    if (product.last_processed_sale_item_id === itemId) {
      return { ok: true, matched: true, duplicate: true, itemId, product_no: product.product_no }
    }

    const newSku = Math.max(0, Number(product.sku || 0) - 1)
    const newSoldNum = Number(product.selled_num || 0) + 1
    const updatedCount = await new Promise((resolve, reject) => {
      db.update(
        {
          product_no: product.product_no,
          mercari_ref: product.mercari_ref,
          last_processed_sale_item_id: { $ne: itemId },
        },
        {
          $set: {
            sku: newSku,
            selled_num: newSoldNum,
            list_error: null,
            last_processed_sale_item_id: itemId,
          },
        },
        {},
        (err, count) => err ? reject(err) : resolve(count)
      )
    })
    if (!updatedCount) {
      return { ok: true, matched: false, itemId }
    }
    if (newSku > 0 && product.auto_restock && product.mercari_ref) {
      try {
        createRelistTask(
          Object.assign({}, product, { sku: newSku, selled_num: newSoldNum }),
          true,
          'mercari-todo'
        )
      } catch (e) {
        console.warn('[manager] sale restock skipped:', e && e.message)
      }
    }
    refreshRenderer()
    if (window && !window.isDestroyed()) {
      window.webContents.send('sale_reported', {
        ok: true,
        itemId,
        product_no: product.product_no,
        sku: newSku,
        selled_num: newSoldNum,
      })
    }
    return { ok: true, matched: true, product_no: product.product_no, sku: newSku, selled_num: newSoldNum }
  }
  managerServer = createManagerServer({
    port: managerInfo.port,
    token: managerInfo.token,
    imageRoots: [],
    onTaskCreated: persistTask,
    onTaskResult: handleTaskResult,
    onSaleReported: handleSaleReported,
  })
  managerServer.listen().then(() => {
    managerInfo.running = true
    console.log('[manager] listening on 127.0.0.1:' + managerInfo.port)
    // 全状態のタスクを復元する（claim できるのは pending のみ）。
    // タスク管理画面で履歴も見られるようにするため。
    tasksDb.find({}, (err, docs) => {
      if (!err && docs) docs.forEach((t) => managerServer.restore(t))
    })
  }).catch((e) => console.error('[manager] listen failed', e))
}
// Scheme must be registered before the app is ready
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { secure: true, standard: true } },
  { scheme: 'imgp', privileges: { secure: true, standard: true } }
])
let window
async function createWindow() {

  // Create the browser window.
  const windowTitle = `商品管理程序 v${app.getVersion()}`
  window = new BrowserWindow({
    width: 1380,
    height: 1000,
    title: windowTitle,
    webPreferences: {
      nodeIntegration:true,
      contextIsolation: false,
      sandbox: false,
      preload: path.join(__static, 'preload.js')
    },
    icon:path.join(__static, "app.ico"),
    autoHideMenuBar: true
  })
  window.on('page-title-updated', (event) => {
    event.preventDefault()
    window.setTitle(windowTitle)
  })

  // 右クリックメニュー。Electron はブラウザと違い標準でコンテキスト
  // メニューを出さないため、ここで自前に付ける。入力欄では編集セット、
  // それ以外の場所でも「テキストを選択中ならコピー」「リンクなら
  // アドレスをコピー」「画像なら画像をコピー」を出す。
  window.webContents.on('context-menu', (e, params) => {
    const { isEditable, selectionText, editFlags, mediaType, srcURL, linkURL, x, y } = params
    const hasSelection = !!selectionText && selectionText.trim().length > 0
    const template = []
    if (mediaType === 'image' && srcURL) {
      template.push({
        label: '画像をコピー',
        click: () => window.webContents.copyImageAt(x, y),
      })
    }
    if (linkURL) {
      template.push({
        label: 'リンクのアドレスをコピー',
        click: () => clipboard.writeText(linkURL),
      })
    }
    if (template.length) template.push({ type: 'separator' })
    if (isEditable) {
      template.push(
        { label: '切り取り', role: 'cut', enabled: !!editFlags.canCut },
        { label: 'コピー', role: 'copy', enabled: !!editFlags.canCopy },
        { label: '貼り付け', role: 'paste', enabled: !!editFlags.canPaste },
        { type: 'separator' },
        { label: 'すべて選択', role: 'selectAll', enabled: !!editFlags.canSelectAll }
      )
    } else if (hasSelection) {
      template.push({ label: 'コピー', role: 'copy', enabled: !!editFlags.canCopy })
    }
    if (!template.length) return
    Menu.buildFromTemplate(template).popup({ window })
  })
  // 商品检索

  ipcMain.on('ping', (e, args) => {
    e.sender.send('pong', getAll())
  })

  //新增
  ipcMain.on('add_product_data', (e, data) => {
    db.findOne({product_no:data.product_no}, async (e1, data1) => {
      if(data1 != null) {
        e.sender.send('add_error_done', `商品管理番号：${data1.product_no}が存在してます。`)
      } else {
          db.insert(data, function(err, doc) {
            e.sender.send('product_added', getAll())
          })
      }
    });
  })

  //删除
  ipcMain.on('deleteItem', (e, data) => {
    db.remove({product_no: data}, function (err, num) {
      e.sender.send('products_updated', getAll())
    })
  })

  ipcMain.on('add_speed_product_data', (e, data) => {
    //番号が存在するチェック
    db.findOne({product_no:data.product_no}, (findError, data1) => {
      if (findError) {
        reportImageWorkflowError(e.sender, '快速追加', findError)
        return
      }
      if(data1 != null) {
        e.sender.send('add_error_done', `商品管理番号：${data1.product_no}が存在してます。`)
      } else {
        if(data.product_no == "" || data.amazon_url == "" || data .product_img_dir == "") {
          e.sender.send('add_error_done', "商品管理番号、Amazon商品リンク、写真パスを全部入力してください。")
        } else {
          ;(async () => {
            try {
              const downData = await downloadImg(data.amazon_url, data.product_img_dir)
              data.product_img = downData.mainImgPath
              data.product_name = downData.title
              data.product_content = downData.content
              data.amazon_price = downData.price
              db.insert(data, function(err) {
                if (err) {
                  reportImageWorkflowError(e.sender, '快速追加', err)
                } else if (!e.sender.isDestroyed()) {
                  e.sender.send('add_speed_product_data_success', getAll())
                }
              })
            } catch (error) {
              reportImageWorkflowError(e.sender, '快速追加', error)
            }
          })()
        }
      }
    });
  })

  ipcMain.on('download_image', (e, data) => {
    ;(async () => {
      try {
        if (!data || !data.amazon_url || !data.product_img_dir) {
          throw new Error('Amazon商品リンクと写真パスを入力してください。')
        }
        await onlyDownloadImg(data.amazon_url, data.product_img_dir)
        if (!e.sender.isDestroyed()) e.sender.send('download_image_done')
      } catch (error) {
        reportImageWorkflowError(e.sender, '商品画像ダウンロード', error)
      }
    })()
  })

  //按名称检索
  ipcMain.on('searchByName', (e, data) => {
    db.find({"$or":[{product_name: new RegExp(data, 'i')}, {product_content: new RegExp(data, 'i')}]}).sort({product_no:1}).exec((err, docs) => {
      if (err) {
        console.error('Error executing query:', err);
        return;
      }
      e.sender.send('pong', docs)
    });
  })

  //按编号检索
  ipcMain.on('searchByNo', (e, data) => {
    db.find({"$or":[{product_no: new RegExp(data, 'i')}] }).sort({product_no:1}).exec((err, docs) => {
      if (err) {
        console.error('Error executing query:', err);
        return;
      }
      e.sender.send('pong', docs)
    });
  })

  //按编号选择
  ipcMain.on('searchBySelectNo', (e, data) => {
    db.find({product_no: new RegExp(`^${data}\\d+.*`, 'i')}).sort({product_no:1}).exec((err, docs) => {
      if (err) {
        console.error('Error executing query:', err);
        return;
      }
      e.sender.send('pong', docs)
    });
  })

  //打开亚马逊链接
  ipcMain.on('url', (e, url) => {
    shell.openExternal(url);
  })

  //打开文件夹
  ipcMain.on('open_dir', (e, folderPath) => {
    openFolder(folderPath);
  })

  ipcMain.on('open_user_data_folder', async () => {
    try {
      const error = await shell.openPath(userDataDir)
      if (error) throw new Error(error)
    } catch (error) {
      console.error('[storage] failed to open user data folder', error)
      dialog.showErrorBox(
        '无法打开用户数据文件夹',
        error && error.message ? error.message : String(error)
      )
    }
  })

  ipcMain.on('select_main_image', async (e) => {
    const result = await dialog.showOpenDialog(window, {
      title: 'メイン商品画像を選択',
      properties: ['openFile'],
      filters: [{ name: '画像', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
    })
    if (!result.canceled && result.filePaths && result.filePaths[0]) {
      e.sender.send('main_image_selected', result.filePaths[0])
    }
  })

  //商品入库
  ipcMain.on('addProductCount', (e, data) => {
    db.update({product_no: data.product_no}, {
      $set: {
          sku: data.sku,
      },
    })
  })

    //商品售出
  ipcMain.on('selledItem', (e, data) => {
    db.update({product_no: data.product_no}, {
      $set: {
          sku: data.sku,
          selled_num:data.selled_num
      },
    }, () => {
      // 自動補充: 参照 URL があり自動補充 ON で、在庫がまだ残っている
      // 商品は、売れたタイミングで次の再出品タスクを自動作成する。
      if (!managerServer) return
      db.findOne({product_no: data.product_no}, (e2, product) => {
        if (!product) return
        if (!product.auto_restock || !product.mercari_ref) return
        if (!(data.sku > 0)) return
        try {
          const task = createRelistTask(product, true, 'manual-sale')
          db.update({product_no: data.product_no}, { $set: { list_error: null } })
          if (window && !window.isDestroyed()) {
            window.webContents.send('list_task_created', { ok: true, task, auto: true })
          }
        } catch (err) {
          console.warn('[manager] auto restock skipped:', err && err.message)
        }
      })
    })
  })

   //保存备注
   ipcMain.on('saveComment', (e, data) => {
    db.update({product_no: data.product_no}, {
      $set: {
        comment: data.comment,
      },
    })
  })

   //编辑商品情报
   ipcMain.on('editInfo', (e, data) => {
    const $set = {
      product_name: data.product_name,
      product_content: data.product_content,
      amazon_price: data.amazon_price,
       amazon_url: data.amazon_url,
    }
     if (data.product_img !== undefined) $set.product_img = data.product_img
    db.update({product_no: data.product_no}, { $set }, (err) => {
      if (err) console.error('[manager] failed to update product:', err)
      else refreshRenderer()
    })
  })

  //連携情報（ポートとトークン）を返す。拡張機能側の設定に使う。
  ipcMain.on('get_manager_info', (e) => {
    e.sender.send('manager_info', managerInfo)
  })

  ipcMain.on('bind_mercari_item', (e, data) => {
    const binding = data || {}
    const productNo = String(binding.product_no || '').trim()
    const rawItemUrl = String(binding.itemUrl || '').trim()
    const itemUrl = rawItemUrl ? normalizeMercariUrl(rawItemUrl) : null
    const autoRestock = !!binding.auto_restock
    if (!productNo) {
      e.sender.send('mercari_binding_saved', { ok: false, error: '商品管理番号が指定されていません。' })
      return
    }
    if ((rawItemUrl && !itemUrl) || (autoRestock && !itemUrl)) {
      e.sender.send('mercari_binding_saved', {
        ok: false,
        error: '有効な Mercari 商品 URL または商品 ID を入力してください。',
      })
      return
    }
    db.findOne({ product_no: productNo }, (findErr, product) => {
      if (findErr || !product) {
        if (findErr) console.error('[manager] failed to find product for Mercari binding:', findErr)
        e.sender.send('mercari_binding_saved', {
          ok: false,
          error: findErr ? '商品情報の読み込みに失敗しました。' : '商品が見つかりません。',
        })
        return
      }
      const $set = { mercari_ref: itemUrl, auto_restock: autoRestock }
      db.update({ product_no: product.product_no }, { $set }, (updateErr) => {
        if (updateErr) {
          console.error('[manager] failed to save Mercari binding:', updateErr)
          e.sender.send('mercari_binding_saved', {
            ok: false,
            error: 'Mercari 绑定保存失败。',
          })
          return
        }
        refreshRenderer()
        e.sender.send('mercari_binding_saved', { ok: true, itemUrl, autoRestock })
      })
    })
  })

  //現在のタスク一覧を返す
  ipcMain.on('list_tasks', () => {
    sendTaskList()
  })

  // タスク停止: pending は拡張機能に渡らなくなる。running は既に拡張機能が
  // 処理中の可能性があるため状態だけ止める（結果が返れば通常どおり記録）。
  ipcMain.on('task_stop', (e, taskId) => {
    const task = managerServer && managerServer.tasks.get(taskId)
    if (task && (task.status === 'pending' || task.status === 'running')) {
      task.status = 'stopped'
      tasksDb.update({ id: task.id }, task, { upsert: true }, () => {})
      console.log('[manager] task stopped:', task.id)
    }
    sendTaskList()
  })

  // タスク起動: 停止中・失敗のタスクを pending に戻す（拡張機能が約1分
  // 以内に拾う）。同じ商品番号または Mercari 商品 ID に実行待ち/実行中の
  // 再出品がある場合は二重出品防止のため起動しない。
  ipcMain.on('task_start', (e, taskId) => {
    const task = managerServer && managerServer.tasks.get(taskId)
    if (task && (task.status === 'stopped' || task.status === 'failed')) {
      const dup =
        task.type === 'relist' &&
        hasActiveRelistTask(
          task.product_no,
          normalizeMercariUrl(task.itemUrl)
        )
      if (!dup) {
        task.status = 'pending'
        tasksDb.update({ id: task.id }, task, { upsert: true }, () => {})
        console.log('[manager] task restarted:', task.id)
        if (task.type === 'relist' && task.product_no) {
          db.update(
            { product_no: task.product_no },
            { $set: { list_error: null } },
            () => refreshRenderer()
          )
        }
      } else {
        console.log('[manager] task start refused (active relist exists):', task.id)
      }
    }
    sendTaskList()
  })

  // タスク削除: 記録ごと消す。実行中だった場合、結果は記録されない。
  ipcMain.on('task_delete', (e, taskId) => {
    if (managerServer && managerServer.tasks.has(taskId)) {
      managerServer.tasks.delete(taskId)
      tasksDb.remove({ id: taskId }, {}, () => {})
      console.log('[manager] task deleted:', taskId)
    }
    sendTaskList()
  })
  if (process.env.WEBPACK_DEV_SERVER_URL) {
    // Load the url of the dev server if in development mode
    await window.loadURL(process.env.WEBPACK_DEV_SERVER_URL)
    if (!process.env.IS_TEST) window.webContents.openDevTools()
  } else {
    createProtocol('app')
    // Load the index.html when not in development
    window.loadURL('app://./index.html')
  }
}

// Quit when all windows are closed.
app.on('window-all-closed', () => {
  // On macOS it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  // On macOS it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

function findLegacyDataRoot() {
  const candidates = app.isPackaged
    ? [path.dirname(app.getPath('exe')), process.cwd()]
    : [process.cwd()]
  const roots = [...new Set(candidates.map((candidate) => path.resolve(candidate)))]
  const dataRoot = roots.find((root) => {
    const legacyData = path.join(root, 'userdata')
    return fs.existsSync(legacyData) && fs.readdirSync(legacyData).length > 0
  })
  return dataRoot || roots.find((root) => fs.existsSync(path.join(root, 'img'))) || roots[0]
}

let lastUpdaterError = ''
let lastUpdaterErrorAt = 0

function reportUpdaterError(error) {
  const detail = error && error.message ? error.message : String(error)
  const now = Date.now()
  if (detail === lastUpdaterError && now - lastUpdaterErrorAt < 2000) return
  lastUpdaterError = detail
  lastUpdaterErrorAt = now
  console.error('[updater] failed', error)
  const options = {
    type: 'warning',
    title: '更新检查失败',
    message: '暂时无法检查或下载更新。',
    detail,
    buttons: ['关闭'],
  }
  if (window && !window.isDestroyed()) {
    dialog.showMessageBox(window, options).catch((dialogError) => {
      console.error('[updater] failed to show error dialog', dialogError)
    })
  } else {
    dialog.showErrorBox(options.title, `${options.message}\n\n${detail}`)
  }
}

function setupAutoUpdater() {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false
  autoUpdater.on('update-available', (info) => {
    console.info(`[updater] version ${info.version} is available`)
  })
  autoUpdater.on('update-not-available', (info) => {
    console.info(`[updater] already on the latest version ${info.version}`)
  })
  autoUpdater.on('update-downloaded', (info) => {
    const options = {
      type: 'info',
      title: '更新已下载',
      message: `新版本 ${info.version} 已下载完成。`,
      detail: '现在重启安装，或稍后退出程序时自动安装。',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
    }
    const prompt = window && !window.isDestroyed()
      ? dialog.showMessageBox(window, options)
      : dialog.showMessageBox(options)
    prompt.then(({response}) => {
      if (response === 0) autoUpdater.quitAndInstall()
    }).catch((error) => {
      console.error('[updater] failed to show downloaded update dialog', error)
    })
  })
  autoUpdater.on('error', reportUpdaterError)
  autoUpdater.checkForUpdates().catch(reportUpdaterError)
}

app.whenReady().then(async () => {
  const preparedData = await prepareUserDataDirectory(
    app.getPath('userData'),
    findLegacyDataRoot()
  )
  userDataDir = preparedData.dataDirectory
  if (preparedData.migrated) {
    console.info('[storage] Legacy user data copied to the application data directory')
  }
  const database = require('./nedb/db')
  db = database.initializeDatabase(userDataDir)
  getAll = database.getAll
  tasksDb = new Datastore({
    filename: path.join(userDataDir, 'tasks.db'),
    autoload: true,
  })

  // Register before creating the window so renderer image requests cannot race
  // protocol setup.
  const contentTypes = {
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
  }
  const readImage = async (imagePath) => {
    const body = await fs.promises.readFile(imagePath)
    const contentType = contentTypes[path.extname(imagePath).toLowerCase()] || 'application/octet-stream'
    return new Response(body, { headers: { 'Content-Type': contentType } })
  }
  protocol.handle('imgp', async (request) => {
    try {
      const u = new URL(request.url)
      const requestPath = decodeURIComponent(u.pathname)
      const rel = requestPath.replace(/^\/+/, '')
      const absolutePath = productImagePathFromRequest(u.hostname, u.pathname)
      const productDirectory = u.searchParams.get('productDir')
      if (absolutePath) {
        if (fs.existsSync(absolutePath)) {
          return await readImage(absolutePath)
        }
      }
      if (!rel || rel.includes('..')) {
        return new Response('bad path', { status: 400 })
      }
      const candidates = [
        path.join(userDataDir, rel),
        path.resolve(rel),
        path.join(path.dirname(app.getPath('exe')), rel),
        path.join(app.getAppPath(), rel),
        path.resolve('..', rel),
      ]
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          return await readImage(p)
        }
      }
      if (productDirectory && path.isAbsolute(productDirectory)) {
        const productImagePath = path.join(productDirectory, path.basename(rel))
        if (fs.existsSync(productImagePath)) {
          return await readImage(productImagePath)
        }
      }
      console.warn('[imgp] image not found')
      return new Response('image not found', { status: 404 })
    } catch (e) {
      console.error('[imgp] failed', e)
      return new Response('image error', { status: 500 })
    }
  })

  startManagerServer()
  await createWindow()
  setupAutoUpdater()
}).catch((error) => {
  console.error('[startup] failed', error)
  const detail = error && error.message ? error.message : String(error)
  dialog.showErrorBox('启动失败', `无法安全准备应用数据：\n\n${detail}`)
  app.quit()
})

// Exit cleanly on request from parent process in development mode.
if (isDevelopment) {
  if (process.platform === 'win32') {
    process.on('message', (data) => {
      if (data === 'graceful-exit') {
        app.quit()
      }
    })
  } else {
    process.on('SIGTERM', () => {
      app.quit()
    })
  }
}


function openFolder(folderPath) {
  // 打开文件夹的命令，根据操作系统不同可能需要调整
  const openFolderCommand = process.platform === 'win32' ? 'start "" "' : 'open "';
  // 执行命令以打开文件夹
  exec(openFolderCommand.concat(folderPath).concat('"'), (err, stdout, stderr) => {
    if (err) {
      console.error('Error opening folder:', err);
      return;
    }
  });
}


async function downloadImg(url, folderPath) {
  let data = {title:"", content:"", mainImgPath:"", price:0};
  const ChromiumPath = getChromiumExecutablePath()
  const browser = await puppeteer.launch({
    executablePath:ChromiumPath
  });
  try {
  const page = await browser.newPage();
  await page.goto(url, { timeout: 30000 });
  await page.waitForSelector("#altImages > ul > li.imageThumbnail", { timeout: 30000 });

  //获取标题跟详情
  //#productTitle
  let productTitleEl = await page.$("#productTitle");
  let productTitle = await page.evaluate(el => el.innerHTML, productTitleEl)
  data.title  = productTitle.trim()
  //#feature-bullets > ul > li > span"
  let productContentEls = await page.$$("#feature-bullets > ul > li > span");
  let content = ""
  for (let index = 0; index < productContentEls.length; index++) {
    let tmpCtx = await page.evaluate(el => el.innerHTML, productContentEls[index])
    content = index === 0? tmpCtx:content.concat(`\n${tmpCtx}`)
  }
  data.content = content

  //#corePriceDisplay_desktop_feature_div > div.a-section.a-spacing-none.aok-align-center.aok-relative > span.a-price.aok-align-center.reinventPricePriceToPayMargin.priceToPay > span:nth-child(2) > span.a-price-whole
  let productPriceEl = await page.$$("#corePriceDisplay_desktop_feature_div > div.a-section.a-spacing-none.aok-align-center.aok-relative > span.a-price.aok-align-center.reinventPricePriceToPayMargin.priceToPay > span:nth-child(2) > span.a-price-whole");
  if(productPriceEl.length>0){
    let productPrice = await page.evaluate(el => el.innerHTML, productPriceEl[0])
    productPrice = productPrice.replace(",","")
    if(/^[\d]+$/.test(productPrice)) {
      data.price = Number(productPrice)
    } 
  }

  //点击加载大图
  let loadImgDiv = await page.$("#landingImage")
  loadImgDiv.click()
  //等待大图加载完毕
  await sleep(2000)
  let mainImg = await page.$("#ivLargeImage > img")
  let src = await page.evaluate(el => el.getAttribute('src'), mainImg)
  //console.log(src)
  //主图 #landingImage
  await downloadFile(src, folderPath)
  await downloadFile(src, path.join(userDataDir, 'img'))
  data.mainImgPath = "imgp://../img/".concat(src.split("/")[src.split("/").length-1])
  //获取点击列表
  let titles = await page.$$("#ivThumbs > div.ivRow>div.ivThumb");
  for (let index = 1; index < titles.length; index++) {
    titles[index].click();
    let selecter = "#ivLargeImage > img";
    //等待大图加载完毕
    await sleep(2000)
    let itemImg = await page.$(selecter)
    let src = await page.evaluate(el => el.getAttribute('src'), itemImg)
    //console.log(src)
    await downloadFile(src, folderPath)
  }

  return data
  } finally {
    await browser.close()
  }
}

//仅仅下载图片，不创建记录
async function onlyDownloadImg(url, folderPath) {
  let data = {title:"", content:"", price:0};
  const ChromiumPath = getChromiumExecutablePath()
  const browser = await puppeteer.launch({
    executablePath:ChromiumPath
  });
  try {
  const page = await browser.newPage();
  await page.goto(url, { timeout: 30000 });
  await page.waitForSelector("#altImages > ul > li.imageThumbnail", { timeout: 30000 });

  //获取标题跟详情
  //#productTitle
  let productTitleEl = await page.$("#productTitle");
  let productTitle = await page.evaluate(el => el.innerHTML, productTitleEl)
  data.title  = productTitle.trim()
  //#feature-bullets > ul > li > span"
  let productContentEls = await page.$$("#feature-bullets > ul > li > span");
  let content = ""
  for (let index = 0; index < productContentEls.length; index++) {
    let tmpCtx = await page.evaluate(el => el.innerHTML, productContentEls[index])
    content = index === 0? tmpCtx:content.concat(`${tmpCtx}
`)
  }
  data.content = content
  //#corePriceDisplay_desktop_feature_div > div.a-section.a-spacing-none.aok-align-center.aok-relative > span.a-price.aok-align-center.reinventPricePriceToPayMargin.priceToPay > span:nth-child(2) > span.a-price-whole
  let productPriceEl = await page.$$("#corePriceDisplay_desktop_feature_div > div.a-section.a-spacing-none.aok-align-center.aok-relative > span.a-price.aok-align-center.reinventPricePriceToPayMargin.priceToPay > span:nth-child(2) > span.a-price-whole");
  if(productPriceEl.length>0){
    let productPrice = await page.evaluate(el => el.innerHTML, productPriceEl[0])
    productPrice = productPrice.replace(",","")
    if(/^[\d]+$/.test(productPrice)) {
      data.price = Number(productPrice)
    } 
  }
  //点击加载大图
  let loadImgDiv = await page.$("#landingImage")
  loadImgDiv.click()
  //等待大图加载完毕
  await sleep(2000)
  let mainImg = await page.$("#ivLargeImage > img")
  let src = await page.evaluate(el => el.getAttribute('src'), mainImg)
  //console.log(src)
  //主图 #landingImage
  await downloadFile(src, folderPath)
  //获取点击列表
  let titles = await page.$$("#ivThumbs > div.ivRow>div.ivThumb");
  for (let index = 1; index < titles.length; index++) {
    titles[index].click();
    let selecter = "#ivLargeImage > img";
    //等待大图加载完毕
    await sleep(2000)
    let itemImg = await page.$(selecter)
    let src = await page.evaluate(el => el.getAttribute('src'), itemImg)
    //console.log(src)
    await downloadFile(src, folderPath)
  }

  //将商品详情写入文件
  await appendToFile(path.join(folderPath, "商品説明.txt"), url + "\n"+ data.title + "\n" + data.price + "\n" + data.content)
  } finally {
    await browser.close()
  }
}

async function sleep (time) {
  return new Promise((resolve) => setTimeout(resolve, time));
}

async function downloadFile(url, filePath) {
  await checkDir(filePath)
  const response = await axios({
    method: "get",
    url: url,
    responseType: "stream",
    timeout: 30000,
  })
  const fileName = url.split("/").pop()
  await pipeline(response.data, fs.createWriteStream(path.join(filePath, fileName)))
};

async function checkDir(folderPath) {
  const folders = folderPath.split("/"); // 拆分路径为文件夹数组
    let currentPath = '';

    for (const folder of folders) {
        currentPath = path.join(currentPath, folder); // 逐级拼接路径
        if (!currentPath.endsWith(":.")){
          currentPath=currentPath.replace(":",":\\")
        } 
    
        if (!fs.existsSync(currentPath)) {
            fs.mkdirSync(currentPath); // 如果文件夹不存在，创建它
        } 
    }
}

//将内容写入文本
async function appendToFile(filePath, content){
  await fs.promises.appendFile(filePath, content, 'utf8')
}



