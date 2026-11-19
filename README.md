# 商品管理程序

Electron + Vue 桌面端库存管理工具，可与浏览器扩展配合完成商品管理和出品任务流程。

## 开发

环境：Node.js 24、Yarn 1.22。

```powershell
yarn install --ignore-engines
yarn electron:serve
```

构建 Windows 安装包和便携 ZIP：

```powershell
yarn electron:build
```

其他可用命令：`yarn serve` 启动纯网页开发服务器，`yarn build` 构建渲染进程，`yarn lint` 运行检查。

## 外部运行时

快速追加和图片下载功能使用随应用提供的 Chromium。该二进制不包含在仓库中；需要时放在 `app/.local-chromium/win64-1045629/chrome-win/chrome.exe`。

用户数据库、联动配置、商品图片和打包产物均不包含在此源码仓库中。

## 自动更新与发布

打包版启动时会检查 GitHub 最新稳定版，并在后台下载更新。下载完成后，程序会提示立即重启安装，或稍后退出程序时自动安装。

发布步骤：

1. 在 `package.json` 中设置新版本号。
2. 推送对应版本标签，例如 `v0.1.3`。
3. GitHub Actions 的 `Publish Windows release` 工作流会构建 NSIS 安装包和便携 ZIP，并发布安装包、ZIP 及 electron-builder 更新元数据。

工作流使用 GitHub 提供的 `GITHUB_TOKEN`，不会把个人访问令牌写入程序。便携 ZIP 用于免安装测试，需手动替换版本；自动安装更新适用于 NSIS 安装版。旧版程序不含自动更新功能，用户需要先手动安装首个支持自动更新的版本。

首次启动时，旧版 `userdata/` 和 `img/` 会被复制到应用数据目录，原文件会保留。如果新旧数据同时存在，程序会报错停止，不会覆盖任一份数据。

桌面端顶部的“用户数据位置”按钮可直接打开应用数据目录中的 `userdata/` 文件夹，其中包含 `user.db`、`tasks.db` 和 `img/`。
