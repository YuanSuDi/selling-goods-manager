// dist_electron/bundled に、アプリ用の最小 package.json を書く。
// 依存はすべて background.js にバンドル済み（electron 本体を除く）なので
// dependencies は不要。electron-builder はこの main をエントリとして使う。
const fs = require('fs')
const path = require('path')

const rootPkg = require('../package.json')
const outDir = path.join(__dirname, '..', 'dist_electron', 'bundled')
const appPkg = {
  name: rootPkg.name,
  version: rootPkg.version,
  main: 'background.js',
}
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify(appPkg, null, 2))
console.log('wrote', path.join(outDir, 'package.json'))
