# 商品管理程序

Electron + Vue 桌面端库存管理工具，可与浏览器扩展配合完成商品管理和出品任务流程。

## 开发

环境：Node.js 24、Yarn 1.22。

```powershell
yarn install
yarn electron:serve
```

构建 Windows 安装包：

```powershell
yarn electron:build
```

其他可用命令：`yarn serve` 启动纯网页开发服务器，`yarn build` 构建渲染进程，`yarn lint` 运行检查。

## 外部运行时

快速追加和图片下载功能使用随应用提供的 Chromium。该二进制不包含在仓库中；需要时放在 `app/.local-chromium/win64-1045629/chrome-win/chrome.exe`。

用户数据库、联动配置、商品图片和打包产物均不包含在此源码仓库中。
