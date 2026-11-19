// メインプロセス（src/background.js）のバンドル設定。
// 旧 vue-cli-plugin-electron-builder が担っていた役割の置き換え。
// __static はアプリのフォルダ（このバンドルが出力される場所）を指す。
const path = require('path')
const webpack = require('webpack')

module.exports = {
  mode: 'production',
  entry: './src/background.js',
  target: 'electron-main',
  output: {
    path: path.resolve(__dirname, 'dist_electron/bundled'),
    filename: 'background.js',
    libraryTarget: 'commonjs2',
  },
  externals: {
    electron: 'commonjs electron',
  },
  plugins: [
    new webpack.DefinePlugin({
      __static: '__dirname',
    }),
  ],
  node: {
    __dirname: false,
    __filename: false,
  },
  resolve: {
    extensions: ['.js', '.json', '.node'],
  },
}
