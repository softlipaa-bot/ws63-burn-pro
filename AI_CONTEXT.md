# AI_CONTEXT — WS63烧录工作站Pro

> Machine-oriented. Read fully before changing this app.

## Current scope override — 2026-10-30

2026-10-31 后续授权：用户要求加入参考截图的圆形主按钮及动画，允许调整布局，最终交付桌面正式便携版。当前任务以 `D:\自研app\审查协作-2026-10-31\WS63-圆形主按钮\设计与实施约定.md` 为准；DeepSeek 曾获本轮实现权限，因未提交可运行版本已取消其运行，由 Codex 接手 App.vue 与新 flash-action 组件的实现、验收及打包。此条覆盖旧 Cursor/DeepSeek 文件所有权。烧录后端和已取消功能保持冻结；旧1.1.4包保留。

后续 UI 授权：用户提供 FlClash 风格指南，指定 DeepSeek 与 Cursor 协作改造现有三个页面。当前文件分工与接口以 `D:\自研app\审查协作-2026-10-29\WS63-FlClash协作\协作约定.md` 为准：Cursor 独占 App.vue 与 flclash 组件；DeepSeek 独占主题和全局 CSS。此 UI 授权不恢复下面已取消的产品扩展。旧“全部由 DeepSeek 实施”的文件所有权不适用于此次 UI 任务。

用户已取消本轮原 1–19 新增功能，要求 Codex 直接撤除。工作台页面、方案/别名/历史/队列、快捷命令、日志检查、录制回放、配置分享、参数锁、大字与声音等扩展已撤除；不得依据旧协作文档重新实现。保留既有烧录/串口流程、复位与句柄修复、代际隔离、日志有界队列、终态进度、失败重试及诊断脱敏。DeepSeek 原扩展任务已取消。源码恢复备份在项目外的审查协作目录。

## Identity

- **Folder:** `D:\自研app\WS63烧录工作站Pro`
- **Former path:** `D:\ws63_burn_pro` (removed after relocate)
- **Product:** WS63BurnPro / WS63 烧录工作站 Pro
- **npm name:** `ws63-burn-pro` (see `app\package.json`)
- **Purpose:** Electron desktop tool for **HiSilicon / WS63** multi-lane firmware flash (`.fwpkg`) + serial monitor/logs. Up to **10 channels** flash and 10 monitor lanes.
- **NOT this app:** SZTU考勤 / 课表 / 连点 / Flet 签到.

## Stack

| Layer | Tech |
|-------|------|
| Shell | Electron |
| UI | Vue 3 + Nuxt UI v4 + Tailwind (`app\src\App.vue` is the main surface) |
| Serial | `serialport` (asarUnpack) |
| Ship | `WS63BurnPro-Portable.exe`, `release\` directory build, `WS63BurnPro-win-x64.zip` OTA |

## Layout

```
WS63烧录工作站Pro/
  AI_CONTEXT.md
  README.md
  start_dev.bat / build_release.bat / build_release.ps1
  app/                 # vite + electron source
    src/App.vue        # almost all UI + slot animation logic
    src/assets/css/main.css
    electron/
  release/             # unpacked directory exe (faster local)
  assets/ scripts/
  WS63BurnPro-Portable.exe
  WS63BurnPro-win-x64.zip
```

## Run / build

```powershell
cd D:\自研app\WS63烧录工作站Pro
.\start_dev.bat                       # dev
.\build_release.bat                   # portable + release\ + OTA zip (minutes)
.\build_release.ps1 -BuildOnly        # 只构建 + 校验产物（不部署到 release\）
.\build_release.ps1 -FreshInstall     # 先 npm ci 再构建
cd app; npm test                      # 离线回归（node --test test/，不需要硬件）
```

- **Give to others:** `WS63BurnPro-Portable.exe`
- **Local fast start:** `release\WS63BurnPro.exe`

**唯一权威 build 配置 = `app\package.json` 的 `build` 段**：
`build.directories.output = dist-electron-release`，产品名/便携名/版本都从这里读。
`build_release.ps1` 不再硬编码目录；旧 `app\write-pkg.*` 生成脚本已归档到
`app\tools\archive\`（永不覆盖正式 package.json）。旧 release / OTA 包会被**归档**到
`release-archive\`，不再直接删除。

## Runtime switches (diagnosable)

环境变量 / 命令行可切换 Chromium 与沙箱行为（默认 `auto`，只保留低风险 GPU 加速）：

| 变量 | 取值 | 说明 |
|---|---|---|
| `WS63_GPU_MODE` / `--ws63-gpu=` | `auto`(默认) / `force` / `disable` | `force` = 旧行为（含 ignore-gpu-blocklist）；`disable` = 关闭 GPU |
| `WS63_HEAP_MB` / `--ws63-heap=` | 512–8192，默认 4096 | `--max-old-space-size` |
| `WS63_SANDBOX` / `--ws63-sandbox=` | 1(默认)/0 | renderer `sandbox` |

启动时 `[ws63] runtime: {...}` 会打印实际生效值。

## Protocol stages (burn)

`prepare → wait_reset → handshake → baud_switch → loader_transfer → loader_confirm →
(erase → partition_transfer)* → finish → reset → boot_verify`

- 每阶段有成功条件 / 失败码 / 超时（`STAGE_SPEC` in `app\electron\burn\ws63flash.js`）。
- 设备应答帧在 `frame-parser.js` 增量解析：保留半帧、校验长度/cmd 反码/CRC；
  没有完整帧或 CRC 错 = 失败，不再“看到魔数就继续”。
- 结论分级：`transferComplete` / `protocolConfirmed` / `bootVerified`（无启动确认协议，
  所以 `bootVerified` 恒为 false，UI 明确显示“协议完成（未验证启动）”）。

## Offline tests

`app\test\` 全部离线可跑（FakeSerialPort / FakeDevice / 合成 fwpkg / 假 fetch）：

```powershell
cd app
npm test          # = node --test --test-concurrency=1 "test/*.test.mjs"
```

> 必须串行：默认并发在 electron-builder 同时跑时会争用临时资源，导致 4 个 W02 用例间歇失败
> （2026-10-24 实测 85 tests / 81 pass / 4 fail；加 `--test-concurrency=1` 后稳定 86/86）。
> 也不要写 `node --test test/`——Node 24 会把目录当模块路径，直接 `Cannot find module`。

覆盖：坏包拒绝、短读、无 'C'、NAK、半帧、坏 CRC、擦除/结束无应答、无换行 262144 字节
缓冲有界、端口所有权原子性、OTA 资源类型/取消/半包清理、退出门禁、IPC 来源与参数 schema。

## UX / animation (known issue area)

First launch then changing **设备数量 / 监听路数** used to stutter because:

1. Cards use glass `backdrop-filter`
2. `TransitionGroup` FLIP + move animates frosted layers → GPU hitch (worse cold start)

**Intended fix (keep):**

- While `.slot-list-grid.is-animating` / enter/leave-active: **disable backdrop-filter**, use near-opaque solid background
- `bumpSlotAnim()` immediately before changing slot count
- `warmSlotCompositor()` after UI ready / section switch
- Do not set heavy stagger delays when mounting many `USelect`s

Files: `app\src\App.vue` (`bumpSlotAnim`, `warmSlotCompositor`, `onFlashSlotCountChange`), `app\src\assets\css\main.css` (`.slot-list-*`).

## Domain rules

- Flash wait-for-download-mode timeout: **60s** (product rule in README)
- WS63 often needs **manual RST** after flash before serial logs appear
- Parallel flash requires distinct COM ports per configured channel
- 串口所有权：`app\electron\serial\ownership.js` 是唯一仲裁点（opening/flashing/handoff/
  monitoring 先原子保留再 await）；烧录可接管监听，监听不能接管烧录。
- 烧录/串口监听运行期间：阻止安装更新与普通退出（`app-gate.js`），可排队“任务结束后安装”。

## Cleanup policy

Delete temps: `_asar_*`, `build.log`, asar extract sandboxes, `app\test\tmp*`. Do not delete Portable/zip/release without user ask.

## Do not

- Merge into SZTU考勤系统.
- Re-enable glass blur during slot TransitionGroup motion.
- Leave multi-GB asar extract dirs in this folder.
