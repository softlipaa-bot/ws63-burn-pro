# 归档：历史 package.json 生成脚本（已废弃发布用途）

这两个文件（原位置 `app\write-pkg.js` / `app\write-pkg.cjs`）曾用于生成 `app\package.json`。
它们的问题是：

1. 写死的输出目录是 `dist-electron-fix`，与 `package.json` 的 `dist-electron-global`、
   `build_release.ps1` 的 `dist-electron-ship` 三处不一致；
2. 直接覆盖正式 `package.json`，会静默抹掉当前的 `version` / `build` 段；
3. 其中 `.js` 版本使用 `require()`，而项目是 `"type": "module"`，本身就跑不起来。

**现状**：`app\package.json` 是唯一权威 build 配置，`build_release.ps1` 从它读取输出目录、
产品名、便携版文件名与版本号。本目录仅作历史归档，禁止用于正式发布。

如需排查历史构建差异，可用 `node write-pkg-legacy.cjs --dry-run` 查看它当初会写成什么
（只会写 `package.legacy.json`，永不覆盖 `package.json`）。
