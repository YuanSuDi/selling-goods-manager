const { defineConfig } = require('@vue/cli-service')
module.exports = defineConfig({
  // Electron の app:// から読み込めるよう、資産パスは相対にする
  publicPath: './',
  transpileDependencies: true,
  //transpileDependencies:['/cheerio/','/parse5/'],
  chainWebpack: config => {
    // 修改 webpack 配置
    config.resolve.alias
      .set('path', false)
      .set('fs', false);
    // 其他配置...
  },
  configureWebpack: {
    // 使用 Node.js 中的 __dirname
    node: {
      __dirname: true
    }
  },
  // 注: 旧 vue-cli-plugin-electron-builder 用の pluginOptions は廃止した。
  // 打包の設定は package.json の "build"（electron-builder）に移した。
})
