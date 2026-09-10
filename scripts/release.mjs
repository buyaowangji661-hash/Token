#!/usr/bin/env node
/**
 * 一条命令发版：升版本 → 构建 → 上传 GitHub Release。
 *
 * 用法（在仓库根目录）：
 *   npm run release                 升 patch（0.1.1 → 0.1.2）→ 构建 → 上传
 *   npm run release -- --minor      升 minor（0.1.2 → 0.2.0）
 *   npm run release -- --major      升 major（0.2.0 → 1.0.0）
 *   npm run release -- --version 0.3.1
 *   npm run release -- --no-bump    版本已手改好，只构建 + 上传
 *   npm run release -- --skip-build 不构建，直接把 release/ 里现有产物传上去
 *
 * 前提：本机已 `gh auth login`；package.json 的 build.publish 指向本仓库。
 * 发布后：其他电脑上已安装版启动 15 秒内静默检查到新版，自动下载 → 设置页点「重启并安装」。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const pkgPath = path.join(root, "package.json");
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const publish = pkg.build?.publish;
if (!publish?.owner || !publish?.repo) {
  console.error("package.json 里缺少 build.publish.owner / repo，无法发版。");
  process.exit(1);
}
const repoSlug = `${publish.owner}/${publish.repo}`;

function bump(current, kind) {
  const [major, minor, patch] = current.split(".").map((n) => Number.parseInt(n, 10));
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  return execFileSync(cmd, args, {
    cwd: root,
    stdio: opts.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    shell: process.platform === "win32",
    encoding: "utf8"
  });
}

// 0. 环境检查：gh 已登录
try {
  const who = run("gh", ["api", "user", "--jq", ".login"], { capture: true }).trim();
  console.log(`gh 已登录：${who}`);
} catch {
  console.error("gh 未登录，先执行：gh auth login");
  process.exit(1);
}

// 1. 版本号
const explicit = valueOf("--version");
let version = pkg.version;
if (explicit) version = explicit;
else if (!has("--no-bump")) version = bump(pkg.version, has("--major") ? "major" : has("--minor") ? "minor" : "patch");

if (version !== pkg.version) {
  pkg.version = version;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  console.log(`版本号：${version}`);
} else {
  console.log(`版本号：${version}（未变更）`);
}

// 2. 构建
if (!has("--skip-build")) {
  run("npm", ["run", "dist"]);
}

// 3. 收集产物：安装包 + latest.yml（自动更新靠它发现新版），便携版一起给
const releaseDir = path.join(root, "release");
const wanted = [
  `Token Setup ${version}.exe`,
  "latest.yml",
  "latest-mac.yml",
  `Token ${version}.exe`
];
const files = wanted
  .map((name) => path.join(releaseDir, name))
  .filter((file) => fs.existsSync(file));
const installer = path.join(releaseDir, `Token Setup ${version}.exe`);
if (!fs.existsSync(installer)) {
  console.error(`缺少安装包：${installer}\n请先构建（去掉 --skip-build）。`);
  process.exit(1);
}
if (!files.some((f) => f.endsWith("latest.yml"))) {
  console.error("缺少 latest.yml —— 没有它其他电脑发现不了新版，请检查 electron-builder 的 publish 配置。");
  process.exit(1);
}
for (const file of files) {
  console.log(`  · ${path.basename(file)}  ${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB`);
}

// 4. 建 Release（版本号已存在则拒绝，避免覆盖别人已经下载过的包）
const tag = `v${version}`;
run("gh", [
  "release", "create", tag,
  ...files,
  "--repo", repoSlug,
  "--title", `Token ${tag}`,
  "--generate-notes",
  "--latest"
]);

console.log(`\n已发布：https://github.com/${repoSlug}/releases/tag/${tag}`);
console.log("其他电脑：已安装版 15 秒内自动发现新版 → 下载 → 设置页「重启并安装」。");
