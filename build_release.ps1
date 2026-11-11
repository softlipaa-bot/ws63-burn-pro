#requires -version 5.1
<#
  WS63烧录工作站Pro 发布构建脚本

  W07：*唯一权威 build 配置 = app\package.json 的 build 段*
  本脚本不再硬编码输出目录 / 产品名 / 版本 / OTA 包名，全部从 package.json 读取：
    build.directories.output  -> 构建输出目录
    build.productName         -> 可执行文件名
    build.portable.artifactName -> 便携版文件名
    version                   -> 版本号（RELEASE_NOTES / OTA 说明）

  安全约束：
  - 不删除 release\ 历史产物；需要替换时先整体归档到 release-archive\<时间戳>\。
  - 不使用会静默覆盖正式 package.json 的历史生成脚本（见 app\tools\archive\）。
  - 构建到新目录后逐个校验 EXE / asar / preload / 原生串口模块是否齐全。

  用法：
    .\build_release.ps1                 # 正常构建（node_modules 已存在则复用，缺失则 npm ci）
    .\build_release.ps1 -FreshInstall   # 强制 npm ci 后构建
    .\build_release.ps1 -BuildOnly      # 只构建 + 校验，不部署到 release\ / 不出 zip
    .\build_release.ps1 -Candidate      # 构建到候选目录并生成候选包报告，绝不碰 release\
    .\build_release.ps1 -NoArchive      # 直接覆盖 release\ / 便携版 / OTA zip（不归档、不可回滚）

  W29-01 发布一致性：
    构建前生成 dist\build-manifest.json（版本 + 每个关键文件 SHA256 + 汇总摘要），
    打包后用 app\scripts\package-consistency.mjs 逐文件核对包内容与清单是否一致；
    不一致直接中止，绝不允许“只打包了却没进用户实际运行目录”还声称可用。
#>
[CmdletBinding()]
param(
    [switch]$FreshInstall,
    [switch]$BuildOnly,
    [switch]$Candidate,
    [switch]$NoArchive,
    [string]$OutDir
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppDir = Join-Path $Root "app"
$Release = Join-Path $Root "release"
$Archive = Join-Path $Root "release-archive"
$LogFile = Join-Path $Root "build.log"

function Write-Step([string]$Message) {
    $line = "==> $Message"
    Write-Host $line -ForegroundColor Cyan
    Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
}

function Get-Sha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

"Build started $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" | Set-Content -LiteralPath $LogFile -Encoding UTF8

# ---------------------------------------------------------------- 读取权威配置
$pkgPath = Join-Path $AppDir "package.json"
if (-not (Test-Path -LiteralPath $pkgPath)) { throw "package.json not found: $pkgPath" }
$pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json

$ProductName = [string]$pkg.build.productName
$Version = [string]$pkg.version
$ConfiguredOut = [string]$pkg.build.directories.output
$PortableName = [string]$pkg.build.portable.artifactName
$ExeName = "$ProductName.exe"
if (-not $PortableName) { $PortableName = "$ProductName-Portable.exe" }
if (-not $OutDir) {
    if ($Candidate) {
        # 候选包绝不与正式输出目录混在一起，避免“以为部署了”
        $OutDir = "$ConfiguredOut-candidate"
    } else {
        $OutDir = $ConfiguredOut
    }
}
if (-not $OutDir) { throw "package.json 缺少 build.directories.output，且未指定 -OutDir" }

Write-Step "权威配置: version=$Version product=$ProductName output=$OutDir portable=$PortableName"

if ((Test-Path -LiteralPath (Join-Path $AppDir "write-pkg.js")) -or (Test-Path -LiteralPath (Join-Path $AppDir "write-pkg.cjs"))) {
    Write-Warning "检测到历史生成脚本 app\write-pkg.*；它们已归档到 app\tools\archive\，不得用于正式发布。"
}

# ------------------------------------------------------------------- 依赖安装
Push-Location $AppDir
try {
    $hasLock = Test-Path -LiteralPath (Join-Path $AppDir "package-lock.json")
    if ($FreshInstall -or -not (Test-Path -LiteralPath (Join-Path $AppDir "node_modules"))) {
        if ($hasLock) {
            Write-Step "npm ci（干净安装，保证依赖一致性）"
            cmd /c "npm ci >> `"$LogFile`" 2>&1"
            if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit $LASTEXITCODE)" }
        } else {
            Write-Step "npm install（无 package-lock.json）"
            cmd /c "npm install >> `"$LogFile`" 2>&1"
            if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)" }
        }
    } else {
        Write-Step "复用已有 node_modules（如需一致性检查请加 -FreshInstall）"
    }

    Write-Step "构建 Vue + Electron（约 3-8 分钟），输出到 $OutDir"
    $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
    $env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
    cmd /c "npm run electron:pack -- --config.directories.output=`"$OutDir`" >> `"$LogFile`" 2>&1"
    if ($LASTEXITCODE -ne 0) { throw "electron pack failed (exit $LASTEXITCODE)" }
}
finally {
    Pop-Location
}

# --------------------------------------------------------------- 产物完整性校验
$outRoot = if ([IO.Path]::IsPathRooted($OutDir)) { $OutDir } else { Join-Path $AppDir $OutDir }
$unpacked = Join-Path $outRoot "win-unpacked"
$portable = Join-Path $outRoot $PortableName

$problems = New-Object System.Collections.Generic.List[string]
if (-not (Test-Path -LiteralPath $unpacked)) { $problems.Add("缺少 win-unpacked 目录: $unpacked") }
if (-not (Test-Path -LiteralPath $portable)) { $problems.Add("缺少便携版: $portable") }

$exePath = Join-Path $unpacked $ExeName
$asarPath = Join-Path $unpacked "resources\app.asar"
$preloadPath = Join-Path $unpacked "resources\app.asar.unpacked\electron\preload.cjs"
$unpackedModules = Join-Path $unpacked "resources\app.asar.unpacked\node_modules"

if (-not (Test-Path -LiteralPath $exePath)) { $problems.Add("缺少 $ExeName") }
if (-not (Test-Path -LiteralPath $asarPath)) { $problems.Add("缺少 resources\app.asar") }
if (-not (Test-Path -LiteralPath $preloadPath)) { $problems.Add("缺少 asar 解包 preload.cjs") }

$nativeNodes = @()
if (Test-Path -LiteralPath $unpackedModules) {
    $nativeNodes = @(Get-ChildItem -LiteralPath $unpackedModules -Recurse -Filter *.node -File -ErrorAction SilentlyContinue)
}
if ($nativeNodes.Count -eq 0) { $problems.Add("缺少串口原生模块（.node）") }

if ($problems.Count -gt 0) {
    foreach ($p in $problems) { Write-Host "  [FAIL] $p" -ForegroundColor Red }
    throw "构建产物不完整，发布中止（共 $($problems.Count) 项）"
}

Write-Step "产物校验通过: exe / asar / preload / 原生模块($($nativeNodes.Count) 个 .node)"

# ------------------------------------------------- W29-01 包内容与源码清单一致性核对
$manifestPath = Join-Path $AppDir "dist\build-manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "缺少构建清单 $manifestPath（应在打包前由 npm run manifest 生成）"
}
Write-Step "核对包内容与构建清单（逐文件 SHA256）"
Push-Location $AppDir
try {
    cmd /c "node scripts\package-consistency.mjs --manifest dist\build-manifest.json --target `"build=$unpacked`" >> `"$LogFile`" 2>&1"
    $consistent = ($LASTEXITCODE -eq 0)
} finally {
    Pop-Location
}
if (-not $consistent) {
    throw "包内容与源码清单不一致（详见 build.log）：不允许把这份产物当作可发布版本"
}
Write-Step "包内容与源码清单一致（asar 内源码 = 待审源码）"

$portableMb = [math]::Round((Get-Item -LiteralPath $portable).Length / 1MB, 1)
$unpackedSize = (Get-ChildItem -LiteralPath $unpacked -Recurse -File | Measure-Object -Property Length -Sum).Sum
$unpackedMb = [math]::Round($unpackedSize / 1MB, 1)
$portableSha = Get-Sha256 $portable
$asarSha = Get-Sha256 $asarPath
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

if ($Candidate) {
    $candidateReport = [ordered]@{
        product        = $ProductName
        version        = $Version
        builtAt        = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
        outputDir      = $outRoot
        unpacked       = $unpacked
        portable       = $portable
        portableSha256 = $portableSha
        portableBytes  = (Get-Item -LiteralPath $portable).Length
        asarSha256     = $asarSha
        sourceDigest   = [string]$manifest.sourceDigest
        manifestFiles  = [int]$manifest.fileCount
        consistent     = $true
        deployedTo     = $null
        note           = "候选包：未部署到 release\、未生成 OTA zip、未触碰桌面快捷方式；等待审核"
    }
    $reportPath = Join-Path $outRoot "candidate-report.json"
    ($candidateReport | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $reportPath -Encoding UTF8
    Write-Step "候选包已生成（未部署）: $reportPath"
    Write-Host "Candidate: $portable ($portableMb MB)" -ForegroundColor Green
    Write-Host "  SHA256: $portableSha"
    Write-Host "  asar:   $asarSha"
    Write-Host "  source: $($manifest.sourceDigest)"
    return
}

if ($BuildOnly) {
    Write-Step "BuildOnly：跳过 release / zip 部署"
    Write-Host "Output:   $outRoot" -ForegroundColor Green
    Write-Host "Portable: $portable ($portableMb MB, SHA256 $portableSha)" -ForegroundColor Green
    return
}

# ------------------------------------------------- 部署到 release\（默认归档；-NoArchive 直接覆盖）
if ($NoArchive) {
    # 用户明确要求“不归档、直接覆盖”。
    # 注意：只用 Copy-Item 覆盖会留下旧版本才有的文件（新版删掉的模块会残留并被加载），
    # 所以这里先清空 release\ 再整体写入，保证目录内容 == 本次构建产物。
    Write-Step "部署目录版到 release\（-NoArchive：直接覆盖，不归档、不可回滚）"
    if (Test-Path -LiteralPath $Release) {
        Remove-Item -LiteralPath $Release -Recurse -Force
        Write-Step "已清空旧 release\ 内容（未归档）"
    }
} else {
    Write-Step "部署目录版到 release\（旧内容先归档，不删除）"
    if (Test-Path -LiteralPath $Release) {
        $hasContent = @(Get-ChildItem -LiteralPath $Release -Force -ErrorAction SilentlyContinue).Count -gt 0
        if ($hasContent) {
            $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
            $archiveTarget = Join-Path $Archive "release-$stamp"
            New-Item -ItemType Directory -Force -Path $Archive | Out-Null
            Move-Item -LiteralPath $Release -Destination $archiveTarget -Force
            Write-Step "旧 release 已归档到 $archiveTarget"
        }
    }
}
New-Item -ItemType Directory -Force -Path $Release | Out-Null
Copy-Item -Path (Join-Path $unpacked "*") -Destination $Release -Recurse -Force

$releaseExe = Join-Path $Release $ExeName
if (-not (Test-Path -LiteralPath $releaseExe)) { throw "release 目录缺少 $ExeName" }

# 部署后复核：release\ 的 asar 必须与构建产物逐字节一致
$releaseAsar = Join-Path $Release "resources\app.asar"
if (-not (Test-Path -LiteralPath $releaseAsar)) { throw "release 目录缺少 resources\app.asar" }
$releaseAsarSha = Get-Sha256 $releaseAsar
if ($releaseAsarSha -ne $asarSha) {
    throw "release\ 的 app.asar（$releaseAsarSha）与构建产物（$asarSha）不一致，部署失败"
}
Write-Step "部署后复核：release\app.asar = 构建产物 asar（$releaseAsarSha）"

Write-Step "发布单文件便携版"
$portableOut = Join-Path $Root $PortableName
Copy-Item -LiteralPath $portable -Destination $portableOut -Force

# --------------------------------------------------------------- OTA ZIP（zip 名称来自 OTA 配置）
$otaAssetName = "WS63BurnPro-win-x64.zip"
$otaConfigPath = Join-Path $AppDir "electron\ota\default-config.json"
if (Test-Path -LiteralPath $otaConfigPath) {
    try {
        $otaCfg = Get-Content -LiteralPath $otaConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($otaCfg.assetName) { $otaAssetName = [string]$otaCfg.assetName }
    } catch {
        Write-Warning "读取 OTA 配置失败，使用默认包名 $otaAssetName"
    }
}

Write-Step "生成 OTA 更新包 $otaAssetName"
$zipPath = Join-Path $Root $otaAssetName
if (Test-Path -LiteralPath $zipPath) {
    if ($NoArchive) {
        Remove-Item -LiteralPath $zipPath -Force
        Write-Step "旧 OTA 包已直接覆盖（-NoArchive）"
    } else {
        $zipArchive = Join-Path $Archive ("ota-" + (Get-Date -Format "yyyyMMdd-HHmmss") + "-" + $otaAssetName)
        New-Item -ItemType Directory -Force -Path $Archive | Out-Null
        Move-Item -LiteralPath $zipPath -Destination $zipArchive -Force
        Write-Step "旧 OTA 包已归档到 $zipArchive"
    }
}
$zipStaging = Join-Path $env:TEMP ("ws63-ota-zip-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $zipStaging | Out-Null
Copy-Item -Path (Join-Path $Release "*") -Destination $zipStaging -Recurse -Force
Compress-Archive -Path (Join-Path $zipStaging "*") -DestinationPath $zipPath -Force
Remove-Item -LiteralPath $zipStaging -Recurse -Force

$zipMb = [math]::Round((Get-Item -LiteralPath $zipPath).Length / 1MB, 1)
$zipSha = Get-Sha256 $zipPath

@"
WS63 烧录工作站 Pro v$Version
======================================

发给别人（推荐）：双击 $PortableName（单体，约 $portableMb MB）
本地目录版：release\$ExeName（整夹拷贝，启动更快）
OTA 更新包：$otaAssetName（约 $zipMb MB）

构建时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
产物校验：版本 $Version；EXE / app.asar / preload.cjs / 串口原生模块齐全

SHA256
  $PortableName = $portableSha
  $otaAssetName = $zipSha

GitHub OTA：
1. 在 GitHub 创建 Release，tag 写成 v$Version
2. 上传 $otaAssetName（安装时会校验包内产品名/版本，失败会自动回滚）
"@ | Set-Content -LiteralPath (Join-Path $Root "RELEASE_NOTES.txt") -Encoding UTF8

Write-Step "完成。portable=${portableMb}MB release=${unpackedMb}MB zip=${zipMb}MB"
Write-Host "Portable: $portableOut" -ForegroundColor Green
Write-Host "  SHA256: $portableSha"
Write-Host "OTA ZIP:  $zipPath" -ForegroundColor Green
Write-Host "  SHA256: $zipSha"
