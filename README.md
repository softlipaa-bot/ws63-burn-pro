# WS63 烧录工作站 Pro / WS63 Burn Pro

中文 | [English](#ws63-burn-pro-english)

**WS63BurnPro** 的公开发布与 OTA 仓库：提供 Windows 桌面端烧录工具的发行包（GitHub Release），供应用内或手工下载更新。

---

## 项目简介

WS63 烧录工作站 Pro 是面向 **HiSilicon / 星闪 WS63** 等模组与开发板的 **Electron 桌面烧录工具**，面向产线与实验室批量烧录场景。本仓库用于托管：

- 版本说明与使用介绍（本 README）
- **GitHub Releases** 中的可分发压缩包（如 `WS63BurnPro-win-x64.zip`）

典型能力（以已发布版本说明为准）：

| 能力 | 说明 |
|------|------|
| 多路并行烧录 | 支持多路（如 10 路）同时作业 |
| 等待与节拍 | 可配置等待窗口（如 60s）以适配产线节拍 |
| 桌面端分发 | Windows x64 打包（Electron） |
| GitHub OTA | 通过本仓库 Release 检查/拉取新版本 |

## 下载与安装

1. 打开 [Releases](https://github.com/softlipaa-bot/ws63-burn-pro/releases)
2. 下载最新 `WS63BurnPro-win-x64.zip`（或当时命名的安装包）
3. 解压后运行程序；若应用内提供「检查更新」，将指向本仓库的 Release

当前示例版本：**v1.1.0** — 首发能力包括多路烧录、等待策略、GitHub OTA 与性能优化。

## 仓库内容说明

本仓库以 **发行通道** 为主。若源码在其他私有/内网仓库维护，请以团队内部文档为准；此处保证用户能稳定拿到打包后的桌面客户端。

## 发版建议

1. 在桌面工程中升高版本号并打出 Windows 包
2. 创建 GitHub Release（标签如 `v1.1.0`）
3. 上传 zip/安装包，并在 Release 说明中写清变更点（中英文均可）
4. 若客户端内置 OTA：同步更新其检查用的版本元数据

## 相关链接

- 仓库：https://github.com/softlipaa-bot/ws63-burn-pro
- Releases：https://github.com/softlipaa-bot/ws63-burn-pro/releases

---

<a id="ws63-burn-pro-english"></a>

# WS63 Burn Pro (English)

Public **release / OTA** repository for **WS63BurnPro**, a Windows desktop flasher for HiSilicon / SparkLink **WS63** modules and boards.

## Overview

WS63 Burn Pro is an **Electron** desktop tool aimed at lab and production flashing. This repo hosts:

- Project introduction (this README)
- Distributable archives on **GitHub Releases** (e.g. `WS63BurnPro-win-x64.zip`)

Representative features (see the latest Release notes for the source of truth):

| Feature | Notes |
|---------|--------|
| Multi‑channel flashing | Parallel jobs (e.g. 10 channels) |
| Timing / wait window | Configurable wait (e.g. 60s) for line cadence |
| Desktop packaging | Windows x64 Electron builds |
| GitHub OTA | Check / download newer builds from this repo’s Releases |

## Download

1. Open [Releases](https://github.com/softlipaa-bot/ws63-burn-pro/releases)
2. Download the latest Windows zip / installer
3. Extract and run; in‑app update (if enabled) targets this repository

Example tag: **v1.1.0** — multi‑channel burn, wait strategy, GitHub OTA, performance work.

## Publishing

1. Bump the desktop app version and produce a Windows package
2. Create a Release (tag like `v1.1.0`)
3. Upload the artifact and write clear release notes
4. If the app has built‑in OTA, update its version metadata accordingly

## Links

- Repository: https://github.com/softlipaa-bot/ws63-burn-pro
- Releases: https://github.com/softlipaa-bot/ws63-burn-pro/releases
