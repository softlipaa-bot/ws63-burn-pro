# WS63 烧录工作站 Pro

当前公开源码版本：**1.1.5**。源码位于本仓库，安装包见 [Releases](https://github.com/softlipaa-bot/ws63-burn-pro/releases)。

## 构建

安装 Node.js 和 Windows 原生模块构建环境。进入 `app`，运行 `npm ci`、`npm run dev`。正式打包在根目录运行 `build_release.bat`。

当前同步的是 1.1.5 源码；现有 Release 保留，本次未发布新的桌面安装包。

## 发布说明

源码来自当前本地工作目录。个人账号数据、签名私钥、本机 SDK 路径、依赖缓存和历史安装包不随源码上传。第三方依赖遵循各自许可证。

## 许可证

原创项目代码采用 [MIT License](LICENSE)。第三方代码、依赖及素材的原有权利和许可证继续适用。

## 原项目说明

# WS63 烧录工作站 Pro

Electron + Vue 3 + Nuxt UI v4。

## 功能

| 侧栏 | 功能 |
|------|------|
| 固件烧录 | `.fwpkg` + 串口，最多 **10 路**并行 |
| 串口与日志 | 最多 10 路监听 |
| 关于与更新 | 软件版本检查与在线更新 |

烧录等待进入下载模式超时：**60 秒**。烧录完成需**手动按 RST** 才能看到串口启动日志；
应用如实区分「文件传输完成 / 协议确认完成 / 设备启动已验证（当前协议未定义，恒未验证）」。

## 开发

```powershell
cd D:\自研app\WS63烧录工作站Pro
.\start_dev.bat
```

## 离线测试（不需要硬件）

```powershell
cd app
npm test
```

用合成 `.fwpkg`、FakeSerialPort、假设备协议与假 HTTP 响应覆盖坏包拒绝、短读、无 `C`、
NAK、半帧、坏 CRC、超长无换行串口流、端口所有权、更新下载取消、退出门禁、IPC 参数校验。

## 打包

```powershell
cd D:\自研app\WS63烧录工作站Pro
.\build_release.bat              # 构建 + 校验 + 部署 release\ + 出 OTA zip
.\build_release.ps1 -BuildOnly   # 只构建 + 校验（输出 app\dist-electron-release）
```

唯一权威 build 配置是 `app\package.json` 的 `build` 段（输出目录 `dist-electron-release`），
脚本从它读取产品名/版本/便携版文件名，并校验 EXE / `app.asar` / `preload.cjs` / 串口原生模块齐全。
旧的 release 与 OTA 包会被归档到 `release-archive\`，不会直接删除。

| 产物 | 用途 |
|------|------|
| `WS63BurnPro-Portable.exe` | **发给别人**：单个文件，双击即用 |
| `release\` | 本地目录版（启动更快，需整夹保留） |
| `WS63BurnPro-win-x64.zip` | 在线更新包 |

运行时开关（诊断/兼容用）：`WS63_GPU_MODE=auto|force|disable`、`WS63_HEAP_MB=4096`、
`WS63_SANDBOX=1|0`、`WS63_STRICT_PROTOCOL=0`（宽松协议确认，仅现场诊断）。
