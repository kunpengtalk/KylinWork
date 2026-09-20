"use strict";
/** 结果推送 — 企业微信群机器人 + 钉钉自定义机器人（支持加签），任务/定时任务完成通知共用。
 *  还有本机系统通知（desktop）：Electron 主进程注入 handler 后弹原生通知，纯 Node（CLI）下静默跳过。 */

const crypto = require("crypto");
const { dataPath } = require("./paths");

async function pushWecom(imCfg, text) {
  const url = imCfg.wecom_bot_webhook;
  if (!url) return false;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msgtype: "text", text: { content: text.slice(0, 2000) } }),
    signal: AbortSignal.timeout(15000),
  });
  return true;
}

async function pushDingtalk(imCfg, text) {
  let url = imCfg.dingtalk_webhook;
  if (!url) return false;
  if (imCfg.dingtalk_secret) {
    const ts = Date.now();
    const sign = encodeURIComponent(
      crypto.createHmac("sha256", imCfg.dingtalk_secret).update(`${ts}\n${imCfg.dingtalk_secret}`).digest("base64")
    );
    url += `${url.includes("?") ? "&" : "?"}timestamp=${ts}&sign=${sign}`;
  }
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msgtype: "text", text: { content: text.slice(0, 2000) } }),
    signal: AbortSignal.timeout(15000),
  });
  return true;
}

/** 推送到所有已配置的机器人通道；单通道失败不影响其他通道，返回成功的通道名列表 */
async function pushBots(config, text) {
  const imCfg = (config || {}).im || {};
  const sent = [];
  for (const [name, fn] of [["wecom", pushWecom], ["dingtalk", pushDingtalk]]) {
    try {
      if (await fn(imCfg, text)) sent.push(name);
    } catch (e) {
      console.warn(`[${name}] 推送失败:`, e.message);
    }
  }
  return sent;
}

// ==================== 应用内通知中心 ====================
// 铃铛面板的数据源。所有「该让用户知道一声」的事都进这里：任务完成/出错、等待审批、
// 定时任务跑完……而系统通知（desktop）只是它的一种外放形式——两者共用同一个入口，
// 免得以后加事件时漏掉一边。存内存即可：这是「最近发生了什么」的流水，重启清空无妨。
let feed = [];
let feedSeq = 0;
const FEED_MAX = 100;

function pushFeed(kind, title, body, meta) {
  const m = meta || {};
  feedSeq += 1;
  const item = {
    id: `n${Date.now().toString(36)}-${feedSeq}`,
    kind: String(kind || "info"),
    title: String(title || "").slice(0, 120),
    body: String(body || "").replace(/\s+/g, " ").slice(0, 300),
    at: Date.now(),
    read: false,
    session: String(m.session || ""), // 点通知 → 回到那条对话
    target: String(m.target || ""), // 或跳到某个页面（如定时任务）
  };
  feed.unshift(item);
  if (feed.length > FEED_MAX) feed.length = FEED_MAX;
  return item;
}

function feedList() {
  return { items: feed, unread: feed.filter((i) => !i.read).length };
}

/** 标记已读：给 ids 就标这些，不给就全部标掉 */
function feedMarkRead(ids) {
  if (Array.isArray(ids) && ids.length) {
    const want = new Set(ids.map(String));
    for (const i of feed) if (want.has(i.id)) i.read = true;
  } else {
    for (const i of feed) i.read = true;
  }
  return feedList();
}

function feedClear() {
  feed = [];
  return feedList();
}

// ==================== 本机系统通知 ====================
// 三类事件：done 任务完成 / approval 等待审批 / error 任务出错。
// 偏好存 config.json 的 notify 键（设置→通知 面板改，缺省全开）——引擎（主进程）要据此决定弹不弹，
// 所以真源必须在本机配置文件里，不能只存渲染进程的 localStorage。
// 内容纪律：标题/正文只报「发生了什么事」，绝不带对话正文。
let desktopHandler = null;
function setDesktopHandler(fn) {
  desktopHandler = typeof fn === "function" ? fn : null;
}
function desktop(kind, title, body, meta) {
  try {
    // 先进应用内通知中心：它是流水账，不受「弹不弹系统通知」的偏好影响——
    // 用户把某类系统通知关了，不代表他想在铃铛里也看不到这件事。
    pushFeed(kind, title, body, meta);
  } catch {
    /* 通知永远不影响主流程 */
  }
  try {
    let prefs = {};
    try { prefs = require(dataPath("config.json")).notify || {}; } catch {}
    if (prefs[kind] === false) return; // 只认明确的"关"，读不到配置时缺省全开
    if (desktopHandler) desktopHandler(String(title || "KylinWork"), String(body || "").replace(/\s+/g, " ").slice(0, 140));
  } catch {
    /* 通知永远不影响主流程 */
  }
}

module.exports = {
  pushBots,
  pushWecom,
  pushDingtalk,
  desktop,
  setDesktopHandler,
  pushFeed,
  feedList,
  feedMarkRead,
  feedClear,
};
