import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const scriptText = fs.readFileSync(path.join(root, "..", "build_release.ps1"), "utf8");

test("W07: package.json 是唯一权威 build 配置（输出目录/产品名/便携名）", () => {
  assert.equal(pkg.build.directories.output, "dist-electron-release");
  assert.equal(pkg.build.productName, "WS63BurnPro");
  assert.equal(pkg.build.portable.artifactName, "WS63BurnPro-Portable.exe");
  assert.ok(Array.isArray(pkg.build.win.target));
});

test("W07: 发布脚本不再硬编码输出目录，而是从 package.json 读取", () => {
  assert.match(scriptText, /package\.json/);
  assert.match(scriptText, /build\.directories\.output/);
  assert.match(scriptText, /build\.portable\.artifactName/);
  assert.equal(
    scriptText.includes("dist-electron-ship"),
    false,
    "旧脚本写死的 dist-electron-ship 必须消失",
  );
  assert.equal(
    scriptText.includes("dist-electron-global"),
    false,
    "输出目录不应在脚本里重复硬编码",
  );
});

test("W07: 脚本会校验 EXE / asar / preload / 原生串口模块", () => {
  assert.match(scriptText, /app\.asar/);
  assert.match(scriptText, /preload\.cjs/);
  assert.match(scriptText, /\.node/);
  assert.match(scriptText, /SHA256/i);
});

test("W07/W29-01: 默认部署仍走归档；只有显式 -NoArchive 才原地覆盖", () => {
  // 默认（无 -NoArchive）不允许删除历史 release
  assert.match(scriptText, /release-archive/);
  assert.match(scriptText, /Move-Item/);
  assert.match(scriptText, /\$NoArchive/);
  // 删除 release 只允许出现在 -NoArchive 分支里，且必须有显式开关
  const removeRelease = scriptText.match(/Remove-Item\s+-LiteralPath\s+\$Release\s+-Recurse/g) ?? [];
  assert.ok(removeRelease.length <= 1, "删除 release 只应有一处（-NoArchive 路径）");
  assert.match(scriptText, /if\s*\(\$NoArchive\)\s*\{[\s\S]{0,400}Remove-Item\s+-LiteralPath\s+\$Release/);
  // 部署后必须复核 release 内 asar 与构建产物一致
  assert.match(scriptText, /releaseAsarSha/);
});

test("W07: 历史生成脚本已归档，app 根目录不再有会覆盖 package.json 的工具", () => {
  assert.equal(fs.existsSync(path.join(root, "write-pkg.js")), false);
  assert.equal(fs.existsSync(path.join(root, "write-pkg.cjs")), false);
  const archived = path.join(root, "tools", "archive", "write-pkg-legacy.cjs");
  assert.equal(fs.existsSync(archived), true);
  const archivedText = fs.readFileSync(archived, "utf8");
  assert.equal(
    archivedText.includes('fs.writeFileSync("package.json"'),
    false,
    "归档工具不得覆盖正式 package.json",
  );
  assert.match(archivedText, /package\.legacy\.json/);
});

test("W07/W29-01: 候选版本有效且与锁文件一致", () => {
  assert.match(pkg.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/);
  const [major, minor, patch] = pkg.version.split(/[.-]/).slice(0, 3).map(Number);
  assert.ok(major > 1 || (major === 1 && (minor > 1 || (minor === 1 && patch >= 4))));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
});

test("W29-01: 构建清单与发布一致性脚本已接入", () => {
  assert.equal(pkg.scripts.manifest, "node scripts/build-manifest.mjs");
  // R7：verify:package 必须带真实目标，不能跑成“空目标即成功”
  assert.match(pkg.scripts["verify:package"], /package-consistency\.mjs/);
  assert.match(pkg.scripts["verify:package"], /--target/);
  assert.match(pkg.scripts["verify:package"], /--portable/);
  assert.match(
    pkg.scripts["electron:pack"],
    /npm run manifest/,
    "打包必须先生成清单，否则包里没有源码摘要可核对",
  );
  assert.ok(fs.existsSync(path.join(root, "scripts", "build-manifest.mjs")));
  assert.ok(fs.existsSync(path.join(root, "scripts", "package-consistency.mjs")));
  assert.ok(fs.existsSync(path.join(root, "electron", "build-info.js")));
});

test("W07: 不再有 dist-electron-fix 之类的历史输出目录配置", () => {
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory() || !dir.name.startsWith("dist-electron")) continue;
    const asarCandidate = path.join(root, dir.name, "win-unpacked", "resources", "app.asar");
    assert.ok(fs.existsSync(asarCandidate) || dir.name === pkg.build.directories.output,
      `历史构建目录 ${dir.name} 应保留产物或为当前输出目录`);
  }
});
