"use strict";
/**
 * 自动化 / 定时任务 — 到点自动让 Agent 执行任务（如每天早上生成日报、每周五汇总周报）。
 * 任务持久化在 schedules.json。
 *
 * 时间规则有两种写法，二者等价，存的时候都会归一化成 cron：
 *   · repeat：给人看的友好规则（每 N 分钟 / 每 N 小时 / 每天几点 / 每周几几点 / 每月几号几点 / 只跑一次），
 *     界面上的可视化选择器、以及 AI 的 create_schedule 工具都走这个；
 *   · cron：老式的 5 字段表达式（分 时 日 月 周），给习惯直接写的人留的后门。
 * 每个任务还能带一个 workspace_dir：到点就在那个工作空间里干活，不填则跟随当前工作空间。
 * 每次执行都会开一条真正的会话（由上层注入的 startSession 负责）：这样「立即跑」之后
 * 左侧任务列表里能看见它，点进去就是这次执行的对话与产出，而不是只有一个 finalText。
 */

const fs = require("fs");
const path = require("path");
const { dataPath } = require("./paths");
const { getWorkspaceDir, runWithWorkspace } = require("./tools"); // 文件落点跟随工作区（可能被用户在设置里改过）
const { allocateRunDir } = require("./paths");
const jsonStore = require("./store");

const STORE = dataPath("schedules.json");

/** 错过的任务最多往回补一天；关机一个月不该开机就把一个月的晨报全补一遍 */
const MAX_CATCHUP_MS = 24 * 3600 * 1000;
/** 两次 tick 差这么久，就认为中间那段没人看着（睡眠 / 应用关了） */
const GAP_MS = 90 * 1000;
/** 运行记录留多少条。留太多每次存盘都要重写一大坨，留太少查不了昨天 */
const MAX_RUNS = 300;
/** 算「下次什么时候跑」时往后找的上限；找不到（比如 2 月 30 号）就当没有下次 */
const NEXT_SCAN_MS = 370 * 24 * 3600 * 1000;

function loadStore(file) {
  // 坏文件先拿 .bak 顶，再不行改名隔离——原来是静默当空表，紧接着一次保存就把
  // 用户攒的所有定时任务永久抹掉了，全程一句提示都没有
  const j = jsonStore.readJson(file, {}) || {};
  return {
    tasks: Array.isArray(j.tasks) ? j.tasks : [],
    // 运行记录。只有 last_result 的话，昨天跑挂了今天跑好了就查无此事——
    // 自动化最需要回答的问题恰恰是「它这几天到底跑成什么样」，那得留流水。
    runs: Array.isArray(j.runs) ? j.runs : [],
    last_tick_at: j.last_tick_at || "",
  };
}
function saveStore(store, file) {
  // 先写临时文件再改名：直接覆写的话，写到一半断电就只剩半个 JSON，整张任务表就没了
  jsonStore.writeJsonAtomic(file, store, { pretty: true });
}

// ---------- 工作空间解析 ----------
// scheduler 不认识 config.json 里的项目表，把「名字 → 目录」的翻译交给上层注入。
// 上层没注入时按原样当路径用，只做存在性校验。
let resolveWs = (v) => String(v || "").trim();
function setWorkspaceResolver(fn) {
  if (typeof fn === "function") resolveWs = fn;
}
/** 把用户/AI 给的工作空间（名字或路径）解析成一个存在的绝对目录；空则返回空表示「跟随当前」 */
function resolveWorkspaceDir(v) {
  const raw = String(v || "").trim();
  if (!raw) return "";
  const dir = path.resolve(String(resolveWs(raw) || raw));
  if (!fs.existsSync(dir)) throw new Error(`工作空间不存在：${dir}`);
  if (!fs.statSync(dir).isDirectory()) throw new Error(`工作空间不是一个目录：${dir}`);
  return dir;
}

// ---------- 迷你 cron 解析 ----------

/**
 * 解析一个 cron 字段。支持 *、5、1-5、*\/15、1-30/5、5/10，逗号分隔。
 * 越界和写反的一律报错——静默收下的后果是任务永远不触发，而界面上看它一切正常。
 */
function parseField(field, min, max, label) {
  const values = new Set();
  const bad = (why) => new Error(`${label}字段「${field}」${why}`);
  for (const part of String(field).split(",")) {
    const bits = part.split("/");
    if (bits.length > 2) throw bad(`里的「${part}」不认识`);
    let step = 1;
    if (bits.length === 2) {
      if (!/^\d+$/.test(bits[1])) throw bad(`的步长「${bits[1]}」不是数字`);
      step = parseInt(bits[1], 10);
      // 步长 0 会让下面的 for 永远走不动，整个进程就卡死在这一行（server 跑在 Electron 主进程里，界面会一起冻住）
      if (step < 1) throw bad("的步长必须 ≥ 1");
    }
    const range = bits[0];
    let lo, hi, m;
    if (range === "*") {
      lo = min; hi = max;
    } else if ((m = range.match(/^(\d+)-(\d+)$/))) {
      lo = parseInt(m[1], 10); hi = parseInt(m[2], 10);
      if (lo > hi) throw bad(`里的范围「${range}」写反了`);
    } else if (/^\d+$/.test(range)) {
      lo = parseInt(range, 10);
      hi = bits.length === 2 ? max : lo; // 标准 cron：5/10 是「从 5 开始每 10」
    } else {
      throw bad(`里的「${part}」不认识`);
    }
    if (lo < min || hi > max) throw bad(`超出范围，只能是 ${min}-${max}`);
    for (let i = lo; i <= hi; i += step) values.add(i);
  }
  if (!values.size) throw bad("没圈出任何值");
  return values;
}

// 表达式 → 解析结果。解析是纯函数、结果只读，同一条规则每次算下次时间都重解析没意义
const cronCache = new Map();
function parseCron(expr) {
  const key = String(expr || "").trim();
  const hit = cronCache.get(key);
  if (hit) return hit;
  const fields = key.split(/\s+/);
  if (fields.length !== 5) throw new Error("cron 需要 5 个字段：分 时 日 月 周");
  const dow = parseField(fields[4], 0, 7, "周");
  if (dow.has(7)) { dow.delete(7); dow.add(0); } // 标准 cron 里 0 和 7 都是周日
  const out = {
    minute: parseField(fields[0], 0, 59, "分"),
    hour: parseField(fields[1], 0, 23, "时"),
    dom: parseField(fields[2], 1, 31, "日"),
    month: parseField(fields[3], 1, 12, "月"),
    dow,
    // 标准 cron 的怪脾气：日和周都限定了就是「或」，得留着原样才判得出来
    domRestricted: fields[2] !== "*",
    dowRestricted: fields[4] !== "*",
  };
  if (cronCache.size > 500) cronCache.clear();
  cronCache.set(key, out);
  return out;
}

function cronMatches(cron, date) {
  if (!cron.minute.has(date.getMinutes())) return false;
  if (!cron.hour.has(date.getHours())) return false;
  if (!cron.month.has(date.getMonth() + 1)) return false;
  const dom = cron.dom.has(date.getDate());
  const dow = cron.dow.has(date.getDay());
  // 「每月 1 号 或 每周一」——两个都写了具体值时标准 cron 是取或，不是取且
  if (cron.domRestricted && cron.dowRestricted) return dom || dow;
  return dom && dow;
}

// ---------- 友好重复规则（repeat） ----------

const REPEAT_TYPES = ["minutes", "hours", "daily", "weekly", "monthly", "once"];

function clampInt(v, lo, hi, label) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`${label}必须是数字`);
  if (n < lo || n > hi) throw new Error(`${label}要在 ${lo}-${hi} 之间`);
  return n;
}

/**
 * 把界面上选的「重复方式」归一化成一张干净的规则对象。所有数字都夹在合法范围内并报错，
 * 免得 UI 传个 0 分钟的间隔，转身变成永远不触发、界面上却看着一切正常。
 */
function normalizeRepeat(r) {
  if (!r || typeof r !== "object") throw new Error("重复规则不能为空");
  const type = String(r.type || "").trim();
  if (!REPEAT_TYPES.includes(type)) throw new Error(`重复方式不认识：${r.type || "(空)"}`);
  if (type === "minutes") return { type, every: clampInt(r.every ?? 30, 1, 59, "间隔分钟数") };
  if (type === "hours") return { type, every: clampInt(r.every ?? 1, 1, 24, "间隔小时数"), minute: clampInt(r.minute ?? 0, 0, 59, "分钟") };
  if (type === "daily") return { type, hour: clampInt(r.hour ?? 9, 0, 23, "小时"), minute: clampInt(r.minute ?? 0, 0, 59, "分钟") };
  if (type === "weekly") {
    const days = Array.from(new Set((Array.isArray(r.days) ? r.days : []).map((d) => parseInt(d, 10)).filter((d) => d >= 0 && d <= 6))).sort((a, b) => a - b);
    if (!days.length) throw new Error("每周至少要选一天");
    return { type, days, hour: clampInt(r.hour ?? 9, 0, 23, "小时"), minute: clampInt(r.minute ?? 0, 0, 59, "分钟") };
  }
  if (type === "monthly") return { type, day: clampInt(r.day ?? 1, 1, 31, "日期"), hour: clampInt(r.hour ?? 9, 0, 23, "小时"), minute: clampInt(r.minute ?? 0, 0, 59, "分钟") };
  // once：只跑一次，到点即停用
  const at = Date.parse(r.at);
  if (!Number.isFinite(at)) throw new Error("一次性任务要给出具体时间（at，ISO 字符串或时间戳）");
  return { type: "once", at: new Date(at).toISOString() };
}

/** 友好规则 → cron。once 没有 cron（空串），它靠时间点直接判。 */
function repeatToCron(r) {
  const m = r.minute ?? 0;
  switch (r.type) {
    case "minutes": return `*/${r.every} * * * *`;
    case "hours": return `${m} */${r.every} * * *`;
    case "daily": return `${r.minute} ${r.hour} * * *`;
    case "weekly": return `${r.minute} ${r.hour} * * ${r.days.join(",")}`;
    case "monthly": return `${r.minute} ${r.hour} ${r.day} * *`;
    default: return "";
  }
}

/** 友好规则 → 人话，用于回报给用户/展示 */
const WEEK_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
function describeRepeat(r) {
  if (!r) return "";
  const hm = (h, m) => `${String(h ?? 0).padStart(2, "0")}:${String(m ?? 0).padStart(2, "0")}`;
  switch (r.type) {
    case "minutes": return `每 ${r.every} 分钟`;
    case "hours": return `每 ${r.every} 小时（第 ${r.minute ?? 0} 分）`;
    case "daily": return `每天 ${hm(r.hour, r.minute)}`;
    case "weekly": return `每周${(r.days || []).map((d) => WEEK_CN[d] || d).join("、")} ${hm(r.hour, r.minute)}`;
    case "monthly": return `每月 ${r.day} 号 ${hm(r.hour, r.minute)}`;
    case "once": return `只跑一次：${new Date(r.at).toLocaleString("zh-CN", { hour12: false })}`;
    default: return JSON.stringify(r);
  }
}

/** 下次该跑的时间（ISO），没有下次返回 null。对不可能成立的规则（2 月 30 号）扫不到就返回 null */
// 结果按「规则 + 分钟」缓存：同一分钟内同一条规则下次时间不会变。坏规则要扫满 370 天
// （五十多万次 cronMatches）才判定没有下次，而 list() 会给每个启用任务都算一遍——
// 不缓存的话每次 GET /api/schedules 都在重扫。
const nextRunCache = new Map();
function nextRunAt(item, from = new Date()) {
  if (item.repeat && item.repeat.type === "once") {
    const at = Date.parse(item.repeat.at || "");
    return Number.isFinite(at) && at > from.getTime() ? new Date(at).toISOString() : null;
  }
  const key = String(item.cron || "") + "@" + Math.floor(from.getTime() / 60000);
  if (nextRunCache.has(key)) return nextRunCache.get(key);
  let result = null;
  try {
    const cron = parseCron(item.cron);
    // 从下一分钟起往后找。逐分钟推进对「每分钟」这类规则第一下就命中，只有坏规则才扫到底
    let d = new Date(Math.floor(from.getTime() / 60000) * 60000 + 60000);
    const limit = from.getTime() + NEXT_SCAN_MS;
    while (d.getTime() <= limit) {
      if (cronMatches(cron, d)) { result = d.toISOString(); break; }
      d = new Date(d.getTime() + 60000);
    }
  } catch {
    result = null;
  }
  if (nextRunCache.size > 1000) nextRunCache.clear();
  nextRunCache.set(key, result);
  return result;
}

// ---------- 调度器 ----------

/** 当前活动的调度器。AI 的 create_schedule 工具要往这里放任务，但 agent 的 runtime 先于
 *  scheduler 建好，所以用这个晚绑定的小注册表把两边接上。 */
let activeScheduler = null;
function setActiveScheduler(s) { activeScheduler = s; }
function getActiveScheduler() { return activeScheduler; }

function createScheduler({ runtime, onResult, storePath, startSession }) {
  // 测试要能指到别处去，不然一跑测试就把用户真的任务表洗了
  const file = storePath || STORE;
  const store = loadStore(file);
  let lastMinuteKey = "";
  /** 正在跑的任务 id → 开始时间戳。同一个任务不许叠着跑，上一次没跑完就跳过这次 */
  const running = new Map();
  /** 已排进队列、还没轮到跑的任务 id。防止手动点一下、到点又触发一下，排两遍 */
  const pending = new Set();
  /** 上次看表是什么时候。开机第一眼不补跑，否则第一次装起来就会把历史全部重放一遍 */
  let lastTickMs = store.last_tick_at ? Date.parse(store.last_tick_at) || 0 : 0;

  // 所有定时执行串成一条队列。工作空间是全局单例（工具的落点、cwd 都跟着它走），
  // 两个任务同时跑、各自切一次工作空间，就会互相把对方的目录半路拽走。串行虽慢但结果对。
  let queue = Promise.resolve();
  function enqueue(fn) {
    const p = queue.then(fn, fn);
    queue = p.then(() => {}, () => {});
    return p;
  }

  function list() {
    return store.tasks.map((t) => ({
      ...t,
      running: running.has(t.id),
      running_since: running.get(t.id) ? new Date(running.get(t.id)).toISOString() : null,
      last_run_at: t.last_run || null,
      next_run_at: t.enabled ? nextRunAt(t) : null,
    }));
  }

  function add({ name, cron, repeat, task, prompt, catch_up, workspace_dir }) {
    const text = String(task || prompt || "").trim();
    if (!text) throw new Error("任务内容不能为空");
    // 两种写法二选一：友好规则优先，其次才认裸 cron
    let rep = null;
    let expr = "";
    if (repeat) {
      rep = normalizeRepeat(repeat);
      expr = repeatToCron(rep);
      if (expr) parseCron(expr); // 校验派生出来的表达式
    } else {
      expr = String(cron || "").trim();
      parseCron(expr);
    }
    const item = {
      id: "sch_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: String(name || "").trim() || text.slice(0, 30),
      cron: expr,
      repeat: rep,
      task: text,
      // 到点在哪个工作空间里干活。空 = 跟随当前工作空间
      workspace_dir: resolveWorkspaceDir(workspace_dir),
      enabled: true,
      // 错过了要不要补：默认补。笔记本合上盖子过一夜，晨报不该就这么没了
      catch_up: catch_up !== false,
      created_at: new Date().toISOString(),
      last_run: null,
      last_result: null,
    };
    store.tasks.push(item);
    saveStore(store, file);
    return item;
  }

  /** 改一个已有任务（名字/时间/内容/工作空间）。以前只能删了重建，改个时间点就丢了运行记录 */
  function update(id, patch) {
    const t = store.tasks.find((t) => t.id === id);
    if (!t) return null;
    if (patch.name !== undefined) t.name = String(patch.name).trim() || t.name;
    if (patch.task !== undefined || patch.prompt !== undefined) {
      const v = String(patch.task !== undefined ? patch.task : patch.prompt).trim();
      if (!v) throw new Error("任务内容不能为空");
      t.task = v;
    }
    // 时间规则：给了 repeat 就以它为准（并清掉裸 cron），给了 cron 才退回裸表达式
    if (patch.repeat !== undefined) {
      t.repeat = patch.repeat ? normalizeRepeat(patch.repeat) : null;
      const expr = t.repeat ? repeatToCron(t.repeat) : "";
      if (expr) parseCron(expr);
      t.cron = expr;
    } else if (patch.cron !== undefined) {
      parseCron(patch.cron); // 校验：写坏了当场报，别等到永远不触发才发现
      t.cron = String(patch.cron).trim();
      t.repeat = null;
    }
    if (patch.workspace_dir !== undefined) t.workspace_dir = resolveWorkspaceDir(patch.workspace_dir);
    if (patch.catch_up !== undefined) t.catch_up = !!patch.catch_up;
    saveStore(store, file);
    return t;
  }

  /** 运行记录，最近的在前 */
  function runs(limit = 100) {
    return store.runs.slice(-Math.max(1, limit)).reverse();
  }

  function remove(id) {
    const before = store.tasks.length;
    store.tasks = store.tasks.filter((t) => t.id !== id);
    store.runs = store.runs.filter((r) => r.task_id !== id);
    saveStore(store, file);
    return store.tasks.length < before;
  }

  function toggle(id, enabled) {
    const t = store.tasks.find((t) => t.id === id);
    if (!t) return false;
    t.enabled = enabled;
    saveStore(store, file);
    return true;
  }

  /** 错过了补不补跑 */
  function setCatchUp(id, on) {
    const t = store.tasks.find((t) => t.id === id);
    if (!t) return false;
    t.catch_up = !!on;
    saveStore(store, file);
    return true;
  }

  /** 实际执行体。串行队列保证同一时刻只有一个在跑工作空间切换 */
  async function doRun(ref, trigger) {
    // list() 出去的是副本，外面拿着副本回来跑的话，进度会写在副本上存不下来——一律换回本体
    const item = store.tasks.find((t) => t.id === (ref && ref.id ? ref.id : ref));
    if (!item) throw new Error("任务不存在");
    if (running.has(item.id)) {
      const since = new Date(running.get(item.id)).toTimeString().slice(0, 5);
      throw new Error(`这个任务正在跑（${since} 开始），等它跑完再说`);
    }
    console.log(`[定时任务] 触发 (${trigger}): ${item.name}`);
    running.set(item.id, Date.now());
    const startedMs = Date.now();
    item.last_run = new Date().toISOString();
    item.last_trigger = trigger;
    const run = {
      id: "run_" + startedMs.toString(36) + Math.random().toString(36).slice(2, 6),
      task_id: item.id,
      name: item.name,
      trigger,
      started_at: item.last_run,
      ended_at: null,
      ok: null,
      ms: 0,
      result: "",
    };
    store.runs.push(run);
    if (store.runs.length > MAX_RUNS) store.runs.splice(0, store.runs.length - MAX_RUNS);
    saveStore(store, file);

    const finish = (ok, text) => {
      run.ok = ok;
      run.ended_at = new Date().toISOString();
      run.ms = Date.now() - startedMs;
      run.result = String(text || "").slice(0, 500);
      // 定时任务是无人值守的：成败都得让本机知道一声，不然跑挂了要等用户自己发现今天的日报没来
      // 每次执行都开了一条会话（上面 startSession），所以点通知能直接跳进那条对话看过程；
      // 只有在没有会话宿主时才退回「自动化」页看执行记录
      try { require("./notify").desktop(ok ? "done" : "error", ok ? "定时任务完成" : "定时任务出错", item.name, run.session_id ? { session: run.session_id } : { target: "/automation" }); } catch {}
    };

    // 在任务自己的工作空间里干活。用 AsyncLocalStorage 把目录绑到本次调用链上，不动全局：
    // 以前是「切过去、跑完切回来」，用户中途改工作空间会被这行恢复抹掉，或者任务后半程写错地方。
    const execute = async () => {
      // 一次执行一个成果子目录（定时_月日_任务名）：不隔离的话，每天自动跑的产出全挤在
      // 工作区根目录，两周后就分不清哪份周报是哪天生成的。只在默认工作区里分——用户自选了
      // 目录意味着素材在原地，别替他做主建文件夹
      let baseDir;
      if (path.resolve(getWorkspaceDir()) === dataPath("workspace")) {
        baseDir = allocateRunDir(getWorkspaceDir(), "定时", item.name || item.task);
      }
      let finalText;
      if (startSession) {
        // 开一条真正的会话（transcript / 直播 / 停止 都走它）：这样「立即跑」之后
        // 左侧任务列表里能看见这条任务在跑，点进去就是它的对话与产出
        const s = startSession({ item, run, baseDir, workspaceDir: getWorkspaceDir() });
        run.session_id = s.sessionId;
        run.session_project = s.project || "";
        item.session_id = s.sessionId;
        // 立刻落盘：前端是轮询运行记录来列会话的，不存这一下就要等到跑完才看得见
        saveStore(store, file);
        finalText = await s.done;
      } else {
        // 没有会话宿主（测试 / 精简调用）时的老路径：跑完只有一段 finalText
        const history = [{ role: "user", content: item.task }];
        const r = await runtime.runTask({ history, baseDir });
        finalText = r && r.finalText;
      }
      item.last_result = (finalText || "完成").slice(0, 500);
      finish(true, finalText || "完成");
      // 一次性任务跑完就收工，别明天同一分钟又跑一遍
      if (item.repeat && item.repeat.type === "once") item.enabled = false;
      saveStore(store, file);
      if (onResult) await onResult(item, finalText);
      return finalText;
    };
    try {
      // 目录要是已经被删了，runWithWorkspace 里的建目录会抛；下面的 finally 仍会清掉
      // running/pending，任务不会卡在「运行中」再也跑不了
      return await runWithWorkspace(item.workspace_dir, execute);
    } catch (e) {
      item.last_result = "出错: " + e.message;
      finish(false, "出错: " + e.message);
      saveStore(store, file);
      if (onResult) await onResult(item, "执行出错: " + e.message);
      throw e;
    } finally {
      running.delete(item.id);
      pending.delete(item.id);
    }
  }

  /** 跑一个任务（手动点「立即跑」和内部触发都走这里）。返回结果供调用方 await。
   *  async：拒绝走 rejected promise，调用方一律用 try/catch 或 .catch 接得住 */
  async function runOne(ref, trigger) {
    const item = store.tasks.find((t) => t.id === (ref && ref.id ? ref.id : ref));
    if (!item) throw new Error("任务不存在");
    if (running.has(item.id) || pending.has(item.id)) {
      throw new Error(`这个任务正在跑，等它跑完再说`);
    }
    pending.add(item.id);
    return enqueue(() => doRun(item.id, trigger || "手动"));
  }

  function fire(item, trigger) {
    if (running.has(item.id) || pending.has(item.id)) {
      console.log(`[定时任务] ${item.name} 上一次还没跑完，跳过这次`);
      return false;
    }
    runOne(item.id, trigger).catch((e) => console.error(`[定时任务] ${item.name} 失败:`, e.message));
    return true;
  }

  /**
   * 中间断了一段（睡眠、应用关着）时，把那段时间里本该触发的任务捞出来。
   * 一段里命中几次也只补跑一次，补的是最近该跑的那次——补跑是「这件事还没做」，
   * 不是把闹钟按错过的次数重放一遍。返回补了哪些 id。
   */
  function catchUp(fromMs, toMs) {
    const fired = new Set();
    const start = Math.max(fromMs, toMs - MAX_CATCHUP_MS);
    if (toMs - fromMs > MAX_CATCHUP_MS) {
      console.warn(`[定时任务] 停了 ${Math.round((toMs - fromMs) / 3600000)} 小时，只补最近 24 小时的，更早的按过期丢掉`);
    }
    // 从断点后的下一分钟找到本次 tick 的前一分钟；当前这一分钟走正常路径，别重复
    const from = Math.floor(start / 60000) * 60000 + 60000;
    const to = Math.floor(toMs / 60000) * 60000;
    for (const item of store.tasks) {
      if (!item.enabled || item.catch_up === false) continue;
      // 一次性任务的「错过」没有补的意义：要么时间还没到，要么早就该跑过了，交给正常 tick
      if (item.repeat && item.repeat.type === "once") continue;
      let cron;
      try { cron = parseCron(item.cron); } catch { continue; }
      let at = null;
      for (let ms = from; ms < to; ms += 60000) {
        const d = new Date(ms);
        if (cronMatches(cron, d)) at = d;
      }
      if (!at) continue;
      item.missed_at = at.toISOString();
      console.log(`[定时任务] ${item.name} 错过了 ${at.toTimeString().slice(0, 5)} 那次，现在补跑`);
      if (fire(item, "补跑")) fired.add(item.id);
    }
    return fired;
  }

  function tick() {
    const now = new Date();
    const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    if (key === lastMinuteKey) return; // 每分钟只判断一次
    lastMinuteKey = key;
    const nowMs = now.getTime();
    let caught = new Set();
    if (lastTickMs && nowMs - lastTickMs > GAP_MS) {
      try { caught = catchUp(lastTickMs, nowMs); } catch (e) { console.warn("[定时任务] 补跑检查出错:", e.message); }
    }
    lastTickMs = nowMs;
    store.last_tick_at = now.toISOString();
    for (const item of store.tasks) {
      if (!item.enabled || caught.has(item.id)) continue; // 刚补跑过的这次就别再来一遍
      // 一次性任务：到点就跑，只跑一次
      if (item.repeat && item.repeat.type === "once") {
        const at = Date.parse(item.repeat.at || "");
        if (Number.isFinite(at) && nowMs >= at) fire(item, "定时");
        continue;
      }
      try {
        if (cronMatches(parseCron(item.cron), now)) fire(item, "cron");
      } catch (e) {
        console.warn(`[定时任务] ${item.name} cron 无效:`, e.message);
      }
    }
    saveStore(store, file);
  }

  const timer = setInterval(tick, 20000);
  timer.unref && timer.unref();

  const api = { list, add, update, remove, toggle, setCatchUp, runOne, runs, tick, catchUp, stop: () => clearInterval(timer) };
  return api;
}

module.exports = {
  createScheduler,
  parseCron,
  cronMatches,
  normalizeRepeat,
  repeatToCron,
  describeRepeat,
  nextRunAt,
  setWorkspaceResolver,
  setActiveScheduler,
  getActiveScheduler,
};
