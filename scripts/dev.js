// 開発用: レンダラの dev サーバを起動し、メインプロセスをバンドルして
// Electron を開発モードで立ち上げる（旧 electron:serve の簡易な置き換え）。
const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const bundled = path.join(root, 'dist_electron', 'bundled')

// アプリ用 package.json と preload / icon を bundled に用意する
execFileSync(process.execPath, [path.join(__dirname, 'write-app-package.js')], { stdio: 'inherit' })
fs.copyFileSync(path.join(root, 'public', 'preload.js'), path.join(bundled, 'preload.js'))
fs.copyFileSync(path.join(root, 'app.ico'), path.join(bundled, 'app.ico'))

// メインプロセスを development モードでバンドルする
const webpackBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'webpack.cmd' : 'webpack')
execFileSync(webpackBin, ['--config', 'webpack.main.config.js', '--mode', 'development'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })

// レンダラの dev サーバ
const vueCliBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'vue-cli-service.cmd' : 'vue-cli-service')
const serve = spawn(vueCliBin, ['serve'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })

// 少し待ってから Electron を起動する
setTimeout(() => {
  const electronPath = require(path.join(root, 'node_modules', 'electron'))
  const env = Object.assign({}, process.env, {
    WEBPACK_DEV_SERVER_URL: 'http://localhost:8080/',
    NODE_ENV: 'development',
  })
  const app = spawn(electronPath, [bundled], { cwd: root, stdio: 'inherit', env })
  app.on('close', () => {
    serve.kill()
    process.exit(0)
  })
}, 4000)
