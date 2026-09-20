"use strict";
/**
 * 代码在哪 vs 数据在哪。
 *
 * 开发态（git clone + npm run app）：两者都是仓库目录，跟以前一模一样，行为一个字节都不变。
 * 装机态（.dmg / .exe 装出来的那份）：代码在应用包里，那地方是只读的——macOS 上往签名过的
 *   包里写东西会直接破坏签名，Windows 装在 Program Files 下普通用户也没有写权限。
 *   所以所有会被写的东西（配置、账号、会话、工作区、技能、插件、备份、日程）一律落到
 *   用户家目录下的 ~/KylinWork。
 *
 * 为什么用家目录而不是 Library/Application Support 或 AppData：工作区里放的是 PPT/Word/Excel
 * 这些要交到用户手上的成果文件，得让人在访达/资源管理器里自己找得到、能拖走。
 *
 * 想放别处：设环境变量 KYLINWORK_HOME=/你的/路径（开发态也吃这个变量，方便隔离测试）。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

/** 只读：代码、public/、config.example.json、随包出厂的 skills/。
 *  本文件在 engine/ 下，仓库根是它的上一级——别写成 __dirname，
 *  否则 appPath("public")、appPath("skills") 全都会指到 engine/ 里去。 */
const APP_DIR = path.resolve(__dirname, "..");

function isPackaged() {
  // ELECTRON_RUN_AS_NODE：run_node 派生出去的子进程也带 electron 版本号，但它不是应用本体
  if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE) return false;
  try {
    return !!require("electron").app.isPackaged;
  } catch {
    return false;
  }
}

/** 可写：配置 / 数据 / 工作区 / 技能 / 插件 / 备份都在这儿 */
const DATA_DIR = resolveDataDir();

function resolveDataDir() {
  if (process.env.KYLINWORK_HOME) return path.resolve(process.env.KYLINWORK_HOME);
  if (!isPackaged()) return APP_DIR;
  // 数据目录只有一个：装机态固定落在 ~/KylinWork（开发态就是仓库目录本身）。
  return path.join(os.homedir(), "KylinWork");
}

/** 数据根下的路径 */
function dataPath(...seg) {
  return path.join(DATA_DIR, ...seg);
}

/** 应用包内的只读资源 */
function appPath(...seg) {
  return path.join(APP_DIR, ...seg);
}

/** 两处同名时，用户那份优先、包里那份兜底（读用；写一律写 dataPath） */
function preferData(...seg) {
  const mine = dataPath(...seg);
  return fs.existsSync(mine) ? mine : appPath(...seg);
}

function copyIfMissing(from, to) {
  if (fs.existsSync(to) || !fs.existsSync(from)) return false;
  fs.cpSync(from, to, { recursive: true });
  return true;
}

/**
 * 装机态首次启动：把包里的「出厂内容」铺到数据目录。
 * 每次启动都会补一次缺失项——这样应用升级带来的新内置技能能自动出现，
 * 而用户自己改过的那些不会被覆盖（只补不存在的）。
 */
function seedDataDir() {
  if (DATA_DIR === APP_DIR) return; // 开发态：本来就是同一个目录，无事可做
  for (const d of ["data", "workspace", "skills", "plugins", "backups"]) {
    fs.mkdirSync(dataPath(d), { recursive: true });
  }
  copyIfMissing(appPath("experts.json"), dataPath("experts.json"));
  try {
    for (const e of fs.readdirSync(appPath("skills"), { withFileTypes: true })) {
      if (e.isDirectory()) copyIfMissing(appPath("skills", e.name), dataPath("skills", e.name));
    }
  } catch {}
}

/**
 * 给一次独立运行（CLI 会话 / 定时任务执行 / IM 会话）分配成果子目录，
 * 命名与 Web 对话一致（前缀_月日_标题，撞名加序号），返回相对工作区的目录名。
 * 各条任务路径只有都落到自己的子目录里，工作区根目录才不会被搅成一锅——
 * 用户在访达里也才能一眼认出哪个文件夹是哪次跑出来的。
 */
function allocateRunDir(wsDir, prefix, title) {
  const d = new Date();
  const stamp = String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
  const slug =
    String(title || "")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, "")
      .slice(0, 12) || "任务";
  let dir = `${prefix}_${stamp}_${slug}`;
  for (let i = 2; fs.existsSync(path.join(wsDir, dir)); i++) dir = `${prefix}_${stamp}_${slug}_${i}`;
  try { fs.mkdirSync(path.join(wsDir, dir), { recursive: true }); } catch {}
  return dir;
}

module.exports = { APP_DIR, DATA_DIR, dataPath, appPath, preferData, seedDataDir, isPackaged, allocateRunDir };
