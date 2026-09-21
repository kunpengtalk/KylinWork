"use strict";
/**
 * KylinWork — 服务器主入口。
 * 功能：Web 工作台（SSE 流式）、技能系统、MCP 连接器、专家团多智能体、IM 远程指挥（飞书/企业微信/通用 Webhook）。
 */

const BOOT_T0 = Date.now(); // 本文件从加载到 listen 的耗时，启动慢时先看这行日志
const express = require("express");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const { DATA_DIR, dataPath, appPath } = require("./paths");
const { createLLM, createEmbedder } = require("./llm");
const { outputFiles, safePath, getWorkspaceDir, setWorkspaceDir, SEARCH_PROVIDERS, searchProviderKey, shellPath } = require("./tools");
const { previewData } = require("./preview");
const evolve = require("./evolve");
const { McpManager } = require("./mcp");
const { createAgentRuntime } = require("./agent");
const { createImRouter } = require("./im");
const { createScheduler, setActiveScheduler, setWorkspaceResolver } = require("./scheduler");
const account = require("./account");
const security = require("./security");
const memory = require("./memory");
const knowledge = require("./knowledge"); // 知识库（多库 RAG）：文件入库、检索、上下文注入
const { createKnowledgeRouter } = require("./api/knowledge"); // 知识库 HTTP 接口（已从本文件拆出）
const { createCloudRouter } = require("./api/cloud"); // 模型云服务 / 模型清单 HTTP 接口（已从本文件拆出）
const { createSchedulesRouter } = require("./api/schedules"); // 定时任务管理 HTTP 接口（已从本文件拆出）
const { createMemoryRouter } = require("./api/memory"); // 长期记忆 / 记忆搬家 HTTP 接口（已从本文件拆出）
const { createEvolveRouter } = require("./api/evolve"); // 自进化 HTTP 接口（已从本文件拆出）
const notify = require("./notify");
const store = require("./store");
const { createImSessionStore } = require("./im/im-store");
const proxy = require("./proxy"); // 云端平台环境与网关地址（也会用于下面的 mount）
const modelCfg = require("./model-config"); // 模型渠道/选中模型的统一口径（渠道可挂多个模型）
const cloudProviders = require("./cloud-providers"); // 模型云服务：内置服务商目录 + Key + 物化成渠道

// 内置 AI 引擎（pi）要求 Node ≥22.19（pi 包自己的 engines 声明）。
// 桌面版跑在 Electron 里，实测 Node 24.18，不受影响；用 npm start 起服务端时本机 Node 不够，
// 就在这里明确报错——否则会变成一个看不懂的 ESM/模块加载失败。
function assertNodeVersion() {
  const [maj, min] = String(process.versions.node).split(".").map(Number);
  if (maj > 22 || (maj === 22 && min >= 19)) return;
  console.error(
    `\n[环境] 本机 Node ${process.versions.node} 低于 KylinWork 要求的 22.19（内置 AI 引擎 pi 的硬性要求）。\n` +
      `  解法二选一：① 升级本机 Node 到 22.19 以上；② 用桌面版 npm run app —— 它自带运行时，不依赖本机 Node。\n`
  );
  process.exit(1);
}
assertNodeVersion();

// config.json 不入 git（可能含 API Key）；首次运行自动从模板复制
const CONFIG_PATH = dataPath("config.json");
if (!fs.existsSync(CONFIG_PATH)) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.copyFileSync(appPath("config.example.json"), CONFIG_PATH);
  console.log("已从 config.example.json 生成 config.json，请填入你的模型 API Key");
}
// 配置读坏了不能就这么空着起来：那样界面上所有 Key 都变成空的，用户随手一保存就把
// 真 Key 覆盖没了。store 会先拿 .bak 顶（Key 原样还在），实在顶不住才把坏文件改名隔离、
// 退回模板——原文还在 .corrupt-时间戳 里，Key 捞得回来。
const config = store.readJson(CONFIG_PATH, JSON.parse(fs.readFileSync(appPath("config.example.json"), "utf8")));

// 旧配置迁移：生成 models 列表（内置国产模型预设 + 自定义），active_model 指定当前使用的渠道。
// 一个渠道可以挂多个模型（models[]），model 是渠道默认模型。
if (!Array.isArray(config.models) || !config.models.length) {
  const old = config.openai || {};
  config.models = [
    { name: "DeepSeek", provider: "openai", base_url: "https://api.deepseek.com/v1", api_key: old.base_url?.includes("deepseek") ? old.api_key || "" : "", model: "deepseek-chat", models: ["deepseek-chat", "deepseek-reasoner"] },
    { name: "通义Qwen", provider: "openai", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", api_key: "", model: "qwen-max", models: ["qwen-max", "qwen-plus", "qwen-turbo"] },
    { name: "智谱GLM", provider: "openai", base_url: "https://open.bigmodel.cn/api/paas/v4", api_key: "", model: "glm-4-plus", models: ["glm-4-plus", "glm-4-air", "glm-4-flash"] },
    { name: "Kimi", provider: "openai", base_url: "https://api.moonshot.cn/v1", api_key: "", model: "moonshot-v1-32k", models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"] },
    { name: "Ollama本地", provider: "openai", base_url: "http://localhost:11434/v1", api_key: "", model: "qwen3:14b", models: ["qwen3:14b"] },
  ];
  config.active_model = "DeepSeek";
  saveConfig();
}

// 老配置没有 models[]：用 model 顶上，并把 active_model / active_model_id 落回合法值
if (modelCfg.normalizeChannels(config)) saveConfig();

// 模型云服务：老 config.models 渠道一次性迁进 cloud_providers（Key/模型原样保留），
// 之后 config.models 由「启用且配好的服务商」物化而来，引擎侧照旧只认渠道。
if (!config.__cloud_migrated) {
  cloudProviders.ensureMigrated(config);
  config.models = []; // 老渠道已进 cloud_providers，清掉免得被当成手写渠道重复保留
  cloudProviders.materializeChannels(config);
  saveConfig();
}

security.getSecurity(config); // 补齐安全中心默认策略
config.shortcuts = config.shortcuts || {}; // 快捷键自定义绑定（只存改过的项，默认值在前端定义）
// 助理的名字和头像：想叫它「小秘」就叫「小秘」。界面（气泡头像/侧栏/品牌位）和系统提示词都跟着这里走
const ASSISTANT_DEFAULT = { name: "KylinWork", avatar: "🤖" };
config.assistant = { ...ASSISTANT_DEFAULT, ...(config.assistant || {}) };

// 知识库：embedding / rerank 不在这里单配 key，而是引用「设置 → 模型」里标了
// kind=embedding / kind=rerank 的渠道模型（复合键「渠道::模型」）。这里只留检索调参。
config.knowledge = {
  embedding: "",
  rerank: "",
  chunk_size: 800,
  chunk_overlap: 120,
  top_k: 6,
  score_threshold: 0,
  inject_chars: 6000,
  ...(config.knowledge || {}),
};

if (config.workspace_dir) {
  try {
    setWorkspaceDir(config.workspace_dir);
  } catch (e) {
    console.warn("workspace_dir 无效，使用默认工作空间:", e.message);
  }
}
let llmInner = createLLM(config);
// 记忆向量召回：有能算 embeddings 的渠道就接上，没有就退回关键词匹配（memory 自己兜底）
memory.setEmbedder(createEmbedder(config));
memory.ensureVectors().then((r) => { if (r.computed) console.log(`[记忆向量] 启动补算了 ${r.computed} 条`); }).catch((e) => console.warn("[记忆向量] 启动补算失败:", e.message));
// 知识库：检索参数与向量/重排渠道都从 config 读，注入后配置变更时同步刷新
knowledge.setConfig(config);
knowledge.setEmbedder(createEmbedder(config));
// 上次退出时没跑完的入库任务放回队列继续（不然它们会永远卡在「建索引中」）
try {
  const q = knowledge.resumeQueue();
  if (q.queued) console.log(`[知识库] 启动继续入库：队列里还有 ${q.queued} 个任务`);
} catch (e) {
  console.warn("[知识库] 恢复入库队列失败：", e.message);
}
// 可热替换的 LLM 包装：设置修改后 runtime 无需重建
const llm = {
  get provider() { return llmInner.provider; },
  get model() { return llmInner.model; },
  chat: (args) => llmInner.chat(args),
};
/** 按对话覆盖模型：会话里选过就用会话的，没选跟全局默认。
 *  选过的模型已被从列表删掉 → 明确报错，绝不悄悄换成别的模型跑 */
function llmForSession(sess) {
  const name = sess && sess.model;
  if (!name) return llm;
  if (modelCfg.findChannel(config, name)) {
    return createLLM({ ...config, active_model: name, active_model_id: (sess && sess.model_id) || "" });
  }
  return {
    provider: name,
    model: name,
    chat: () => Promise.reject(new Error(`该对话指定的模型「${name}」已不在模型列表里。点输入框右下角的模型按钮重新选一个，或选「跟随全局默认」。`)),
  };
}
// 同一模型连续「整跑失败」计数（成功一次即清零）：连挂说明是模型/渠道本身的问题，光报错用户不知道该干嘛
const modelFailStreak = new Map();

// 模型健康账本：每次整跑记一笔成败（按模型条目名，滚动只留最近 20 次），选模型时能看到
// 「这个渠道最近靠不靠谱」，不用踩了才知道。落盘 data/model_health.json，重启不清零
const HEALTH_FILE = dataPath("data", "model_health.json");
const modelHealth = store.readJson(HEALTH_FILE, {}) || {};
function recordModelHealth(name, ok, failMsg) {
  if (!name) return;
  const h = (modelHealth[name] = modelHealth[name] || { recent: [] });
  h.recent.push(ok ? 1 : 0);
  if (h.recent.length > 20) h.recent = h.recent.slice(-20);
  if (ok) h.last_ok_t = Date.now();
  else { h.last_fail_t = Date.now(); h.last_fail = String(failMsg || "").slice(0, 200); }
  try { store.writeJsonAtomic(HEALTH_FILE, modelHealth); } catch {}
}
function healthSummary() {
  const out = {};
  for (const [name, h] of Object.entries(modelHealth)) {
    const recent = Array.isArray(h.recent) ? h.recent : [];
    let streak = 0;
    for (let i = recent.length - 1; i >= 0 && !recent[i]; i--) streak++;
    out[name] = { n: recent.length, ok: recent.filter(Boolean).length, fail_streak: streak, last_fail: h.last_fail || "", last_fail_t: h.last_fail_t || 0 };
  }
  return out;
}

// 专家团：数组引用被 runtime 闭包持有，增删改都就地改这个数组（热生效，无需重启）
const EXPERTS_FILE = dataPath("experts.json");
const experts = [];
const expertTeams = []; // 专家团 = 智能体团队，同样是被 runtime 闭包持有的活引用
let expertsMeta = store.readJson(EXPERTS_FILE, {}) || {};
experts.push(...(expertsMeta.experts || []));
expertTeams.push(...(expertsMeta.teams || []));
function saveExperts() {
  store.writeJsonAtomic(EXPERTS_FILE, { ...expertsMeta, experts, teams: expertTeams }, { pretty: true });
}
const mcpManager = new McpManager();
let imBridge = null; // IM 桥（含飞书长连接控制），init() 里创建

// ---------- 会话持久化：内存 + 磁盘（data/sessions/<id>.json） ----------
// 结构：{ history: 统一格式历史(供LLM), transcript: 界面回放记录, title, updated_at }
const SESS_DIR = dataPath("data", "sessions");
const sessions = new Map();
const activeRuns = new Map(); // sessionId -> { ctrl: AbortController, interject: [] }（「停止」与「插队」用）
// 正在跑的任务落一份名单到磁盘：应用中途被关/被重启时，内存里的 activeRuns 直接蒸发，
// 下次启动就靠这份名单知道哪些会话是被打断的，在回放里明说，而不是让那一轮无声地断在半空
const RUNNING_FILE = dataPath("data", "running.json");
function persistRunning() {
  try { store.writeJsonAtomic(RUNNING_FILE, [...activeRuns.keys()]); } catch {}
}
function sweepInterruptedRuns() {
  const ids = store.readJson(RUNNING_FILE, []);
  if (!Array.isArray(ids) || !ids.length) return;
  let marked = 0;
  for (const id of ids) {
    try {
      const sess = getSession(id);
      const last = sess.transcript[sess.transcript.length - 1];
      if (!last || last.type !== "assistant") continue;
      const evs = last.events || (last.events = []);
      const tail = evs[evs.length - 1];
      if (tail && tail.type === "error") continue; // 已有明确收场就别重复盖章
      evs.push({ type: "error", message: "应用在任务执行中被关闭或重启，这一轮已中断（已完成的进度和文件都还在）。可以对我说「接着上次进度继续」。" });
      saveSession(id);
      marked++;
    } catch {}
  }
  try { store.writeJsonAtomic(RUNNING_FILE, []); } catch {}
  if (marked) console.log(`[恢复] 检测到 ${marked} 个被重启打断的任务，已在会话回放里标注中断`);
}
const assignedDirs = new Set(); // 刚分配、还没写出文件的对话文件夹名：两个新对话同时起步不许撞同名

/** 给对话分配成果文件夹（任务_月日_标题），并把「消息发出前就传上来的」附件一起搬进去。
 *  搬运失败一概不抛：文件夹没建成事小，因为一个附件搬不动就让整条对话起不来事大。*/
function assignSessionDir(sess, message) {
  const d = new Date();
  const stamp = String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
  // 【任务类型：X】是给模型看的前缀，起标题时早就洗掉了，文件夹名这儿漏了——
  // 于是真实数据里躺着一个「任务_0826_任务类型数据分析及可视化_3」，
  // 用户看到的是分类词，真正做的那件事（篮球减肥训练计划）一个字都没进名字。
  const src = String(sess.title || message).replace(/^\s*【任务类型：[^】]*】\s*/, "");
  const slug = src.replace(/https?:\/\/\S+/g, "").replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 12) || "对话";
  let dir = `任务_${stamp}_${slug}`;
  for (let i = 2; fs.existsSync(path.join(getWorkspaceDir(), dir)) || assignedDirs.has(dir); i++) dir = `任务_${stamp}_${slug}_${i}`;
  assignedDirs.add(dir);
  sess.dir = dir; // 存进会话，后续轮次/重启都落同一个文件夹
  const full = path.join(getWorkspaceDir(), dir);
  try { fs.mkdirSync(full, { recursive: true }); } catch {}
  for (const n of sess.pending_uploads || []) {
    try {
      const from = path.join(getWorkspaceDir(), n), to = path.join(full, n);
      // 根目录同名的可能是别人的旧文件，只搬确实存在、且目标位置还空着的
      if (fs.existsSync(from) && fs.statSync(from).isFile() && !fs.existsSync(to)) fs.renameSync(from, to);
    } catch {}
  }
  sess.pending_uploads = [];
  return dir;
}

function sessFile(id) {
  return path.join(SESS_DIR, id.replace(/[^\w-]/g, "_") + ".json");
}
function getSession(id) {
  if (!sessions.has(id)) {
    // 会话文件坏了不抛错（不能因为一条对话打不开就让整个工作台起不来），
    // 但也绝不装作没有过这条对话：store 会先拿 .bak 顶上，实在不行把坏文件改名隔离
    const data = store.readJson(sessFile(id), { history: [], transcript: [], title: "", updated_at: null });
    sessions.set(id, data);
  }
  return sessions.get(id);
}
function saveSession(id) {
  const s = sessions.get(id);
  if (!s || !s.history) return;
  s.updated_at = new Date().toISOString();
  store.writeJsonAtomic(sessFile(id), s);
}

// 任务跑一半崩了 / 用户直接退出 App，这一轮的过程就全没了——中途也存，最多每 5 秒一次。
// 存的是同一份对象，落盘又是原子改名，跟收尾时那次 saveSession 不会打架。
const sessSaveAt = new Map();
function autosaveSession(id, minGapMs = 5000) {
  const now = Date.now();
  if (now - (sessSaveAt.get(id) || 0) < minGapMs) return;
  sessSaveAt.set(id, now);
  try {
    saveSession(id);
  } catch (e) {
    console.warn(`[会话] 中途存盘失败（${id}）：${e.message}`);
  }
}

// IM 会话跟网页会话分开存（data/im-sessions/<键>.json），重启不丢上下文
const imSessions = createImSessionStore({ dir: dataPath("data", "im-sessions") });

/**
 * 定时 / 自动任务开一条真正的会话。
 * <p>
 * 以前定时任务只调 runtime.runTask 拿一个 finalText，过程一个字都不进会话表：
 * 界面上点「立即跑」只弹一句「已触发」，左侧任务列表里空空如也，用户根本不知道
 * 它跑没跑、跑到哪了、产出去哪了。现在每次执行都登记成一条 session（id 前缀 sch_），
 * transcript 照常落盘 —— 于是它和普通对话一样出现在列表里、能点进去看直播和回放，
 * 也能被「停止」。
 * @returns {{ sessionId: string, project: string, done: Promise<string> }}
 */
function startScheduleSession({ item, run, baseDir, workspaceDir, runtime: rt }) {
  const sessionId = "sch_" + run.id;
  const sess = getSession(sessionId);
  const owner = account.defaultUser();
  // 这条会话属于哪个工作空间：按任务实际生效的目录反查项目名，查不到就退回目录名。
  // 侧栏按工作空间过滤会话，这一格填错，任务就会跑到别人的分组下面。
  const wsDir = path.resolve(workspaceDir || getWorkspaceDir());
  const proj = (config.projects || []).find((p) => p && path.resolve(String(p.dir || "")) === wsDir);
  const project = proj ? proj.name : path.basename(wsDir) || activeProject();
  const title = String(item.name || item.task || "定时任务").slice(0, 40);
  const at = new Date().toISOString();
  sess.title = title;
  sess.source = "schedule";
  sess.schedule_id = item.id;
  sess.project = project;
  sess.dir = baseDir || sess.dir || null;
  if (owner && !sess.user) sess.user = owner.username;
  sess.history.push({ role: "user", content: item.task });
  sess.transcript.push({ type: "user", text: item.task, at });
  const asstEvents = [];
  sess.transcript.push({ type: "assistant", events: asstEvents, at });
  // runState 的形状与 /api/chat 里那份保持一致：续流（/api/chat/stream/:id）和
  // 停止（/api/chat/stop）都认这一份，少一个字段那条路径就会静默失效
  const runState = { ctrl: new AbortController(), interject: [], asks: new Map(), subscribers: new Set(), events: asstEvents };
  // 事件一边进 transcript，一边推给续流进来的订阅者。少了推送这一半，用户打开这条
  // 正在跑的会话只能看到「连上那一刻的回放」，之后再没有任何动静——看起来就像卡死了。
  const send = (ev) => {
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const sub of runState.subscribers) { try { sub.write(line); } catch {} }
  };
  activeRuns.set(sessionId, runState);
  persistRunning();
  saveSession(sessionId);
  // 无人值守：不传 askUser，agent 的 ask_user 会按「没人在线」走默认判断（见 agent.js）
  const emitFn = recordingEmit(send, asstEvents, sessionId);
  const done = (async () => {
    try {
      const r = await rt.runTask({
        taskLabel: title,
        baseDir,
        history: sess.history,
        emit: emitFn,
        stopSignal: runState.ctrl.signal,
        getInterject: () => runState.interject.splice(0),
      });
      return (r && r.finalText) || "完成";
    } catch (e) {
      // 跑挂了也要在会话里留一条错误：不然点进这条会话只有一个空气泡，
      // 用户看不出是「还在跑」还是「早失败了」，而失败原因只躺在运行记录里没人会去翻
      const msg = String((e && e.message) || e);
      asstEvents.push({ type: "error", message: msg });
      send({ type: "error", message: msg });
      throw e;
    } finally {
      activeRuns.delete(sessionId);
      persistRunning();
      // 收工就把续流连接关掉：前端的「这一轮结束了」是靠流读完触发的，
      // 不关的话那条会话会永远显示成「运行中」，直到用户重进对话页才对账纠正
      for (const sub of runState.subscribers) { try { sub.end(); } catch {} }
      runState.subscribers.clear();
      try { saveSession(sessionId); } catch (e) { console.warn(`[定时任务] 会话落盘失败（${sessionId}）：${e.message}`); }
    }
  })();
  return { sessionId, project, done };
}

/** 包装 emit：把事件同时记录到 transcript（文本增量合并，跳过噪音事件），顺便中途存盘 */
// ---------- Goal 目标模式 ----------
// 用户给一个目标，先拆成可验收的标准，跑完一轮就对着标准验收，没达标自动再跑（最多 GOAL_MAX_ROUNDS 轮）。
// 验收宁严勿宽：拿不准一律算未达成——目标卡上打了勾就必须是真的
const GOAL_MAX_ROUNDS = 3;

function goalFileInventory(sess) {
  try {
    if (!sess.dir) return "（本对话还没有成果文件夹）";
    const dir = path.join(getWorkspaceDir(), sess.dir);
    const names = fs.readdirSync(dir).filter((n) => !n.startsWith("."));
    if (!names.length) return "（成果文件夹是空的）";
    return names.slice(0, 40).map((n) => {
      try { const st = fs.statSync(path.join(dir, n)); return `${n}（${st.isDirectory() ? "目录" : st.size + " 字节"}）`; }
      catch { return n; }
    }).join("\n");
  } catch { return "（读取成果文件夹失败）"; }
}

/** 摘录最近改动的成果文件开头给验收员：光看文件名判「能不能用」纯靠猜，
 *  看到内容开头至少能核对结构是不是真的（有没有画布/按键监听/两个角色…）。只读文本类文件，最多 5 个 */
function goalFileSnippets(sess) {
  try {
    return recentGoalFiles(sess).map((f) => {
      let head = "";
      try { head = fs.readFileSync(f.p, "utf8").slice(0, 600); } catch { head = "（读取失败）"; }
      return `--- ${f.n}（共 ${f.size} 字节，以下是开头）---\n${head}`;
    }).join("\n\n");
  } catch { return ""; }
}

/** 最近改动的成果文本文件（新→旧，最多 5 个），内容摘录和自动体检共用一份清单 */
function recentGoalFiles(sess) {
  try {
    if (!sess.dir) return [];
    const dir = path.join(getWorkspaceDir(), sess.dir);
    const TEXT_EXT = /\.(html?|js|mjs|css|md|txt|json|py|ts|jsx|tsx|csv|svg)$/i;
    return fs.readdirSync(dir)
      .filter((n) => !n.startsWith(".") && TEXT_EXT.test(n))
      .map((n) => {
        try { const st = fs.statSync(path.join(dir, n)); return st.isFile() ? { n, p: path.join(dir, n), mtime: st.mtimeMs, size: st.size } : null; }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 5);
  } catch { return []; }
}

/** 验收员的「动手」环节：对成果文件做机器实测——JS 语法（node --check）、JSON 能否解析、
 *  HTML 是否写完整（截断/标签不配对）。只做只读检查，绝不执行成果代码。
 *  桌面版里 process.execPath 是 Electron 二进制，必须 ELECTRON_RUN_AS_NODE 才是纯 node */
function goalFileChecks(sess) {
  const { execFile } = require("child_process");
  const checkOne = (f) => new Promise((resolve) => {
    if (/\.(js|mjs|cjs)$/i.test(f.n)) {
      execFile(process.execPath, ["--check", f.p], { timeout: 8000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }, (err, _o, stderr) => {
        resolve(err ? `✗ ${f.n} JS 语法检查未通过：${String(stderr || err.message).slice(0, 200)}` : `✓ ${f.n} JS 语法检查通过`);
      });
    } else if (/\.json$/i.test(f.n)) {
      try { JSON.parse(fs.readFileSync(f.p, "utf8")); resolve(`✓ ${f.n} JSON 格式合法`); }
      catch (e) { resolve(`✗ ${f.n} JSON 解析失败：${String(e.message).slice(0, 120)}`); }
    } else if (/\.html?$/i.test(f.n)) {
      try {
        const t = fs.readFileSync(f.p, "utf8");
        const probs = [];
        if (/<html[\s>]/i.test(t) && !/<\/html>/i.test(t)) probs.push("有 <html> 没有 </html>，疑似写到一半被截断");
        const so = (t.match(/<script[\s>]/gi) || []).length, sc = (t.match(/<\/script>/gi) || []).length;
        if (so !== sc) probs.push(`<script> 开闭不配对（${so} 开 ${sc} 闭）`);
        resolve(probs.length ? `✗ ${f.n} 结构异常：${probs.join("；")}` : `✓ ${f.n} HTML 结构完整（html/script 标签配对）`);
      } catch { resolve(null); }
    } else resolve(null);
  });
  return Promise.all(recentGoalFiles(sess).map(checkOne)).then((rs) => rs.filter(Boolean).join("\n")).catch(() => "");
}

function parseJsonLoose(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/**
 * 把一次调用（或 agent 返回的一整轮）的用量并进本次任务的总账。
 *
 * 以前这件事在五个地方各手写一遍 `total.prompt += …; total.completion += …`，于是
 * llm.js 好不容易统一读出来的 cached 在这一层被五处同时丢掉——账本记的 cached 恒为 0，
 * 「有没有在反复全价重买同一段上下文」这个问题看不见，扣积分也没法给缓存打折。
 * 收成一个函数，以后 usage 再多一个字段只改这一处，不会有第六处漏掉。
 *
 * calls：llm.chat() 一次就是一次；agent 返回的 usage 自带 calls（里面是好多次），直接取用。
 */
function addUsage(total, u) {
  if (!u) return;
  total.prompt += u.prompt || 0;
  total.completion += u.completion || 0;
  total.cached = (total.cached || 0) + (u.cached || 0);
  total.calls += u.calls != null ? u.calls : 1;
  total.elapsed_ms = (total.elapsed_ms || 0) + (u.elapsed_ms || 0);
}

/** 把目标拆成 3~6 条可验收标准。失败就用目标原文当唯一标准，绝不让任务卡在拆解上 */
async function deriveGoalCriteria(sessLLM, goalText, total) {
  try {
    const r = await sessLLM.chat({
      system: '你是验收标准拆解器。把用户的目标拆成 3~6 条具体、可客观核验的验收标准（每条都能对着成果文件/事实判真假，不写"尽量""良好"这种没法验收的词）。只输出 JSON：{"criteria":["标准1","标准2"]}，不要其它任何文字。',
      history: [{ role: "user", content: String(goalText).slice(0, 2000) }],
      tools: [],
      signal: AbortSignal.timeout(30000),
    });
    addUsage(total, r.usage);
    const j = parseJsonLoose(r.text);
    const list = (j && Array.isArray(j.criteria) ? j.criteria : []).map((c) => String(c).trim()).filter(Boolean).slice(0, 6);
    if (list.length) return list;
  } catch {}
  return [String(goalText).slice(0, 200)];
}

/** 对着验收标准验一轮。只认成果文件清单和收尾汇报，拿不准算 false；验收调用挂了就全部保持原状 */
async function verifyGoal(sess, sessLLM, finalText, total) {
  const goal = sess.goal;
  const undone = goal.criteria.map((c, i) => ({ i, c })).filter((x) => !x.c.done);
  if (!undone.length) return;
  const snippets = goalFileSnippets(sess);
  const checks = await goalFileChecks(sess);
  try {
    const r = await sessLLM.chat({
      system: '你是验收员。根据成果文件清单和执行汇报，逐条判断验收标准是否已达成。证据不足一律 false，宁可漏判不可错判。【自动体检】是机器实测结果（不是模型自述）：标 ✗ 的文件说明有语法错误或没写完整，涉及它的标准一律 false。只输出 JSON：{"results":[{"i":0,"done":true},{"i":1,"done":false}]}，i 是标准编号。',
      history: [{ role: "user", content:
        `【目标】${goal.text}\n\n【待验收标准】\n${undone.map((x) => `${x.i}. ${x.c.text}`).join("\n")}\n\n【成果文件清单】\n${goalFileInventory(sess)}\n\n` +
        (snippets ? `【成果文件内容摘录】\n${snippets}\n\n` : "") +
        (checks ? `【自动体检（机器实测）】\n${checks}\n\n` : "") +
        `【执行汇报】\n${String(finalText || "（无）").slice(0, 3000)}` }],
      tools: [],
      signal: AbortSignal.timeout(45000),
    });
    addUsage(total, r.usage);
    const j = parseJsonLoose(r.text);
    for (const it of (j && Array.isArray(j.results) ? j.results : [])) {
      const c = goal.criteria[it.i];
      if (c && it.done === true) c.done = true;
    }
  } catch {}
  if (goal.criteria.every((c) => c.done)) goal.status = "done";
}

/**
 * 把任务事件翻译成桌面宠物的表情。只认深度 0 的事件——专家子代理的动静太密，
 * 宠物跟着抽风反而看不出主线在干什么。纯 node 模式下 global.__wbPet 不存在，整个是空操作。
 */
function petSay(ev) {
  const P = global.__wbPet;
  if (!P) return;
  try {
    switch (ev.type) {
      case "ask_user": P.alertAsk(ev.question); break;             // 跳 + 通知 + Dock 弹，最高一档
      case "ask_answer": P.clearAsk(true); break;
      case "tool_use": P.setState("working", "正在用 " + (ev.name || "工具")); break;
      case "expert_start": P.setState("working", `${ev.expert || "专家"} 接手了：${String(ev.task || "").slice(0, 40)}`); break;
      case "sleep": P.setState("sleep", ev.note); break;
      case "failover": P.setState("working", ev.note); break;
      case "limit": P.setState("error", ev.note); break;
      case "error": P.setState("error", String(ev.message || "任务出错了").slice(0, 80)); break;
      default: break;
    }
  } catch {}
}

function recordingEmit(send, events, sessionId) {
  return (ev) => {
    send(ev);
    if (!(ev.depth > 0)) petSay(ev);
    if (ev.type === "text") {
      if (ev.depth > 0) return;
      const last = events[events.length - 1];
      if (last && last.type === "text") last.delta += ev.delta;
      else events.push({ type: "text", delta: ev.delta });
    } else if (ev.type === "files") {
      // 产出卡片得能活过一次重开：历史回放全靠这条事件重建。以前它不在存盘清单里，
      // 于是任务当场看得见成果卡，退出再进来那片卡就凭空消失了。
      // 但整份清单最多 500 条、每批工具跑完就来一次，原样存会把会话文件撑爆——
      // 只留这一批真正变更的那几条（回放时 renderFiles 被 isReplaying 挡住，用不到全量）
      const chg = ev.changed || [];
      if (chg.length) events.push({ type: "files", changed: chg, files: (ev.files || []).filter((f) => chg.includes(f.name)) });
    } else if (["tool_use", "tool_result", "parallel", "expert_start", "expert_done", "error", "limit", "auto_continue", "failover", "sleep", "trim", "compact", "usage", "interject", "credits", "sources", "citations", "ask_user", "ask_answer", "milestones"].includes(ev.type)) {
      events.push(ev);
      // 一步走完就是个存盘点：跑了半小时的任务不该因为一次崩溃从头再来
      if (sessionId && ev.type === "tool_result") autosaveSession(sessionId);
    }
  };
}

const app = express();
// 平台代理必须挂在 express.json() 之前：转发时请求体得是没被消费过的原始流。
// 上传到平台的多是 multipart（文档比对的两份文件、会议录音），一旦被 json 解析器
// 读过一遍，body 再转发过去就是空的或损坏的。
proxy.mount(app);
app.use(express.json({ limit: "60mb" }));
// 前端产物：Vue 工程（ui/）构建到 public/dist。没构建过时回退到仓库自带的 public/，
// 免得 clone 下来没跑 build 就打不开页面。
const DIST_DIR = appPath("public", "dist");
// 静态资源缓存策略（关键）：
// - index.html 必须 no-cache——它引用的 assets/*.js 每次构建 hash 都变，
//   缓存了旧 html 就会去加载已删除的旧 chunk（404），页面直接白屏打不开。
// - 带 hash 的 assets 文件内容不变，可以放心长缓存。
const staticOpts = {
  extensions: ["html"],
  setHeaders(res, filePath) {
    if (String(filePath).endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
  },
};
app.use(express.static(fs.existsSync(DIST_DIR) ? DIST_DIR : appPath("public"), staticOpts));
// 产品落地页：独立 Portal 目录，访问 /portal（与主应用完全隔离）
const PORTAL_DIR = appPath("Portal");
if (fs.existsSync(PORTAL_DIR)) {
  app.use("/portal", express.static(PORTAL_DIR, { ...staticOpts, extensions: ["html"] }));
  console.log("[启动] 落地页: http://localhost:" + (config.server?.port || 3800) + "/portal");
}
// 前端统一用 /engine-api 前缀访问本地引擎：开发态由 Vite 代理剥掉前缀，
// 装机态（Express 托管构建产物）在这里剥。前端代码因此不用区分两种环境。
// 必须早于 authGuard——鉴权看的是重写后的 /api/* 路径。
// ⚠️ 这里必须用全局中间件直接改 req.url，不能写成 app.use("/engine-api", fn)：
// app.use 挂在子路径上时会在离开该 layer 时把 req.url 恢复原样，
// 后续路由拿到的还是 /engine-api/...，于是谁都匹配不上（实测 404）。
app.use((req, _res, next) => {
  if (req.url === "/engine-api" || req.url.startsWith("/engine-api/")) {
    const rest = req.url.slice("/engine-api".length);
    // IM 路由挂在 /im/*（不是 /api/*）：/engine-api/im/... 要原样落到 /im/...，
    // 否则会被重写成 /api/im/... 打成 404（旧前端直接调 /im/*，Vue 前端统一走 /engine-api）
    req.url = rest.startsWith("/im/") ? rest : "/api" + rest;
  }
  next();
});

// /api/auth/* /api/usage /api/credits/*
app.use(
  account.createRouter({
    // 账号改了登录名，历史会话的归属得跟着走，不然那些任务就成了没主的（列表里直接消失）。
    // 内存和磁盘两头都要改：只改盘上的，下一次 saveSession 会拿内存里的旧名字盖回去。
    onRename: (from, to) => {
      for (const s of sessions.values()) if (s && s.user === from) s.user = to;
      let files = 0;
      for (const f of fs.existsSync(SESS_DIR) ? fs.readdirSync(SESS_DIR) : []) {
        if (!f.endsWith(".json")) continue;
        const p = path.join(SESS_DIR, f);
        const s = store.readJson(p, null);
        if (s && s.user === from) {
          s.user = to;
          store.writeJsonAtomic(p, s);
          files++;
        }
      }
      const mems = memory.renameScope(from, to); // 记忆也认登录名，不搬就成了孤儿
      console.log(`[账号] 登录名 ${from} → ${to}，${files} 条会话、${mems} 条记忆的归属已迁移`);
    },
  })
);
/**
 * 用平台身份换取本地会话。
 *
 * 为什么要有这一条：登录走的是云端平台（Java），可本地引擎认的是自己的账本，
 * 两套不通的话，成果文件 / 定时任务 / 记忆这些客户端页面会统统 401——
 * 用户明明登进来了，却什么客户端功能都用不了。
 *
 * 安全闭环：本地不凭空相信「我是谁」，而是拿平台令牌**回平台再验一次**
 * （/auth-api/login/getLoginInfo），确认无误才在本地建/取同名账号。
 * 这个本地账号不设可用密码，只能通过平台身份换出来；平台令牌失效，这里也就换不到了。
 */
app.post("/api/auth/sync-platform", async (req, res) => {
  const platToken = String(req.headers["x-platform-token"] || "").trim();
  if (!platToken) return res.status(400).json({ error: "缺少平台凭证" });
  // 没配平台地址就没法校验身份：直接说清原因，别让 fetch 抛一个相对 URL 的怪错误
  if (!proxy.TARGET) return res.status(503).json({ error: proxy.NOT_CONFIGURED });

  let info;
  try {
    const r = await fetch(`${proxy.TARGET}/auth-api/login/getLoginInfo`, {
      headers: { Authorization: `Bearer ${platToken}` },
    }).then((x) => x.json());
    if (Number(r.code) !== 200 || !r.data) {
      return res.status(401).json({ error: `平台身份校验失败：${r.message || "未知原因"}` });
    }
    info = r.data;
  } catch (e) {
    return res.status(502).json({ error: `连不上平台，无法校验身份：${e.message}` });
  }

  // 用户名要能落进本地账本（与 account.js 的 register 同一套规则）
  const loginName = String(info.loginName || "").trim();
  if (!loginName) return res.status(400).json({ error: "平台未返回登录名" });

  try {
    let user = account._internals.loadUsers().users.find((u) => u.username === loginName);
    if (!user) {
      // 随机密码：这个账号只由平台身份派生，不提供密码登录这条路
      user = account._internals.register(loginName, crypto.randomBytes(24).toString("hex"));
    }
    const token = account._internals.issueToken(user.username);
    // 与 account.js 里 setTokenCookie 的写法保持一致（HttpOnly + SameSite=Lax + 90 天）
    res.setHeader("Set-Cookie", `wb_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${90 * 86400}`);
    res.json({ ok: true, username: user.username });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.use(account.authGuard); // 其余 /api/* 与 /im/*（除外部回调）需要登录

let runtime; // MCP 启动后创建

app.get("/api/info", (_req, res) => {
  res.json({
    provider: llm.provider,
    model: llm.model,
    skills: runtime ? runtime.getSkills().map((s) => s.name) : [],
    experts: experts.map((e) => e.name),
    mcp_tools: mcpManager.toolDefs().length,
    agent_plugins_spec: require("./plugins").SPEC_VERSION,
    // 当前对接的平台环境，前端用它告诉用户「你现在连的是测试还是生产」
    environment: proxy.ENV_NAME,
    platform: proxy.TARGET,
  });
});

app.get("/api/files", (_req, res) => res.json(outputFiles()));

// 助理身份：界面一进来就要拿它画头像，所以单开一个轻接口，不用为了个名字去拉整份设置
app.get("/api/assistant", (_req, res) => res.json(config.assistant));

// ---------- 应用内通知中心 ----------
// 数据源在 notify.js 的同一份流水：引擎侧事件（任务完成/出错、等待审批、定时任务）由
// notify.desktop 顺手记一笔；渲染进程侧的事件（如 ask_user 弹选项卡片）走 POST 补记，
// 这样铃铛面板里不会漏掉任何一类「该让用户知道」的事。
app.get("/api/notifications", (_req, res) => res.json(notify.feedList()));
app.post("/api/notifications/read", (req, res) => {
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids : null; // 不给 ids = 全部已读
  res.json(notify.feedMarkRead(ids));
});
app.post("/api/notifications", (req, res) => {
  const b = req.body || {};
  if (!String(b.title || "").trim()) return res.status(400).json({ error: "缺少 title" });
  notify.pushFeed(b.kind || "info", b.title, b.body || "", { session: b.session, target: b.target });
  res.json(notify.feedList());
});
app.delete("/api/notifications", (_req, res) => res.json(notify.feedClear()));

// ---------- 应用内设置（模型 + IM），保存到 config.json 并热生效 ----------
app.get("/api/settings", (_req, res) => {
  res.json({
    workspace_dir: getWorkspaceDir(),
    models: config.models,
    active_model: config.active_model,
    active_model_id: config.active_model_id || "",
    model_health: healthSummary(),
    model_follow_last: !!config.model_follow_last,
    last_picked_model: config.last_picked_model || "",
    last_picked_model_id: config.last_picked_model_id || "",
    assist_model: config.assist_model || "",
    assist_model_id: config.assist_model_id || "",
    agent: {
      max_steps: config.agent.max_steps,
      tool_timeout_ms: config.agent.tool_timeout_ms,
      max_runtime_ms: config.agent.max_runtime_ms || 1800000,
      auto_continue_rounds: config.agent.auto_continue_rounds || 0,
      llm_timeout_ms: config.agent.llm_timeout_ms || 300000,
      max_context_chars: config.agent.max_context_chars || 120000,
      max_tokens_budget: config.agent.max_tokens_budget || 0,
      failover_model: config.agent.failover_model || "",
      failover_model_id: config.agent.failover_model_id || "",
    },
    pet: {
      enabled: (config.pet || {}).enabled === true, // 默认没有宠物：得用户在对话里开口要，或来这儿手动打开
      character: (config.pet || {}).character || "cat",
      scale: (config.pet || {}).scale || 1,
      opacity: (config.pet || {}).opacity || 1,
      notify: (config.pet || {}).notify !== false,
      has_photo: !!petPhotoPath(),
      available: !!global.__wbPet, // 纯 node 模式没有桌面窗口，前端要如实说明
    },
    persona: config.persona || "",
    assistant: config.assistant,
    search: {
      provider: (config.search || {}).provider || "jina",
      jina_key: (config.search || {}).jina_key || (config.search || {}).api_key || "",
      tavily_key: (config.search || {}).tavily_key || "",
      brave_key: (config.search || {}).brave_key || "",
    },
    // 知识库：embedding / rerank 是对「设置 → 模型」里渠道模型的引用（复合键），加检索调参
    knowledge: { ...(config.knowledge || {}) },
    im: {
      feishu: (config.im || {}).feishu || { app_id: "", app_secret: "", verification_token: "" },
      qq: (config.im || {}).qq || { app_id: "", app_secret: "" },
      wecom_app: (config.im || {}).wecom_app || { corp_id: "", agent_id: "", secret: "", token: "", aes_key: "" },
      wechat_mp: (config.im || {}).wechat_mp || { app_id: "", app_secret: "", token: "", aes_key: "" },
      // iLink 的 bot_token 是扫码换来的长期凭证，不回给前端（前端只需要知道连没连上，状态走 /im/status）
      wechat_ilink: { bot_id: ((config.im || {}).wechat_ilink || {}).ilink_bot_id || "" },
      wecom_bot_webhook: (config.im || {}).wecom_bot_webhook || "",
      dingtalk_webhook: (config.im || {}).dingtalk_webhook || "",
      dingtalk_secret: (config.im || {}).dingtalk_secret || "",
      webhook_secret: (config.im || {}).webhook_secret || "",
      session_idle_hours: +(config.im || {}).session_idle_hours || 0,
    },
    media: {
      image: { base_url: "", api_key: "", model: "", ...((config.media || {}).image || {}) },
      video: { base_url: "", api_key: "", model: "", ...((config.media || {}).video || {}) },
      tts: { base_url: "", api_key: "", model: "", voice: "", ...((config.media || {}).tts || {}) },
      vision: { base_url: "", api_key: "", model: "", ...((config.media || {}).vision || {}) },
    },
    security: config.security,
    notify: { done: true, approval: true, error: true, ...((config.notify || {})) },
    shortcuts: config.shortcuts,
  });
});

app.post("/api/settings", (req, res) => {
  try {
    const b = req.body || {};
    if (Array.isArray(b.models)) {
      for (const m of b.models) {
        // 一个渠道可以挂多个模型：models[] 为主，model 是渠道默认模型（缺省取第一个）
        const ids = Array.isArray(m.models) ? m.models.map((x) => String(x || "").trim()).filter(Boolean) : [];
        const primary = String(m.model || "").trim();
        if (primary && !ids.includes(primary)) ids.unshift(primary);
        m.models = [...new Set(ids)];
        if (!m.name || !m.models.length) throw new Error("每个渠道需要 name 和至少一个模型 id");
        m.model = primary && m.models.includes(primary) ? primary : m.models[0];
        m.provider = m.provider === "anthropic" ? "anthropic" : "openai";
        // 渠道用途：对话 / 向量 / 重排。知识库设置按这个类型筛选可选项
        m.kind = ["embedding", "rerank"].includes(m.kind) ? m.kind : "chat";
      }
      const names = b.models.map((m) => String(m.name).trim());
      if (new Set(names).size !== names.length) throw new Error("渠道名称不能重复");
      config.models = b.models;
    }
    if (b.active_model !== undefined) {
      const ach = modelCfg.findChannel(config, b.active_model);
      if (!ach) throw new Error("active_model 不在模型列表中");
      if (modelCfg.kindOf(ach) !== "chat") throw new Error("向量/重排渠道不能设为对话默认模型");
      config.active_model = b.active_model;
    }
    if (b.active_model_id !== undefined) {
      const ch = modelCfg.findChannel(config, config.active_model);
      const id = String(b.active_model_id || "").trim();
      if (id && ch && !modelCfg.modelIds(ch).includes(id)) throw new Error(`模型「${id}」不在渠道「${config.active_model}」里`);
      config.active_model_id = id || (ch ? modelCfg.pickModelId(ch, "") : "");
    }
    // 渠道列表变了：把 active_model / active_model_id 落回合法值（删掉的是当前渠道时自动改选第一个）
    if (Array.isArray(b.models) || b.active_model !== undefined || b.active_model_id !== undefined) {
      modelCfg.normalizeChannels(config);
    }
    if (typeof b.model_follow_last === "boolean") config.model_follow_last = b.model_follow_last;
    if (b.agent) {
      if (b.agent.max_steps) config.agent.max_steps = Math.max(1, Math.min(100, +b.agent.max_steps));
      if (b.agent.tool_timeout_ms) config.agent.tool_timeout_ms = Math.max(5000, +b.agent.tool_timeout_ms);
      if (b.agent.max_runtime_ms) config.agent.max_runtime_ms = Math.max(60000, +b.agent.max_runtime_ms);
      if (b.agent.auto_continue_rounds !== undefined) config.agent.auto_continue_rounds = Math.max(0, Math.min(20, Math.round(+b.agent.auto_continue_rounds) || 0));
      if (b.agent.llm_timeout_ms) config.agent.llm_timeout_ms = Math.max(30000, +b.agent.llm_timeout_ms);
      // 下限 2 万字符：再小连最近几步的工具原文都留不住，agent 会失忆式反复重做
      if (b.agent.max_context_chars) config.agent.max_context_chars = Math.max(20000, Math.min(2000000, +b.agent.max_context_chars));
      if (b.agent.max_tokens_budget !== undefined) config.agent.max_tokens_budget = Math.max(0, Math.round(+b.agent.max_tokens_budget) || 0);
      if (b.agent.failover_model !== undefined) {
        const fm = String(b.agent.failover_model || "").trim();
        if (fm && !modelCfg.findChannel(config, fm)) throw new Error("备用渠道不在模型列表中");
        config.agent.failover_model = fm; // 空串 = 关闭自动换道（默认）
        if (!fm) config.agent.failover_model_id = "";
      }
      if (b.agent.failover_model_id !== undefined) {
        const fc = modelCfg.findChannel(config, config.agent.failover_model);
        const fid = String(b.agent.failover_model_id || "").trim();
        if (fid && fc && !modelCfg.modelIds(fc).includes(fid)) throw new Error(`备用模型「${fid}」不在渠道「${config.agent.failover_model}」里`);
        config.agent.failover_model_id = fc ? modelCfg.pickModelId(fc, fid) : "";
      }
    }
    if (b.pet) {
      config.pet = config.pet || {};
      if (typeof b.pet.enabled === "boolean") config.pet.enabled = b.pet.enabled;
      if (typeof b.pet.notify === "boolean") config.pet.notify = b.pet.notify;
      if (b.pet.character !== undefined) config.pet.character = b.pet.character === "photo" ? "photo" : "cat";
      if (b.pet.scale !== undefined) config.pet.scale = Math.max(0.6, Math.min(2, Number(b.pet.scale) || 1));
      if (b.pet.opacity !== undefined) config.pet.opacity = Math.max(0.25, Math.min(1, Number(b.pet.opacity) || 1));
      if (global.__wbPet) try { global.__wbPet.applyConfig({ ...config.pet, enabled: config.pet.enabled === true }); } catch {}
    }
    if (b.evolve) {
      config.evolve = config.evolve || {};
      // 默认关：每晚要调一次模型，是花钱的事，得你自己点开
      if (typeof b.evolve.auto === "boolean") config.evolve.auto = b.evolve.auto;
      if (b.evolve.hour !== undefined) config.evolve.hour = Math.max(0, Math.min(23, Math.round(+b.evolve.hour) || 0));
      if (b.evolve.days !== undefined) config.evolve.days = Math.max(1, Math.min(365, Math.round(+b.evolve.days) || 14));
    }
    if (b.persona !== undefined) config.persona = String(b.persona).slice(0, 4000);
    if (b.assistant) {
      if (b.assistant.name !== undefined) {
        const n = String(b.assistant.name).replace(/\s+/g, " ").trim();
        if (n.length > 24) throw new Error("助理名字最多 24 个字");
        config.assistant.name = n || ASSISTANT_DEFAULT.name; // 清空就退回默认，别让它变成没名字的空气
      }
      // 头像的校验规则和用户头像完全一样（emoji 或 ≤256KB 的 data URI），共用一处免得两边规则跑偏
      if (b.assistant.avatar !== undefined) config.assistant.avatar = account._internals.normalizeAvatar(b.assistant.avatar) || ASSISTANT_DEFAULT.avatar;
    }
    if (b.search) {
      config.search = config.search || {};
      if (b.search.provider !== undefined) {
        if (!["jina", "tavily", "brave"].includes(b.search.provider)) throw new Error("搜索 provider 仅支持 jina / tavily / brave");
        config.search.provider = b.search.provider;
      }
      for (const k of ["jina_key", "tavily_key", "brave_key"]) {
        if (b.search[k] !== undefined) config.search[k] = String(b.search[k]).trim();
      }
    }
    // 知识库：embedding / rerank 只是对「设置 → 模型」里渠道模型的引用，校验一下别指向空气
    if (b.knowledge) {
      config.knowledge = config.knowledge || {};
      for (const kind of ["embedding", "rerank"]) {
        if (b.knowledge[kind] !== undefined) {
          const ref = String(b.knowledge[kind] || "").trim();
          if (ref) {
            const { name } = modelCfg.parseSelectionKey(ref);
            const ch = modelCfg.findChannel(config, name);
            if (!ch || modelCfg.kindOf(ch) !== kind) throw new Error(`所选${kind === "embedding" ? "向量" : "重排"}模型不在模型列表里（需在 设置 → 模型 中标记为该类型）`);
          }
          config.knowledge[kind] = ref;
        }
      }
      const num = (v, lo, hi, dflt) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
      };
      if (b.knowledge.chunk_size !== undefined) config.knowledge.chunk_size = num(b.knowledge.chunk_size, 200, 4000, 800);
      if (b.knowledge.chunk_overlap !== undefined) config.knowledge.chunk_overlap = num(b.knowledge.chunk_overlap, 0, 2000, 120);
      if (b.knowledge.top_k !== undefined) config.knowledge.top_k = Math.round(num(b.knowledge.top_k, 1, 50, 6));
      if (b.knowledge.score_threshold !== undefined) config.knowledge.score_threshold = num(b.knowledge.score_threshold, 0, 1, 0);
      if (b.knowledge.inject_chars !== undefined) config.knowledge.inject_chars = Math.round(num(b.knowledge.inject_chars, 1000, 40000, 6000));
    }
    if (b.workspace_dir !== undefined && b.workspace_dir !== getWorkspaceDir()) {
      config.workspace_dir = setWorkspaceDir(b.workspace_dir);
      // 输入框旁的快速切换是临时的（新任务会切回项目目录）；设置中心改路径才算改默认，同步进当前项目
      if (b.workspace_permanent === true) {
        ensureProjects();
        const ap = config.projects.find((p) => p.name === config.active_project);
        if (ap) ap.dir = config.workspace_dir;
      }
    }
    config.im = config.im || {};
    if (b.im) {
      if (b.im.feishu) Object.assign((config.im.feishu = config.im.feishu || {}), pick(b.im.feishu, ["app_id", "app_secret", "verification_token", "doc_app_id", "doc_app_secret"]));
      if (b.im.qq) Object.assign((config.im.qq = config.im.qq || {}), pick(b.im.qq, ["app_id", "app_secret"]));
      if (b.im.wecom_app) Object.assign((config.im.wecom_app = config.im.wecom_app || {}), pick(b.im.wecom_app, ["corp_id", "agent_id", "secret", "token", "aes_key"]));
      if (b.im.wechat_mp) Object.assign((config.im.wechat_mp = config.im.wechat_mp || {}), pick(b.im.wechat_mp, ["app_id", "app_secret", "token", "aes_key"]));
      if (b.im.wecom_bot_webhook !== undefined) config.im.wecom_bot_webhook = b.im.wecom_bot_webhook;
      if (b.im.dingtalk_webhook !== undefined) config.im.dingtalk_webhook = String(b.im.dingtalk_webhook).trim();
      if (b.im.dingtalk_secret !== undefined) config.im.dingtalk_secret = String(b.im.dingtalk_secret).trim();
      if (b.im.webhook_secret !== undefined) config.im.webhook_secret = b.im.webhook_secret;
      if (b.im.session_idle_hours !== undefined) config.im.session_idle_hours = Math.max(0, Math.min(720, +b.im.session_idle_hours || 0));
    }
    if (b.notify) {
      // 桌面通知偏好（设置→通知）。只认布尔值：true/false 才落盘，别的类型直接丢
      config.notify = config.notify || {};
      for (const k of ["done", "approval", "error"]) {
        if (typeof b.notify[k] === "boolean") config.notify[k] = b.notify[k];
      }
    }
    if (b.media) {
      config.media = config.media || {};
      for (const kind of ["image", "video", "tts", "vision"]) {
        if (b.media[kind]) {
          const c = (config.media[kind] = config.media[kind] || {});
          for (const k of ["base_url", "api_key", "model", "voice"]) {
            if (b.media[kind][k] !== undefined) c[k] = String(b.media[kind][k]).trim();
          }
        }
      }
    }
    if (b.security) {
      const sec = security.getSecurity(config);
      for (const k of ["gateway", "delete_protect", "runtime_node", "runtime_python"]) {
        if (typeof b.security[k] === "boolean") sec[k] = b.security[k];
      }
      for (const k of ["batch_delete_threshold", "approval_timeout_s"]) {
        if (b.security[k] !== undefined) sec[k] = Math.max(1, +b.security[k] || security.DEFAULTS[k]);
      }
      for (const k of ["file_whitelist", "file_blacklist", "cmd_allow", "cmd_ask", "url_whitelist", "url_blacklist"]) {
        if (Array.isArray(b.security[k])) sec[k] = b.security[k].map((s) => String(s)).filter((s) => s.trim()).slice(0, 100);
      }
    }
    if (b.shortcuts && typeof b.shortcuts === "object") {
      config.shortcuts = {};
      for (const [k, v] of Object.entries(b.shortcuts)) {
        if (typeof v === "string" && v.length < 60) config.shortcuts[k] = v;
      }
      if (global.__wbRegisterShortcuts) global.__wbRegisterShortcuts(config.shortcuts); // 桌面版重注册全局快捷键
    }
    llmInner = createLLM(config); // 模型热切换
    if (runtime && runtime.resetModelRuntime) runtime.resetModelRuntime(); // pi 侧渠道缓存同步重建（否则改了 key 还在用旧凭证）
    memory.setEmbedder(createEmbedder(config));
    memory.ensureVectors().catch(() => {});
    knowledge.setConfig(config);
    knowledge.setEmbedder(createEmbedder(config));
    saveConfig();
    if (b.im && b.im.feishu && imBridge) {
      imBridge.startFeishuWs(true).catch((e) => console.warn("[飞书] 长连接重启失败:", e.message)); // 飞书配置变更后重建长连接
    }
    if (b.im && b.im.qq && imBridge) {
      imBridge.startQQ(true).catch((e) => console.warn("[QQ] 长连接重启失败:", e.message));
    }
    res.json({ ok: true, provider: llm.provider, model: llm.model, active_model: config.active_model, active_model_id: config.active_model_id || "" });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- 首次开箱引导：没有 API Key 时，什么都干不了，得先把这一步走完 ----------
// 只回布尔值，绝不把 key 原文吐给前端（设置页要改 key 走 /api/settings）
function isLocalModel(m) {
  return /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(m.base_url || "");
}
function hasKey(m) {
  return isLocalModel(m) || !!String(m.api_key || "").trim();
}

/** 发一条最小的真实请求验活。返回 null = 通过，返回字符串 = 人话版失败原因。
 *  刻意不走 createLLM：它会把工具 schema 一起发过去，这里只想知道"这个 key 认不认"。 */
async function probeModel(m) {
  const anthropic = m.provider === "anthropic";
  const base = (m.base_url || (anthropic ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1")).replace(/\/$/, "");
  const url = anthropic ? `${base}/messages` : `${base}/chat/completions`;
  const headers = anthropic
    ? { "Content-Type": "application/json", "x-api-key": m.api_key || "", "anthropic-version": "2023-06-01" }
    : { "Content-Type": "application/json", Authorization: `Bearer ${m.api_key || "ollama"}` };
  const body = anthropic
    ? { model: m.model, max_tokens: 8, messages: [{ role: "user", content: "ping" }] }
    : { model: m.model, max_tokens: 8, stream: false, messages: [{ role: "user", content: "ping" }] };
  try {
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    if (r.ok) return null;
    const txt = (await r.text()).slice(0, 300);
    if (r.status === 401 || r.status === 403) return "这个 Key 上游不认（HTTP " + r.status + "），检查有没有复制全、是不是这家服务商的 Key";
    if (r.status === 402) return "Key 有效但余额不足 / 未开通付费，去服务商控制台充值后再试";
    if (r.status === 404) return `模型名「${m.model}」在这家服务商不存在（HTTP 404），去 设置 → 模型 改成它支持的名字`;
    if (r.status === 429) return "被限流了（429），等一会儿再试，或换个渠道";
    return `上游返回 HTTP ${r.status}：${txt}`;
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/timeout|abort/i.test(msg)) return "连不上（30 秒超时）。国外服务商在国内直连经常打不通，挂代理或换国产渠道";
    return "连不上：" + msg.slice(0, 200);
  }
}

app.get("/api/onboarding", (_req, res) => {
  const models = (config.models || []).map((m) => ({
    name: m.name,
    model: m.model,
    models: modelCfg.modelIds(m),
    base_url: m.base_url || "",
    local: isLocalModel(m),
    has_key: hasKey(m),
  }));
  const active = modelCfg.findChannel(config, config.active_model) || (config.models || [])[0];
  res.json({
    // 当前选中的模型没 key = 一句话都发不出去，必须弹引导
    needs_setup: !active || !hasKey(active),
    active_model: config.active_model,
    active_model_id: config.active_model_id || "",
    workspace_dir: getWorkspaceDir(),
    models,
    any_key: models.some((m) => m.has_key && !m.local),
    search: { provider: (config.search || {}).provider || "jina", has_key: !!searchProviderKey(config.search || {}, (config.search || {}).provider || "jina") },
  });
});

// 填 key → 真发一条最小请求验活 → 通过才落盘。不验就存等于把坑留到用户第一次提问时才炸
app.post("/api/onboarding", async (req, res) => {
  try {
    const b = req.body || {};
    const entry = modelCfg.findChannel(config, b.model);
    if (!entry) throw new Error("没有这个模型：" + b.model);
    // b.model 是渠道名；b.model_id 指定要验的那个模型（同渠道多模型时），缺省用渠道默认
    const probeId = modelCfg.pickModelId(entry, b.model_id);
    const key = String(b.api_key || "").trim();
    if (!key && !isLocalModel(entry)) throw new Error("API Key 不能为空");

    if (b.skip_test !== true) {
      const bad = await probeModel({ ...entry, model: probeId, api_key: key || entry.api_key });
      if (bad) return res.json({ ok: false, error: bad });
    }

    if (key) entry.api_key = key;
    config.active_model = entry.name;
    config.active_model_id = probeId;
    if (b.workspace_dir) {
      config.workspace_dir = setWorkspaceDir(b.workspace_dir);
      ensureProjects();
      const ap = config.projects.find((p) => p.name === config.active_project);
      if (ap) ap.dir = config.workspace_dir;
    }
    llmInner = createLLM(config);
    if (runtime && runtime.resetModelRuntime) runtime.resetModelRuntime(); // 开箱引导刚写入首个渠道，pi 侧缓存同样要重建
    memory.setEmbedder(createEmbedder(config));
    memory.ensureVectors().catch(() => {});
    knowledge.setConfig(config);
    knowledge.setEmbedder(createEmbedder(config));
    saveConfig();
    res.json({ ok: true, active_model: config.active_model, model: llm.model, workspace_dir: getWorkspaceDir() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/**
 * 主动验活当前渠道 —— 对话报错横幅上那个「检测网络」调它。
 * 和开箱引导共用 probeModel（都是"发一条最小请求看上游认不认"），但这里是**只读**的：
 * 不写 config、不重建 LLM、不发工具 schema。用户要的只是分辨"是网断了还是模型坏了"。
 */
app.post("/api/model/probe", async (req, res) => {
  try {
    const b = req.body || {};
    const entry = modelCfg.findChannel(config, b.model || config.active_model);
    if (!entry) return res.json({ ok: false, error: "当前没有可用的模型渠道，请到 设置 → 模型 里配置一个" });
    if (!hasKey(entry)) return res.json({ ok: false, error: "这个渠道还没填 API Key，到 设置 → 模型 补上再试", channel: entry.name });
    const modelId = modelCfg.pickModelId(entry, b.model_id || config.active_model_id);
    const bad = await probeModel({ ...entry, model: modelId, api_key: entry.api_key });
    if (bad) return res.json({ ok: false, error: bad, channel: entry.name, model: modelId });
    res.json({ ok: true, channel: entry.name, model: modelId });
  } catch (e) {
    res.json({ ok: false, error: String((e && e.message) || e) });
  }
});

// ---------- 模型云服务：服务商目录 / Key / 模型清单 ----------
// 这一层只改 config.cloud_providers，改完统一走 applyCloudChange 物化成渠道并热重载。
function applyCloudChange() {
  cloudProviders.materializeChannels(config);
  llmInner = createLLM(config);
  if (runtime && runtime.resetModelRuntime) runtime.resetModelRuntime();
  memory.setEmbedder(createEmbedder(config));
  memory.ensureVectors().catch(() => {});
  knowledge.setConfig(config);
  knowledge.setEmbedder(createEmbedder(config));
  saveConfig();
}

function cloudState() {
  return {
    ok: true,
    sections: cloudProviders.SECTIONS,
    labels: cloudProviders.SECTION_LABELS,
    providers: cloudProviders.listProviders(config),
    // 已启用但没配全、因此不会出现在模型渠道里的服务商——界面据此提示，而不是让人对着空白猜
    skipped: cloudProviders.skippedProviders(config),
    active_model: config.active_model || "",
    active_model_id: config.active_model_id || "",
  };
}

// 路由本体在 engine/api/cloud.js。/api/models/list 和 /api/cloud/* 都在这个 router 里。
app.use(createCloudRouter({ config, cloudProviders, modelCfg, applyCloudChange, cloudState }));

// 直连所配搜索服务商测活（不走 DDG 回退，测的就是这家 key 能不能用）。
// 允许带 provider/key 参数直接测「还没保存」的输入，免得用户填完要先存一次才能测。
app.get("/api/search/test", async (req, res) => {
  try {
    const cfg = config.search || {};
    const provider = String((req.query || {}).provider || cfg.provider || "jina").toLowerCase();
    const fn = SEARCH_PROVIDERS[provider];
    if (!fn) return res.json({ ok: false, error: `未知 provider: ${provider}` });
    const key = String((req.query || {}).key || "").trim() || searchProviderKey(cfg, provider);
    if (!key) return res.json({ ok: false, error: `${provider} 未填 API Key` });
    const items = await fn(key, "OpenAI", 3);
    if (!items.length) return res.json({ ok: false, error: `${provider} 返回 0 条结果` });
    res.json({ ok: true, provider, sample: (items[0].title || items[0].url || "").slice(0, 60) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ---------- 安全中心：审计 / 审批 / 系统授权 ----------
app.get("/api/security/audit", (req, res) => res.json(security.auditList(Math.min(1000, +req.query.limit || 100))));
app.post("/api/security/audit/clear", (_req, res) => {
  security.auditClear();
  res.json({ ok: true });
});
app.get("/api/security/audit/export", (_req, res) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="kylinwork-audit-${new Date().toISOString().slice(0, 10)}.log"`);
  res.send(security.auditExport());
});
app.get("/api/security/approvals", (_req, res) =>
  res.json({ items: security.listApprovals(), mode: security.permissionMode(config.security), session_allow: security.listSessionAllow() })
);
/**
 * 批准/拒绝一条审批。scope：once 只这一次 / session 本次运行期间同类不再问 / always 永久写进放行名单。
 * always 要落盘——「一直允许」点完重启又来问，等于没这个按钮；落盘的规则在安全中心看得见、删得掉。
 */
app.post("/api/security/approvals/:id", (req, res) => {
  const body = req.body || {};
  const scope = ["once", "session", "always"].includes(body.scope) ? body.scope : "once";
  const r = security.resolveApproval(req.params.id, !!body.allow, scope);
  if (r.ok && body.allow && scope === "always" && r.ruleKey) {
    const sec = security.getSecurity(config);
    const list = Array.isArray(sec.cmd_allow) ? sec.cmd_allow : [...(security.DEFAULTS.cmd_allow || [])];
    if (!list.includes(r.ruleKey)) {
      list.push(r.ruleKey);
      sec.cmd_allow = list;
      saveConfig();
    }
  }
  res.json(r);
});
// 权限档位：返回数组（保持 plan→ask→auto→full 的顺序），前端直接 v-for 就是对的顺序。
// 以前返回的是 {plan:{label,desc},…} 对象，前端当数组用 → name 全 undefined，档位根本切不动。
app.get("/api/security/modes", (_req, res) =>
  res.json({
    modes: Object.entries(security.PERMISSION_MODES).map(([name, m]) => ({
      name,
      label: m.label,
      description: m.desc,
    })),
    current: security.permissionMode(config.security),
  })
);
app.post("/api/security/mode", (req, res) => {
  const mode = String((req.body || {}).mode || "");
  if (!security.PERMISSION_MODES[mode]) return res.status(400).json({ error: "未知的权限档位" });
  security.getSecurity(config).permission_mode = mode; // 走 getSecurity 补默认值，别把别的字段挤掉
  saveConfig();
  security.audit("权限档位", `切换到「${security.PERMISSION_MODES[mode].label}」`, "放行");
  res.json({ ok: true, mode });
});
app.post("/api/security/session-allow/clear", (_req, res) => {
  security.clearSessionAllow();
  res.json({ ok: true });
});
app.get("/api/security/system", (_req, res) => {
  res.json({
    platform: process.platform,
    desktop: !!process.versions.electron,
    fulldisk: security.checkFullDisk(),
    accessibility: security.checkAccessibility(),
    automation: "unchecked", // 主动探测会触发系统弹窗，改为用户点「检测/授权」时才查
  });
});
app.post("/api/security/system/check-automation", async (_req, res) => {
  res.json({ automation: await security.checkAutomation() });
});
app.post("/api/security/system/open", (req, res) => {
  res.json({ ok: security.openPrefPane((req.body || {}).pane) });
});
// 桌面版窗口全屏切换（Web 版由前端 requestFullscreen 兜底）
app.post("/api/app/fullscreen", (_req, res) => {
  if (global.__wbWin) {
    try {
      global.__wbWin.setFullScreen(!global.__wbWin.isFullScreen());
      return res.json({ ok: true });
    } catch {}
  }
  res.json({ ok: false });
});

// 检查更新：项目是 git 仓库且配了远程时真实比对，否则如实说明（不装样子）
app.post("/api/app/update-check", (_req, res) => {
  const version = (() => { try { return require("../package.json").version; } catch { return "?"; } })();
  const { spawnSync } = require("child_process");
  const git = (...args) => spawnSync("git", args, { cwd: path.resolve(__dirname, ".."), encoding: "utf8", timeout: 30000 });
  if (git("rev-parse", "--is-inside-work-tree").status !== 0) {
    return res.json({ ok: false, version, reason: "本地部署版未配置更新源（项目还不是 git 仓库）" });
  }
  if (!String(git("remote").stdout || "").trim()) {
    return res.json({ ok: false, version, reason: "未配置远程仓库（git remote），无法在线检查更新" });
  }
  const f = git("fetch", "--quiet");
  if (f.status !== 0) return res.json({ ok: false, version, reason: "拉取远程失败：" + String(f.stderr || "").trim().slice(0, 120) });
  const behind = git("rev-list", "--count", "HEAD..@{upstream}");
  if (behind.status !== 0) return res.json({ ok: false, version, reason: "当前分支未设置上游分支（git branch -u）" });
  res.json({ ok: true, version, behind: parseInt(behind.stdout, 10) || 0 });
});

// ---------- MCP 连接器管理 ----------
app.get("/api/mcp", (_req, res) => {
  const view = (s, plugin) => {
    const client = mcpManager.clients.get(s.name);
    const failure = mcpManager.failures.find((f) => f.name === s.name);
    return {
      name: s.name,
      command: s.command || "",
      args: s.args || [],
      env: s.env || {},
      url: s.url || "",
      // 请求头里常有 token，界面上只说有几个，不回传值
      header_keys: Object.keys(s.headers || {}),
      transport: s.transport || (s.command ? "stdio" : "streamable-http"),
      plugin, // 插件带来的：界面上只读，不许当成 config 里的条目存回去
      error: failure ? failure.error : "",
      connected: !!client,
      tools: client ? client.tools.map((t) => ({ name: t.name, description: (t.description || "").slice(0, 200) })) : [],
    };
  };
  // config.json 里配的 + 插件 mcp.json 里声明的，一起列出来，
  // 否则「已注入 N 个工具」的 N 里有一半找不到对应的卡片，用户以为是幻觉。
  let fromPlugins = [];
  try { fromPlugins = pluginsMgr.pluginMcpServers(); } catch { /* 插件坏了不该让连接器页打不开 */ }
  const servers = (config.mcp_servers || []).map((s) => view(s, ""))
    .concat(fromPlugins.map((s) => view(s, s.plugin)));
  res.json({ servers, total_tools: mcpManager.toolDefs().length });
});

/** 一条连接器配置规整成后端认的形状；stdio 看 command，远程看 url */
function normalizeMcpServer(s, i, prevByName = new Map()) {
  const at = `第 ${i + 1} 个连接器`;
  const name = String(s.name || "").trim();
  if (!name) throw new Error(`${at}缺少 name`);
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`${at}的 name「${name}」只能用字母、数字、- 和 _（工具名要按 mcp__服务器__工具 拼）`);
  const url = String(s.url || "").trim();
  const command = String(s.command || "").trim();
  if (!command && !url) throw new Error(`${at}要么填 command（本地进程），要么填 url（远程 Streamable HTTP）`);
  if (url) {
    let u;
    try { u = new URL(url); } catch { throw new Error(`${at}的 url 不是合法地址：${url}`); }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`${at}的 url 只支持 http/https`);
    // 请求头里多半是 Authorization，GET 只回 header_keys 不回值；
    // 前端原样存回来时没带 headers，就沿用原来那份，别把令牌洗没了。
    const prev = prevByName.get(name);
    const headers = s.headers && typeof s.headers === "object"
      ? Object.fromEntries(Object.entries(s.headers).map(([k, v]) => [String(k), String(v)]))
      : (prev && prev.headers) || {};
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1";
    if (Object.keys(headers).length && u.protocol === "http:" && !local) {
      throw new Error(`${at}带了请求头（多半是令牌）却走明文 http，令牌会在路上被看光——请改成 https`);
    }
    return { name, transport: "streamable-http", url, headers };
  }
  return {
    name,
    transport: "stdio",
    command,
    args: Array.isArray(s.args) ? s.args.map(String) : [],
    env: s.env && typeof s.env === "object" ? Object.fromEntries(Object.entries(s.env).map(([k, v]) => [String(k), String(v)])) : {},
  };
}

app.post("/api/mcp", async (req, res) => {
  try {
    const list = (req.body || {}).servers;
    if (!Array.isArray(list)) throw new Error("需要 servers 数组");
    const prevByName = new Map((config.mcp_servers || []).map((s) => [s.name, s]));
    const next = list.map((s, i) => normalizeMcpServer(s, i, prevByName));
    const dup = next.map((s) => s.name).find((n, i, a) => a.indexOf(n) !== i);
    if (dup) throw new Error(`连接器名字重复：${dup}`);

    config.mcp_servers = next;
    saveConfig();

    // 插件带来的服务器也要一起重启：只重启 config 里的会把插件连接器整批打没，
    // 而它们不在 config 里，重启前根本救不回来（旧版就是这个 bug）。
    let fromPlugins = [];
    try { fromPlugins = pluginsMgr.pluginMcpServers(); } catch { /* 插件坏了不该拖累连接器保存 */ }
    const servers = [...config.mcp_servers, ...fromPlugins];
    mcpManager.stop([...mcpManager.clients.keys(), ...mcpManager.failures.map((f) => f.name), ...servers.map((s) => s.name)]);
    await mcpManager.startAll(servers); // 失败的单独在日志告警，不阻塞其他
    res.json({
      ok: true,
      total_tools: mcpManager.toolDefs().length,
      connected: [...mcpManager.clients.keys()],
      failures: mcpManager.failures,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- 项目（多工作空间，仿官方「项目」：每个项目一个独立工作目录，成果互不混淆） ----------
/**
 * 项目自带的「指令」和挂载的专家/技能/连接器。
 * 指令不是装饰：切到这个项目之后，它会进系统提示词（见 accountedRuntime），
 * 否则用户在弹窗里写一大段项目背景，agent 一个字都看不见。
 */
function projectMeta(body) {
  const arr = (v) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean).slice(0, 30) : []);
  return {
    instructions: String(body.instructions || "").slice(0, 4000),
    connectors: arr(body.connectors),
    experts: arr(body.experts),
    skills: arr(body.skills),
  };
}
function activeProject() {
  ensureProjects();
  return config.projects.find((p) => p.name === config.active_project) || null;
}

/**
 * 组装进系统提示词的项目上下文：指令 + 挂载清单。
 * 挂载在弹窗里勾了才有；勾过但后来被删掉的专家/技能/连接器要过滤掉，不然提示词里指着空气让 agent 用。
 */
function projectContextOf(p) {
  if (!p) return "";
  const parts = [];
  if (p.instructions) parts.push(p.instructions);
  const alive = (names, pool) => (names || []).filter((n) => pool.includes(n));
  const exps = alive(p.experts, experts.map((e) => e.name));
  if (exps.length) parts.push(`本项目挂载的专家：${exps.join("、")}。相应领域的子任务优先 delegate_to_expert 委派给他们。`);
  let skillNames = [];
  try { skillNames = skillsMgr.loadSkills().map((s) => s.name); } catch {}
  const sks = alive(p.skills, skillNames);
  if (sks.length) parts.push(`本项目挂载的技能：${sks.join("、")}。做对应任务前先 use_skill 加载，按技能里的规范执行。`);
  const conns = alive(p.connectors, (config.mcp_servers || []).map((s) => s.name));
  if (conns.length) parts.push(`本项目挂载的连接器：${conns.join("、")}。涉及外部系统时优先用这些连接器提供的工具。`);
  // 项目目录里的 AGENTS.md / CLAUDE.md 是写给 agent 看的项目规范（业界通行惯例），
  // 用户既然放了就自动带上，不用再往项目指令里手抄一遍
  try {
    for (const fname of ["AGENTS.md", "CLAUDE.md"]) {
      if (!p.dir) break;
      const fp = path.join(p.dir, fname);
      if (!fs.existsSync(fp)) continue;
      const txt = fs.readFileSync(fp, "utf8").trim().slice(0, 6000);
      if (txt) parts.push(`项目目录里的 ${fname}（项目既定规范，必须遵守）：\n${txt}`);
      break;
    }
  } catch {}
  return parts.join("\n\n");
}

function ensureProjects() {
  if (!Array.isArray(config.projects)) config.projects = [{ name: "默认项目", dir: getWorkspaceDir() }];
  // 允许空列表：用户删光了工作空间就回到「未选择」，等他再选本地文件夹
  if (!config.projects.some((p) => p.name === config.active_project)) {
    config.active_project = config.projects[0] ? config.projects[0].name : "";
  }
}
/**
 * config.json 是唯一一份存着所有 API Key 的文件，还不入 git——写坏了就是全丢。
 * 所以全应用只留这一个写入口，走原子改名 + .bak。
 */
function saveConfig() {
  store.writeJsonAtomic(CONFIG_PATH, config, { pretty: true });
}

app.get("/api/projects", (_req, res) => {
  ensureProjects();
  // 清洗：没有目录的不算工作空间；没名字的用目录名补；同一目录只留一条。清完写回。
  const seen = new Set();
  config.projects = (config.projects || []).filter((p) => {
    if (!p || !String(p.dir || "").trim()) return false;
    const d = path.resolve(String(p.dir));
    if (seen.has(d)) return false;
    seen.add(d);
    p.dir = d;
    if (!String(p.name || "").trim()) p.name = path.basename(d) || "workspace";
    return true;
  });
  if (!config.projects.some((p) => p.name === config.active_project)) {
    config.active_project = config.projects[0] ? config.projects[0].name : "";
  }
  saveConfig();
  res.json({ projects: config.projects, active: config.active_project });
});

app.post("/api/projects", (req, res) => {
  try {
    ensureProjects();
    let dir = String((req.body || {}).dir || "").trim();
    // 名字没起就用目录名：工作空间的名字一律跟着目录走
    let name = String((req.body || {}).name || "").trim();
    if (!name && dir) name = path.basename(dir);
    if (!name) throw new Error("缺少工作空间名（或先选择一个目录）");
    if (name.length > 30) throw new Error("项目名太长（最多 30 字）");
    if (config.projects.some((p) => p.name === name)) throw new Error("同名项目已存在");
    if (!dir) dir = dataPath("projects", name.replace(/[/\\:*?"<>|]/g, "_"));
    const real = setWorkspaceDir(dir); // 建目录并切换过去
    config.projects.push({ name, dir: real, ...projectMeta(req.body || {}), created_at: new Date().toISOString() });
    config.active_project = name;
    config.workspace_dir = real;
    saveConfig();
    res.json({ ok: true, projects: config.projects, active: name });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/projects/switch", (req, res) => {
  try {
    ensureProjects();
    const p = config.projects.find((x) => x.name === (req.body || {}).name);
    if (!p) return res.status(404).json({ error: "项目不存在" });
    config.workspace_dir = setWorkspaceDir(p.dir);
    config.active_project = p.name;
    saveConfig();
    res.json({ ok: true, active: p.name, dir: p.dir });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 新任务回到当前项目自己的目录：输入框里临时切过的文件夹不带进下一个任务
app.post("/api/workspace/reset", (_req, res) => {
  try {
    // 工作目录是全局的：有任务在跑时重置会把它的写入目录半路拽走，产出散落两处。跳过，等空闲再说
    if (activeRuns.size) return res.json({ ok: false, busy: true, workspace_dir: getWorkspaceDir() });
    ensureProjects();
    const ap = config.projects.find((p) => p.name === config.active_project) || config.projects[0];
    if (ap && ap.dir && ap.dir !== getWorkspaceDir()) {
      config.workspace_dir = setWorkspaceDir(ap.dir);
      saveConfig();
    }
    res.json({ ok: true, workspace_dir: getWorkspaceDir() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 改项目：名字之外的东西（指令、挂载的专家/技能/连接器）都能改，改完立即对新任务生效
app.patch("/api/projects/:name", (req, res) => {
  ensureProjects();
  const p = config.projects.find((x) => x.name === req.params.name);
  if (!p) return res.status(404).json({ error: "项目不存在" });
  Object.assign(p, projectMeta({ ...p, ...(req.body || {}) }));
  const rename = String((req.body || {}).name || "").trim();
  if (rename && rename !== p.name) {
    if (config.projects.some((x) => x.name === rename)) return res.status(400).json({ error: "同名项目已存在" });
    if (config.active_project === p.name) config.active_project = rename;
    p.name = rename;
  }
  saveConfig();
  res.json({ ok: true, project: p, projects: config.projects, active: config.active_project });
});

// 删除项目：默认只从列表移除；?purge=1 连本地文件夹一起删（前端会让用户二次确认）
app.delete("/api/projects/:name", (req, res) => {
  ensureProjects();
  const i = config.projects.findIndex((p) => p.name === req.params.name);
  if (i < 0) return res.status(404).json({ error: "项目不存在" });
  const removed = config.projects[i];
  config.projects.splice(i, 1);
  if (config.active_project === req.params.name) {
    const p0 = config.projects[0];
    if (p0) {
      config.active_project = p0.name;
      try {
        config.workspace_dir = setWorkspaceDir(p0.dir);
      } catch {}
    } else {
      // 删空了：回到默认工作空间，等用户再选本地文件夹
      config.active_project = "";
    }
  }
  let purged = false;
  if (String(req.query.purge || "") === "1") {
    const dir = path.resolve(String(removed.dir || ""));
    const home = path.resolve(os.homedir());
    const root = path.parse(dir).root;
    // 安全阀：主目录、盘根、空路径绝不删
    if (!dir || dir === root || dir === home) {
      return res.status(400).json({ error: "该目录不允许删除（系统目录保护）" });
    }
    if (activeRuns.size) return res.status(400).json({ error: "有任务正在运行，等它跑完再删目录" });
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      purged = true;
    } catch (e) {
      return res.status(400).json({ error: "删除目录失败：" + e.message + "（列表已移除，可手动清理）" });
    }
  }
  saveConfig();
  res.json({ ok: true, purged, projects: config.projects, active: config.active_project });
});

// ---------- 资料库·灵感（跨项目共享：参考文件 + 灵感笔记，agent 可用 library_* 工具读取） ----------
const LIB_DIR = dataPath("data", "library");
const NOTES_FILE = dataPath("data", "inspirations.json");
function readNotes() {
  const list = store.readJson(NOTES_FILE, []);
  return Array.isArray(list) ? list : [];
}
function writeNotes(notes) {
  store.writeJsonAtomic(NOTES_FILE, notes, { pretty: true });
}
function libSafe(name) {
  const base = path.basename(String(name || ""));
  if (!base || base.startsWith(".")) throw new Error("文件名不合法");
  return path.join(LIB_DIR, base);
}

app.get("/api/library", (_req, res) => {
  let files = [];
  try {
    files = fs
      .readdirSync(LIB_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith("."))
      .map((e) => {
        const st = fs.statSync(path.join(LIB_DIR, e.name));
        return { name: e.name, size: st.size, mtime: st.mtime.toISOString() };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
  } catch {}
  res.json({ files, notes: readNotes() });
});

app.post("/api/library/upload", rawUpload("200mb"), (req, res) => {
  try {
    if (Buffer.isBuffer(req.body)) {
      const name = uploadName(req);
      if (!name) return res.status(400).json({ error: "缺少文件名" });
      if (!req.body.length) return res.status(400).json({ error: "文件是空的" });
      fs.mkdirSync(LIB_DIR, { recursive: true });
      fs.writeFileSync(libSafe(name), req.body);
      return res.json({ ok: true, name: path.basename(name), size: req.body.length });
    }
    const { name, data_b64 } = req.body || {};
    if (!name || !data_b64) return res.status(400).json({ error: "缺少 name 或 data_b64" });
    fs.mkdirSync(LIB_DIR, { recursive: true });
    fs.writeFileSync(libSafe(name), Buffer.from(data_b64, "base64"));
    res.json({ ok: true, name: path.basename(name) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/library/file/:name", (req, res) => {
  try {
    const p = libSafe(req.params.name);
    if (!fs.existsSync(p)) return res.status(404).send("文件不存在");
    res.download(p);
  } catch (e) {
    res.status(400).send(e.message);
  }
});

app.delete("/api/library/file/:name", (req, res) => {
  try {
    fs.rmSync(libSafe(req.params.name), { force: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/library/note", (req, res) => {
  const text = String((req.body || {}).text || "").trim();
  if (!text) return res.status(400).json({ error: "内容为空" });
  const notes = readNotes();
  notes.unshift({ id: "n_" + Date.now() + "_" + Math.floor(Math.random() * 1e4), text: text.slice(0, 2000), at: new Date().toISOString() });
  writeNotes(notes.slice(0, 200));
  res.json({ ok: true });
});

app.delete("/api/library/note/:id", (req, res) => {
  writeNotes(readNotes().filter((n) => n.id !== req.params.id));
  res.json({ ok: true });
});

// ---------- 知识库（多库 RAG） ----------
// 路由本体已挪到 engine/api/knowledge.js（这组接口只依赖 knowledge 模块，留在主文件里
// 只是让 god-file 更肿）。挂在登录中间件之后，鉴权口径不变。
app.use(createKnowledgeRouter({ knowledge, rawUpload, uploadName }));

// ---------- 长期记忆 ----------
// 手写区（memory.md，全局共享）+ 条目区（agent 用 remember 自己记的，按账号隔离）。
// 路由本体（含记忆搬家/导入导出）已挪到 engine/api/memory.js。
app.use(createMemoryRouter());

// ---------- 自进化：反馈 → 信号 → 提案 → 人审 → 复盘 ----------
// 路由本体在 engine/api/evolve.js。llm 传的是那个可热替换的包装（getter 直通当前实例）。
app.use(createEvolveRouter({ evolve, config, llm }));

// ---------- 工作空间：原生文件夹选择（桌面版）与打开文件夹 ----------
app.post("/api/pick-folder", async (_req, res) => {
  try {
    const { dialog } = require("electron");
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "选择工作空间文件夹" });
    if (result.canceled || !result.filePaths.length) return res.json({ canceled: true });
    // dir / path 双字段：前端两处调用各取所需，别再拿错字段
    res.json({ path: result.filePaths[0], dir: result.filePaths[0] });
  } catch {
    res.status(501).json({ error: "仅桌面版支持系统文件夹选择，Web 版请直接输入路径" });
  }
});
/** 用系统程序打开文件/文件夹（跨平台：macOS open / Windows explorer / Linux xdg-open） */
function openWithSystem(target) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  require("child_process").exec(`${opener} "${target}"`);
}
app.post("/api/open-workspace", (_req, res) => {
  openWithSystem(getWorkspaceDir());
  res.json({ ok: true });
});

// ================= 飞书：扫码授权（借本机 lark-cli 的设备码流程，larksuite/cli，MIT） =================
// 说明一句免得误解：机器人「收消息」必须有应用的 app_id + app_secret，这是飞书的设计，扫码替代不了。
// 扫码解决的是另一半——把「你本人」的身份授权出来，之后读日历/文档/邮件是以你的身份调的。
const LARK_TMP = path.join(require("os").tmpdir(), "kylinwork-lark");
function larkRun(args, { timeout = 60000, cwd } = {}) {
  return new Promise((resolve) => {
    const child = require("child_process").execFile(
      "lark-cli", args,
      { timeout, cwd: cwd || LARK_TMP, env: { ...process.env, PATH: shellPath() }, maxBuffer: 4 << 20 },
      (err, stdout, stderr) => resolve({ ok: !err, code: err ? err.code : 0, stdout: stdout || "", stderr: stderr || "" }),
    );
    child.on("error", () => {});
  });
}
function larkJson(s) { try { return JSON.parse(String(s).trim()); } catch { return null; } }

app.get("/api/feishu/lark-cli", async (_req, res) => {
  fs.mkdirSync(LARK_TMP, { recursive: true });
  const v = await larkRun(["--version"], { timeout: 15000 });
  if (!v.ok) return res.json({ installed: false, install_cmd: "npx @larksuite/cli@latest install" });
  const version = (v.stdout.match(/[\d.]+/) || [""])[0];
  const cfg = larkJson((await larkRun(["config", "show"], { timeout: 15000 })).stdout.split("\n\nConfig file path")[0]);
  // 只回布尔和非敏感字段，app_secret 一个字节都不出后端
  res.json({
    installed: true, version,
    configured: !!(cfg && cfg.appId),
    app_id: (cfg && cfg.appId) || "",
    brand: (cfg && cfg.brand) || "",
    has_secret: !!(cfg && cfg.appSecret),
    users: (cfg && cfg.users) || "",
  });
});

// 把 lark-cli 里已经配好的应用凭证搬进 KylinWork 的飞书通道，省掉手动复制两串东西
app.post("/api/feishu/lark-cli/import", async (_req, res) => {
  fs.mkdirSync(LARK_TMP, { recursive: true });
  const r = await larkRun(["config", "show"], { timeout: 15000 });
  const cfg = larkJson(r.stdout.split("\n\nConfig file path")[0]);
  if (!cfg || !cfg.appId || !cfg.appSecret) {
    return res.status(400).json({ error: "lark-cli 还没配置应用凭证，先跑 lark-cli config init" });
  }
  config.im = config.im || {};
  config.im.feishu = Object.assign(config.im.feishu || {}, { app_id: cfg.appId, app_secret: cfg.appSecret });
  saveConfig();
  if (imBridge) imBridge.startFeishuWs(true).catch((e) => console.warn("[飞书] 长连接重启失败:", e.message));
  res.json({ ok: true, app_id: cfg.appId }); // secret 不回前端
});

// 反向：把 KylinWork 里填好的凭证写进 lark-cli，这样才能开始扫码（设备码流程需要一个已绑定的应用）
app.post("/api/feishu/lark-cli/bind", (_req, res) => {
  const f = (config.im || {}).feishu || {};
  if (!f.app_id || !f.app_secret) return res.status(400).json({ error: "先在上面填好 App ID / App Secret 并保存" });
  fs.mkdirSync(LARK_TMP, { recursive: true });
  // secret 走 stdin，不进进程参数表（ps 能看到 argv）
  const child = require("child_process").execFile(
    "lark-cli", ["config", "init", "--app-id", f.app_id, "--app-secret-stdin", "--brand", "feishu", "--lang", "zh"],
    { timeout: 60000, cwd: LARK_TMP, env: { ...process.env, PATH: shellPath() } },
    (err, stdout, stderr) => {
      if (res.headersSent) return;
      if (err) return res.status(400).json({ error: ((stderr || stdout || err.message) + "").slice(0, 300) });
      res.json({ ok: true });
    },
  );
  child.on("error", (e) => { if (!res.headersSent) res.status(400).json({ error: "lark-cli 没装或调不起来：" + e.message }); });
  try { child.stdin.end(f.app_secret + "\n"); } catch {}
});

// 设备码流程：start 拿二维码 → 用户在飞书里扫 → 后台那条 --device-code 自己会跑完 → status 变 ok
let larkQr = null; // { device_code, url, expires_at, state, error, child }
app.post("/api/feishu/qr/start", async (req, res) => {
  fs.mkdirSync(LARK_TMP, { recursive: true });
  if (larkQr && larkQr.child) { try { larkQr.child.kill(); } catch {} }
  const domains = String((req.body && req.body.domains) || "im,docs,drive,calendar,task");
  const r = await larkRun(["auth", "login", "--no-wait", "--json", "--domain", domains], { timeout: 60000 });
  const j = larkJson(r.stdout);
  if (!j || !j.verification_url || !j.device_code) {
    const msg = (r.stderr || r.stdout || "").slice(0, 300);
    return res.status(400).json({ error: /config init|app.?id/i.test(msg)
      ? "lark-cli 还没绑定应用：先在上面填好 App ID / App Secret 并「写入 lark-cli」，或自己跑 lark-cli config init"
      : "拿不到授权链接：" + (msg || "lark-cli 没有返回内容") });
  }
  // 出二维码：写进临时目录再读成 data URI，前端直接 <img>，不落工作区
  const png = "qr-" + Date.now() + ".png";
  await larkRun(["auth", "qrcode", j.verification_url, "-o", png, "--size", "256"], { timeout: 20000 });
  let dataUri = null;
  try {
    dataUri = "data:image/png;base64," + fs.readFileSync(path.join(LARK_TMP, png)).toString("base64");
    fs.unlinkSync(path.join(LARK_TMP, png));
  } catch {}

  // 阻塞式轮询交给后台子进程，前端只问我们自己的 status
  const child = require("child_process").execFile(
    "lark-cli", ["auth", "login", "--device-code", j.device_code, "--json"],
    { timeout: (j.expires_in || 600) * 1000 + 15000, cwd: LARK_TMP, env: { ...process.env, PATH: shellPath() } },
    (err, stdout, stderr) => {
      if (!larkQr || larkQr.device_code !== j.device_code) return; // 已被新的一轮顶掉
      if (err) { larkQr.state = "error"; larkQr.error = ((stderr || stdout || err.message) + "").slice(0, 300); }
      else { larkQr.state = "ok"; larkQr.result = larkJson(stdout) || {}; }
    },
  );
  child.on("error", (e) => { if (larkQr) { larkQr.state = "error"; larkQr.error = e.message; } });
  larkQr = { device_code: j.device_code, url: j.verification_url, expires_at: Date.now() + (j.expires_in || 600) * 1000, state: "pending", child };
  res.json({ ok: true, url: j.verification_url, qr: dataUri, expires_in: j.expires_in || 600 });
});

app.get("/api/feishu/qr/status", async (_req, res) => {
  if (!larkQr) return res.json({ state: "idle" });
  if (larkQr.state === "pending" && Date.now() > larkQr.expires_at) {
    larkQr.state = "error"; larkQr.error = "二维码超时失效，重新点一次生成";
  }
  if (larkQr.state !== "ok") return res.json({ state: larkQr.state, error: larkQr.error || null });
  const who = larkJson((await larkRun(["whoami"], { timeout: 15000 })).stdout) || {};
  res.json({ state: "ok", identity: who.identity || "", app_id: who.appId || "", user: larkQr.result && larkQr.result.user_name || "" });
});

app.post("/api/feishu/qr/cancel", (_req, res) => {
  if (larkQr && larkQr.child) { try { larkQr.child.kill(); } catch {} }
  larkQr = null;
  res.json({ ok: true });
});

// ---- 缓存清理：界面缓存(Electron chromium) + 各项目 .tmp 临时脚本；不动会话记录/工作区文件/登录态 ----
const CHROMIUM_CACHE_DIRS = ["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "blob_storage", "Shared Dictionary"];
function wbUserDataDir() {
  if (process.versions.electron) {
    try { return require("electron").app.getPath("userData"); } catch {}
  }
  const home = require("os").homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "kylinwork");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "kylinwork");
  return path.join(home, ".config", "kylinwork");
}
function dirSize(p) {
  let n = 0;
  try {
    for (const e of fs.readdirSync(p)) {
      const fp = path.join(p, e);
      try {
        const st = fs.lstatSync(fp); // lstat：.tmp/node_modules 软链绝不能跟进去统计/删除
        if (st.isSymbolicLink()) continue;
        n += st.isDirectory() ? dirSize(fp) : st.size;
      } catch {}
    }
  } catch {}
  return n;
}
function cacheTmpDirs() {
  const set = new Set([path.join(getWorkspaceDir(), ".tmp")]);
  for (const p of config.projects || []) if (p && p.dir) set.add(path.join(p.dir, ".tmp"));
  return [...set];
}
function cacheStats() {
  const ud = wbUserDataDir();
  const ui = CHROMIUM_CACHE_DIRS.reduce((n, d) => n + dirSize(path.join(ud, d)), 0);
  const tmp = cacheTmpDirs().reduce((n, d) => n + dirSize(d), 0);
  return { ui, tmp, total: ui + tmp };
}
// ---------- 数据备份与恢复 ----------
// 打包 data/（会话/记忆/账号/用量/审计）+ config.json + schedules.json + experts.json。
// 工作空间成果文件不进备份（可能巨大，且用户自己看得见摸得着）。备份放项目根 backups/，
// 用系统 tar（mac/linux 自带，win10+ 也有），不为这事拖第三方压缩依赖。
const BACKUP_DIR = dataPath("backups");
const BACKUP_ENTRIES = ["data", "config.json", "schedules.json", "experts.json"];

// 备份里有 config.json（含 API Key）和全部账号数据——只有管理员能碰。
// 本地单人用没登录态时视同管理员（和任务归属的口径一致）
function backupAllowed(req, res) {
  if (!req.user || req.user.role === "admin") return true;
  res.status(403).json({ error: "只有管理员能操作备份" });
  return false;
}

function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter((f) => /^wb-backup-[\w.-]+\.tar\.gz$/.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(BACKUP_DIR, f));
        return { name: f, size: st.size, at: st.mtime.toISOString() };
      })
      .sort((a, b) => b.at.localeCompare(a.at));
  } catch { return []; }
}

function makeBackup(tag) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const name = `wb-backup-${stamp}${tag ? "-" + tag : ""}.tar.gz`;
    const entries = BACKUP_ENTRIES.filter((e) => fs.existsSync(dataPath(e)));
    if (!entries.length) return reject(new Error("没有可备份的数据"));
    require("child_process").execFile(
      "tar", ["-czf", path.join(BACKUP_DIR, name), "-C", DATA_DIR, ...entries],
      { timeout: 300000 },
      (err) => (err ? reject(new Error(err.code === "ENOENT" ? "系统里没有 tar 命令（macOS/Linux/Windows 10 1803+ 都自带；更老的 Windows 请先升级系统）" : "tar 打包失败：" + err.message)) : resolve(name))
    );
  });
}

/** 校验名字必须来自现有备份列表，杜绝路径注入 */
function backupFile(name) {
  const hit = listBackups().find((b) => b.name === name);
  return hit ? path.join(BACKUP_DIR, hit.name) : null;
}

app.get("/api/backup", (req, res) => {
  if (!backupAllowed(req, res)) return;
  res.json({ list: listBackups(), covers: BACKUP_ENTRIES });
});
app.post("/api/backup", async (req, res) => {
  if (!backupAllowed(req, res)) return;
  try {
    const name = await makeBackup("");
    security.audit("数据备份", `已创建备份 ${name}`, "放行");
    res.json({ ok: true, name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/backup/download/:name", (req, res) => {
  if (!backupAllowed(req, res)) return;
  const p = backupFile(req.params.name);
  if (!p) return res.status(404).json({ error: "备份不存在" });
  res.download(p);
});
app.delete("/api/backup/:name", (req, res) => {
  if (!backupAllowed(req, res)) return;
  const p = backupFile(req.params.name);
  if (!p) return res.status(404).json({ error: "备份不存在" });
  fs.unlinkSync(p);
  res.json({ ok: true });
});
app.post("/api/backup/restore", async (req, res) => {
  if (!backupAllowed(req, res)) return;
  const p = backupFile(String((req.body || {}).name || ""));
  if (!p) return res.status(404).json({ error: "备份不存在" });
  try {
    // 恢复前先把现状自动备一份——恢复错了还能回来，这一步绝不省
    const safety = await makeBackup("before-restore");
    await new Promise((resolve, reject) =>
      require("child_process").execFile("tar", ["-xzf", p, "-C", DATA_DIR], { timeout: 300000 },
        (err) => (err ? reject(new Error(err.code === "ENOENT" ? "系统里没有 tar 命令（macOS/Linux/Windows 10 1803+ 都自带）" : "tar 解包失败：" + err.message)) : resolve()))
    );
    security.audit("数据恢复", `已从 ${path.basename(p)} 恢复（恢复前现状已存为 ${safety}）`, "放行");
    res.json({ ok: true, safety, restart_required: true, note: "已恢复到磁盘。内存里还是旧数据，重启应用后完全生效。" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/backup/restart", (req, res) => {
  if (!backupAllowed(req, res)) return;
  if (!process.versions.electron) return res.status(400).json({ error: "非桌面版：请手动重启服务进程" });
  res.json({ ok: true });
  // 先把响应发出去再重启，不然前端只看到断线
  setTimeout(() => {
    try {
      const { app: eApp } = require("electron");
      eApp.relaunch();
      eApp.exit(0);
    } catch (e) { console.warn("[备份] 重启失败:", e.message); }
  }, 600);
});

// ---------- 记忆搬家：导出 / 从其它 agent 导入 ----------
// 路由本体（含白名单扫描 memoryImportSources）已挪到 engine/api/memory.js，见上面 app.use。

app.get("/api/cache", (_req, res) => res.json(cacheStats()));
app.post("/api/cache/clear", async (_req, res) => {
  const before = cacheStats();
  if (process.versions.electron) {
    // 桌面版走官方 API：HTTP 缓存/代码缓存/着色器缓存；Cookie 与 localStorage（登录态、主题）不动
    try {
      const ses = require("electron").session.defaultSession;
      await ses.clearCache();
      try { await ses.clearCodeCaches({}); } catch {}
      try { await ses.clearStorageData({ storages: ["shadercache", "cachestorage"] }); } catch {}
    } catch (e) { console.warn("[缓存] Electron 清理失败:", e.message); }
  }
  const ud = wbUserDataDir();
  for (const d of CHROMIUM_CACHE_DIRS) {
    const dir = path.join(ud, d);
    try {
      for (const e of fs.readdirSync(dir)) {
        try { fs.rmSync(path.join(dir, e), { recursive: true, force: true }); } catch {} // 被占用就跳过
      }
    } catch {}
  }
  for (const dir of cacheTmpDirs()) {
    try {
      for (const e of fs.readdirSync(dir)) {
        const fp = path.join(dir, e);
        try {
          if (fs.lstatSync(fp).isSymbolicLink()) fs.unlinkSync(fp); // node_modules 软链只解链，下次 runNode 自动重建
          else fs.rmSync(fp, { recursive: true, force: true });
        } catch {}
      }
    } catch {}
  }
  const after = cacheStats();
  res.json({ ok: true, freed: Math.max(0, before.total - after.total), before: before.total, after: after.total });
});

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

app.get("/api/skills", (_req, res) =>
  // plugin 字段标出技能来自哪个 Agent Plugins 插件（本地技能没有这个字段），界面据此禁用编辑/删除
  res.json((runtime ? runtime.getSkills() : []).map((s) => ({ name: s.name, description: s.description, plugin: s.plugin || "" })))
);
// 技能管理：getSkills 每次现读磁盘，增删改/安装即热生效，无需重启
const skillsMgr = require("./skills");
app.get("/api/skills/:name", (req, res) => {
  const s = skillsMgr.getSkillFull(req.params.name);
  if (!s) return res.status(404).json({ error: "技能不存在" });
  res.json(s);
});
app.post("/api/skills", (req, res) => {
  try {
    const { name, description, content, original_name } = req.body || {};
    if (!String(name || "").trim()) throw new Error("技能名不能为空");
    if (!String(content || "").trim()) throw new Error("技能内容不能为空");
    res.json(skillsMgr.saveSkill({ name, description, content, original_name }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.delete("/api/skills/:name", (req, res) => {
  try {
    res.json({ ok: skillsMgr.deleteSkill(req.params.name) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.post("/api/skills/install", async (req, res) => {
  try {
    const installed = await skillsMgr.installFromGitHub((req.body || {}).url);
    res.json({ ok: true, installed });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- 默认技能：不随仓库打包，点一下从上游装 ----
app.get("/api/skills/defaults/list", (_req, res) => res.json(skillsMgr.listDefaultSkills()));
app.post("/api/skills/defaults/install", async (req, res) => {
  try {
    const { names, force } = req.body || {};
    const results = await skillsMgr.ensureDefaultSkills({
      only: Array.isArray(names) && names.length ? names : null,
      force: !!force, // 「重新下载」要真的重下，不然点了没反应
    });
    res.json({ ok: true, results });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- Agent Plugins 1.0.0 插件 ----
const pluginsMgr = require("./plugins");
app.get("/api/plugins", (_req, res) => {
  const list = pluginsMgr.loadPlugins().map((p) => ({
    ok: p.ok,
    name: p.name,
    error: p.error || "",
    warnings: p.warnings || [],
    version: p.manifest?.version || "",
    description: p.manifest?.description || "",
    license: p.manifest?.license || "",
    author: p.manifest?.author?.name || "",
    homepage: p.manifest?.homepage || "",
    repository: p.manifest?.repository || "",
    skills: (p.skills || []).map((s) => ({ name: s.name, description: s.description })),
    mcp_servers: (p.mcpServers || []).map((s) => ({ name: s.name, transport: s.transport })),
    bytes: p.ok ? skillsMgr.dirSize(p.dir) : 0,
    source: pluginsMgr.pluginSource(p.name), // 有来源才给「更新」按钮
  }));
  res.json({ spec: pluginsMgr.SPEC_VERSION, plugins: list, mcp: mcpManager.status() });
});
app.post("/api/plugins/install", async (req, res) => {
  try {
    const info = await pluginsMgr.installPluginFromGitHub((req.body || {}).url);
    // 插件带的 MCP 服务器要现起才能用；技能是每次任务现读磁盘的，不用管
    const started = await startPluginMcp(info.name);
    res.json({ ok: true, installed: info, mcp_started: started });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.post("/api/plugins/:name/update", async (req, res) => {
  try {
    const name = req.params.name;
    // 旧的先停干净：重装会把目录整个换掉，老进程留着还指着已经删掉的文件
    mcpManager.stopPlugin(name);
    const info = await pluginsMgr.updatePlugin(name);
    const started = await startPluginMcp(info.name);
    res.json({ ok: true, updated: info, mcp_started: started });
  } catch (e) {
    // 更新失败也得把停掉的服务器捞回来，不然用户点一下「更新」反而把能用的搞没了
    try { await startPluginMcp(req.params.name); } catch { /* 插件目录可能已经没了 */ }
    res.status(400).json({ error: e.message });
  }
});
app.delete("/api/plugins/:name", (req, res) => {
  try {
    // 先停进程再删目录：目录一删就查不出它带过哪些服务器，子进程会一直挂到重启应用
    const stopped = mcpManager.stopPlugin(req.params.name);
    const ok = pluginsMgr.removePlugin(req.params.name);
    if (!ok) return res.json({ ok: false, note: "没有这个插件" });
    res.json({
      ok: true,
      mcp_stopped: stopped,
      note: stopped.length ? `插件已卸载，同时停掉了它带的 ${stopped.length} 个 MCP 服务器` : "插件已卸载",
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** 只起某个插件里还没连上的 MCP 服务器（装完立刻可用，不用重启） */
async function startPluginMcp(pluginName) {
  const want = pluginsMgr.pluginMcpServers().filter((s) => s.plugin === pluginName && !mcpManager.clients.has(s.name));
  if (!want.length) return [];
  await mcpManager.startAll(want);
  return want.filter((s) => mcpManager.clients.has(s.name)).map((s) => s.name);
}

// ==================== 上传：一律收「原始字节流 + 文件名放 header」 ====================
// 前端发的是文件本身，后端却只认 { name, data_b64 } 的 JSON —— 两边对不上，
// 于是每次上传都是 400，而前端没检查响应码，照样弹「已上传成功」，文件一个都没落盘。
// 统一成字节流还有两个好处：不 base64 膨胀 33%，也不受 json body 上限约束，
// 几十 MB 的 PPT / 视频才传得动。旧的 JSON base64 分支保留，老调用方不会突然挂掉。
/** @param limit 单个请求的体积上限（不同接口能传的东西大小差很多） */
function rawUpload(limit) {
  return express.raw({ type: ["application/octet-stream", "image/*"], limit });
}
/** 看文件头认图片类型：content-type 由前端给，不可信也不一定对，字节不会骗人 */
function sniffImage(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") return "image/png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 6 && buf.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}
/** 文件名：前端用 header 传（中文名要编码），query 上的 name 作为兼容入口 */
function uploadName(req) {
  const raw = req.headers["x-file-name"] || req.query.name || "";
  try {
    return decodeURIComponent(String(raw));
  } catch {
    return String(raw);
  }
}

// 文件上传到工作空间（输入框 ＋ 按钮）
// 用户传进来的文件要和这轮的产出待在一起。以前一律落工作空间根目录，于是
// 「我传的素材」和「它做出来的成果」分了家，根目录越堆越乱（真实数据里躺了 22 个）。
// 时序坑：用户是**先传文件再发消息**，而成果文件夹要等第一条消息才建得出名字。
// 所以没文件夹时先落根目录并记账，等文件夹一建好，assignSessionDir 再把它们搬进去。
app.post("/api/upload", rawUpload("200mb"), (req, res) => {
  try {
    // 主流路径：原始字节流（文件名在 header/query）。见本文件头部的统一说明
    if (Buffer.isBuffer(req.body)) {
      const name = uploadName(req);
      if (!name) return res.status(400).json({ error: "缺少文件名" });
      if (!req.body.length) return res.status(400).json({ error: "文件是空的" });
      const base = path.basename(name);
      const sess = req.query.session ? getSession(String(req.query.session)) : null;
      const rel = sess && sess.dir ? path.join(sess.dir, base) : base;
      const p = safePath(rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, req.body);
      if (sess && !sess.dir) {
        sess.pending_uploads = (sess.pending_uploads || []).filter((n) => n !== base).concat(base);
      }
      return res.json({ ok: true, name: base, size: req.body.length });
    }
    const { name, data_b64, session } = req.body || {};
    if (!name || !data_b64) return res.status(400).json({ error: "缺少 name 或 data_b64" });
    const base = path.basename(name);
    const sess = session ? getSession(String(session)) : null;
    const rel = sess && sess.dir ? path.join(sess.dir, base) : base;
    const p = safePath(rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(data_b64, "base64"));
    if (sess && !sess.dir) {
      sess.pending_uploads = (sess.pending_uploads || []).filter((n) => n !== base).concat(base);
    }
    res.json({ ok: true, name: base });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
// 专家管理：增删改就地改 experts 数组（runtime 闭包同一引用，热生效）+ 持久化 experts.json
// 一个专家 = 头像 + 名字 + 花名 + 说明 + 绑定技能 + 默认提示词 的智能体，用户可自建。
const EXPERT_FIELDS = ["name", "alias", "avatar", "category", "tags", "description", "skills", "system"];
function publicExpert(e) {
  return {
    name: e.name,
    alias: e.alias || "",
    avatar: e.avatar || "briefcase", // To B 规范：专家头像一律是 lucide 图标名，前端 ExpertAvatar 渲染，不允许 emoji
    category: e.category || "未分类",
    tags: Array.isArray(e.tags) ? e.tags : [],
    description: e.description || "",
    skills: Array.isArray(e.skills) ? e.skills : [],
    system: e.system || "",
    builtin: !!e.builtin,
  };
}
app.get("/api/experts", (_req, res) => res.json(experts.map(publicExpert)));
app.post("/api/experts", (req, res) => {
  const b = req.body || {};
  const n = String(b.name || "").trim();
  if (!n || !String(b.system || "").trim()) return res.status(400).json({ error: "专家名称与角色设定（提示词）不能为空" });
  if (n === "delegate_to_expert" || n.length > 20) return res.status(400).json({ error: "专家名称不合法（≤20 字）" });
  const arr = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 12) : []);
  const idx = experts.findIndex((e) => e.name === (b.original_name || n));
  // 改名时要保证新名字没被别人占着
  if (experts.some((e, i) => e.name === n && i !== idx)) return res.status(400).json({ error: "同名专家已存在" });
  const entry = {
    name: n,
    alias: String(b.alias || "").trim().slice(0, 12),
    avatar: String(b.avatar || "briefcase").trim().slice(0, 32) || "briefcase", // 存图标名（kebab-case），不再收 emoji
    category: String(b.category || "未分类").trim().slice(0, 12) || "未分类",
    tags: arr(b.tags),
    description: String(b.description || "").trim(),
    skills: arr(b.skills),
    system: String(b.system).trim(),
  };
  if (idx >= 0) {
    entry.builtin = !!experts[idx].builtin; // 内置标记只由 experts.json 决定，接口改不动
    experts.splice(idx, 1, entry);
    // 改了名字的话，团队成员名单要跟着改，否则团里挂着一个不存在的人
    if (b.original_name && b.original_name !== n) {
      for (const t of expertTeams) t.members = t.members.map((m) => (m === b.original_name ? n : m));
    }
  } else experts.push(entry);
  saveExperts();
  res.json({ ok: true, expert: publicExpert(entry) });
});
app.delete("/api/experts/:name", (req, res) => {
  const idx = experts.findIndex((e) => e.name === req.params.name);
  if (idx < 0) return res.status(404).json({ error: "专家不存在" });
  const [gone] = experts.splice(idx, 1);
  for (const t of expertTeams) t.members = t.members.filter((m) => m !== gone.name); // 顺手把团里的他摘掉
  saveExperts();
  res.json({ ok: true });
});

// 专家团 = 智能体团队：把若干专家编成一队，一次委派整队按顺序接力完成
app.get("/api/expert-teams", (_req, res) =>
  res.json(
    expertTeams.map((t) => ({
      name: t.name,
      avatar: t.avatar || "users", // 同专家：头像存 lucide 图标名，不用 emoji
      description: t.description || "",
      members: (t.members || []).filter((m) => experts.some((e) => e.name === m)),
    }))
  )
);
app.post("/api/expert-teams", (req, res) => {
  const b = req.body || {};
  const n = String(b.name || "").trim();
  if (!n || n.length > 20) return res.status(400).json({ error: "团队名称不合法（1~20 字）" });
  const members = (Array.isArray(b.members) ? b.members : [])
    .map((m) => String(m).trim())
    .filter((m) => experts.some((e) => e.name === m));
  if (members.length < 2) return res.status(400).json({ error: "一个团至少要有 2 位专家（成员必须是已存在的专家）" });
  const idx = expertTeams.findIndex((t) => t.name === (b.original_name || n));
  if (expertTeams.some((t, i) => t.name === n && i !== idx)) return res.status(400).json({ error: "同名专家团已存在" });
  const entry = {
    name: n,
    avatar: String(b.avatar || "users").trim().slice(0, 32) || "users",
    description: String(b.description || "").trim(),
    members: [...new Set(members)].slice(0, 8), // 接力式执行，人多了会把时间预算耗光
  };
  if (idx >= 0) expertTeams.splice(idx, 1, entry);
  else expertTeams.push(entry);
  saveExperts();
  res.json({ ok: true, team: entry });
});
app.delete("/api/expert-teams/:name", (req, res) => {
  const idx = expertTeams.findIndex((t) => t.name === req.params.name);
  if (idx < 0) return res.status(404).json({ error: "专家团不存在" });
  expertTeams.splice(idx, 1);
  saveExperts();
  res.json({ ok: true });
});

// ===== 桌面宠物：自定义形象（自己或朋友的照片）=====
// 存进 data/ 而不是 public/：一来不污染仓库（data/ 已 gitignore），二来跟着备份一起走。
const PET_PHOTO_EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };
function petPhotoPath() {
  for (const ext of [".png", ".jpg", ".webp", ".gif"]) {
    const p = dataPath("data", "pet-avatar" + ext);
    if (fs.existsSync(p)) return p;
  }
  return "";
}
function clearPetPhoto() {
  for (const ext of [".png", ".jpg", ".webp", ".gif"]) {
    try { fs.unlinkSync(dataPath("data", "pet-avatar" + ext)); } catch {}
  }
}
app.post("/api/pet/avatar", rawUpload("8mb"), (req, res) => {
  try {
    // 主流路径：图片字节流直接过来，类型按文件头判（比信 content-type 可靠）
    if (Buffer.isBuffer(req.body) && req.body.length) {
      const mime = sniffImage(req.body) || String(req.headers["content-type"] || "").split(";")[0].trim();
      if (!PET_PHOTO_EXT[mime]) return res.status(400).json({ error: "只收 png / jpg / webp / gif 图片" });
      if (req.body.length > 3 * 1024 * 1024) return res.status(400).json({ error: "图片太大（压缩后应小于 3MB）" });
      fs.mkdirSync(dataPath("data"), { recursive: true });
      clearPetPhoto(); // 换形象先清旧的，免得两个扩展名同时躺着分不清用哪个
      fs.writeFileSync(dataPath("data", "pet-avatar" + PET_PHOTO_EXT[mime]), req.body);
      config.pet = { ...(config.pet || {}), character: "photo", enabled: true }; // 特地传了张照片 = 想要它出现
      saveConfig();
      if (global.__wbPet) try { global.__wbPet.applyConfig({ ...config.pet, enabled: config.pet.enabled === true }); } catch {}
      return res.json({ ok: true, size: req.body.length });
    }
    const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([\s\S]+)$/.exec(String((req.body || {}).data_url || ""));
    if (!m) return res.status(400).json({ error: "只收 png / jpg / webp / gif 图片" });
    const buf = Buffer.from(m[2], "base64");
    // 前端已经压到 320px 见方再传，这里只兜底：3MB 以上不像压过，多半是直接甩了张原图
    if (!buf.length || buf.length > 3 * 1024 * 1024) return res.status(400).json({ error: "图片太大（压缩后应小于 3MB）" });
    fs.mkdirSync(dataPath("data"), { recursive: true });
    clearPetPhoto(); // 换形象先清旧的，免得两个扩展名同时躺着分不清用哪个
    fs.writeFileSync(dataPath("data", "pet-avatar" + PET_PHOTO_EXT[m[1]]), buf);
    config.pet = { ...(config.pet || {}), character: "photo", enabled: true }; // 特地传了张照片 = 想要它出现
    saveConfig();
    if (global.__wbPet) try { global.__wbPet.applyConfig({ ...config.pet, enabled: config.pet.enabled === true }); } catch {}
    res.json({ ok: true, size: buf.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/pet/avatar", (_req, res) => {
  clearPetPhoto();
  config.pet = { ...(config.pet || {}), character: "cat" };
  saveConfig();
  if (global.__wbPet) try { global.__wbPet.applyConfig({ ...config.pet, enabled: config.pet.enabled === true }); } catch {}
  res.json({ ok: true });
});

/**
 * 桌面宠物工具的落地实现（tools.js 的 desktop_pet 通过 global.__wbPetTool 调进来）。
 *
 * 为什么放在 engine/index.js：改宠物要同时动三样东西——config.json（持久化）、data/pet-avatar.png（形象）、
 * 还有 Electron 主进程里那个活着的窗口。这三样的把手都在这个文件里，tools.js 只管把参数递过来。
 * 纯 node 模式没有桌面窗口，整个工具会如实报错而不是假装成功。
 */
global.__wbPetTool = {
  async run(input, baseDir) {
    const P = global.__wbPet;
    const action = String((input || {}).action || "create").toLowerCase();
    if (!P) {
      return {
        content: "桌面宠物只在桌面版里有（用 `npm run app` 启动的那种）。当前跑的是纯服务端模式（npm start），没有桌面窗口可以挂宠物。请如实告诉用户这一点，别假装做好了。",
        isError: true,
      };
    }
    const cur = config.pet || {};
    const nowInfo = () => {
      const has = !!petPhotoPath();
      return `当前状态：宠物${cur.enabled === true ? "已显示" : "未显示"}，形象=${has && cur.character === "photo" ? "用户上传的照片" : "内置小猫"}，大小=${Math.round((cur.scale || 1) * 100)}%。`;
    };

    if (action === "status") return { content: nowInfo(), isError: false };

    if (action === "hide") {
      config.pet = { ...cur, enabled: false };
      saveConfig();
      try { P.applyConfig({ ...config.pet, enabled: false }); } catch {}
      return { content: "桌面宠物已收起。用户想让它回来的话，再叫一声就行（或者去 设置 → 人设 里打开）。", isError: false };
    }

    if (action === "show") {
      config.pet = { ...cur, enabled: true };
      saveConfig();
      try { P.applyConfig({ ...config.pet, enabled: true }); } catch {}
      return { content: "桌面宠物已经站到桌面右下角了。" + nowInfo(), isError: false };
    }

    if (action === "remove") {
      clearPetPhoto();
      config.pet = { ...cur, enabled: false, character: "cat" };
      saveConfig();
      try { P.applyConfig({ ...config.pet, enabled: false }); } catch {}
      return { content: "宠物已经撤掉，上传的照片也从本机删干净了。", isError: false };
    }

    if (action !== "create") return { content: `不认识的 action「${action}」，只支持 create / show / hide / remove / status。`, isError: true };

    // ---- create：把一张图做成宠物形象 ----
    const raw = String((input || {}).image || "").trim();
    if (!raw) {
      return {
        content: "做宠物得先有张图。请让用户在输入框里上传一张照片（人像、宠物照、表情包都行），拿到文件名后把它作为 image 参数再调一次。",
        isError: true,
      };
    }
    // 用户上传的图落在工作空间根目录，agent 自己产出的图在本次对话的成果子目录里，两处都找
    const wsRoot = getWorkspaceDir();
    let abs = "";
    for (const cand of [baseDir ? path.resolve(baseDir, raw) : "", path.resolve(wsRoot, raw), path.resolve(wsRoot, path.basename(raw))]) {
      if (!cand) continue;
      const rel = path.relative(wsRoot, cand);
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue; // 越出工作空间的一律不认
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) { abs = cand; break; }
    }
    if (!abs) return { content: `工作空间里找不到「${raw}」。先用 list_files 看看用户上传的图到底叫什么名字。`, isError: true };
    if (!/\.(png|jpe?g|webp|gif|bmp)$/i.test(abs)) return { content: `「${path.basename(abs)}」看着不是图片。支持 png / jpg / webp / gif / bmp。`, isError: true };

    let buf, note = "";
    try {
      // 用 Electron 自带的 nativeImage 裁切缩放，不引任何图像库。GIF 只取第一帧（宠物本来就自带动效，
      // 再叠一层 GIF 动画会打架），这点必须跟用户说清楚，不能让他以为动图没生效是 bug。
      const { nativeImage } = require("electron");
      let img = nativeImage.createFromPath(abs);
      if (img.isEmpty()) return { content: `「${path.basename(abs)}」解码失败，可能是文件损坏或者根本不是图片。`, isError: true };
      const sz = img.getSize();
      const side = Math.min(sz.width, sz.height);
      if (sz.width !== sz.height) {
        img = img.crop({ x: Math.round((sz.width - side) / 2), y: Math.round((sz.height - side) / 2), width: side, height: side });
        note += `原图 ${sz.width}×${sz.height} 不是正方形，已按中心裁成方图；`;
      }
      img = img.resize({ width: 320, height: 320, quality: "best" });
      if (/\.gif$/i.test(abs)) note += "GIF 只取了第一帧（宠物自己带呼吸/跳跃动效）；";
      buf = img.toPNG();
      if (!buf || !buf.length) throw new Error("编码 PNG 失败");
    } catch (e) {
      return { content: "处理图片失败：" + e.message, isError: true };
    }

    fs.mkdirSync(dataPath("data"), { recursive: true });
    clearPetPhoto();
    fs.writeFileSync(dataPath("data", "pet-avatar.png"), buf);
    const scale = Math.max(0.6, Math.min(2, Number((input || {}).scale) || Number(cur.scale) || 1));
    config.pet = { ...cur, enabled: true, character: "photo", scale };
    saveConfig();
    try { P.applyConfig({ ...config.pet, enabled: true }); } catch {}
    try { P.setState("done", "新形象上岗"); } catch {}
    return {
      content: `已经用「${path.basename(abs)}」做好桌面宠物，它现在站在桌面右下角。${note}\n` +
        "它会实时显示你在干什么：干活时头顶转圈、有问题要问时跳起来并弹系统通知、任务完成撒花。\n" +
        "点它一下开关主窗口，拖动换位置，右键有菜单（回到右下角 / 免打扰 / 收起）。\n" +
        "照片只存在用户本机的 data/ 目录，没有上传到任何服务器。",
      isError: false,
    };
  },
};
// 在访达/资源管理器里定位到这个文件（不是打开文件本身，是打开它所在的文件夹并选中它）
// 清掉根目录里那些「跟成果文件夹里某个文件逐字节相同」的副本。
// 敢做这个动作只因为两条：一、判定标准是**哈希相同**，不是名字像，原件确确实实还在；
// 二、**搬进 .trash 而不是删**，捞得回来。少一条都不该有这个按钮。
// 名字像但内容不同的、根目录独有的，一个都不碰——那些是用户自己的东西。
// 空的成果文件夹 = 名字是 任务_ 开头、除了 .DS_Store 一个条目都没有、且不是刚刚才建的。
// 最后那条是唯一的危险点：一个正在跑的回合可能刚建好目录、文件还没落盘，
// 这时候把它搬走就等于把这一轮的产出打断。10 分钟的静默期换掉这个风险，很值。
function listEmptyTaskDirs({ quietMs = 600000, now = Date.now() } = {}) {
  const ws = getWorkspaceDir();
  if (path.resolve(ws) !== dataPath("workspace")) return []; // 用户自选目录不分配成果文件夹，也就没这回事
  let names = [];
  try { names = fs.readdirSync(ws); } catch { return []; }
  return names.filter((n) => {
    if (!n.startsWith("任务_")) return false;
    try {
      const st = fs.statSync(path.join(ws, n));
      if (!st.isDirectory() || now - st.mtimeMs < quietMs) return false;
      return !fs.readdirSync(path.join(ws, n)).some((e) => e !== ".DS_Store");
    } catch { return false; }
  });
}

app.post("/api/files/tidy", (_req, res) => {
  try {
    const dupes = outputFiles().filter((f) => f.dup_of && !f.name.includes("/"));
    // 空的成果文件夹：纯聊天也会建目录，真实数据里 24 个文件夹有 6 个一个文件都没有。
    // 现在回合收尾会自己撤掉，但历史遗留的那些得有人收——顺手挂在这个按钮上，不再单独做一次性脚本。
    const emptyDirs = listEmptyTaskDirs();
    if (!dupes.length && !emptyDirs.length) return res.json({ ok: true, moved: 0, files: [] });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "");
    const trash = safePath(path.join(".trash", stamp));
    fs.mkdirSync(trash, { recursive: true });
    const moved = [];
    for (const f of dupes) {
      try {
        // 搬之前再验一次原件真的在：列表是几毫秒前拍的快照，这中间原件可能已经没了，
        // 那就不是"清掉多余副本"而是"把唯一一份扔掉"了
        const origin = safePath(f.dup_of);
        if (!fs.existsSync(origin) || !fs.statSync(origin).isFile()) continue;
        fs.renameSync(safePath(f.name), path.join(trash, f.name));
        moved.push(f.name);
      } catch {}
    }
    const movedDirs = [];
    for (const d of emptyDirs) {
      // 搬之前再确认一次还是空的：列表是几毫秒前拍的快照，这中间可能刚好有一轮往里写了东西
      try {
        const p = safePath(d);
        if (fs.readdirSync(p).some((n) => n !== ".DS_Store")) continue;
        fs.renameSync(p, path.join(trash, d));
        movedDirs.push(d);
      } catch {}
    }
    security.audit("清理重复副本", [...moved, ...movedDirs.map((d) => d + "/")].join("、") || "（没有可清理的）", "放行");
    res.json({ ok: true, moved: moved.length, files: moved, dirs: movedDirs, trash: path.join(".trash", stamp) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.post("/api/files/reveal", (req, res) => {
  try {
    const p = safePath(String((req.body || {}).name || "")); // 越界一律抛错，跟下载走同一道门
    if (!fs.existsSync(p)) return res.status(404).json({ error: "文件不存在" });
    let revealed = false;
    try {
      const { shell } = require("electron");
      if (shell && shell.showItemInFolder) { shell.showItemInFolder(p); revealed = true; }
    } catch {}
    if (!revealed) openWithSystem(path.dirname(p)); // 纯 node 模式：退而求其次，打开所在文件夹
    res.json({ ok: true, revealed });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get("/api/files/download/:name", (req, res) => {
  try {
    const p = safePath(req.params.name);
    if (!fs.existsSync(p)) return res.status(404).send("文件不存在");
    res.download(p);
  } catch (e) {
    res.status(400).send(e.message);
  }
});

// 应用内预览：按正确 Content-Type 内联返回（HTML/图片/PDF 可直接在 iframe/img 中显示）
app.get("/api/files/view/:name", (req, res) => {
  try {
    const p = safePath(req.params.name);
    if (!fs.existsSync(p)) return res.status(404).send("文件不存在");
    res.sendFile(p);
  } catch (e) {
    res.status(400).send(e.message);
  }
});

// Office 三件套和压缩包的应用内预览：浏览器打不开 zip 里的一包 XML，这一层把它拆成结构化数据。
// 只吐数据不吐 HTML——文件内容是模型写的或从网上下的，转出来的 HTML 直接进渲染进程等于自开 XSS，
// 拼 HTML 的活统一留在前端一处（每个字段都过 esc），转义漏没漏只需要审那一个地方。
app.get("/api/files/preview/:name", async (req, res) => {
  try {
    const p = safePath(req.params.name);
    if (!fs.existsSync(p)) return res.status(404).json({ error: "文件不存在" });
    res.json(await previewData(p, req.params.name));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 对话里的内联图表「存为文件」：内容是前端已经渲染过的东西，落盘到工作目录就能进成果面板、
// 能下载、能被后续回合当素材继续用。扩展名白名单挡住"顺手写个 .sh/.command 再让我打开"的路子。
const SAVE_EXT_OK = /\.(svg|png|jpe?g|html?|md|markdown|txt|csv|json)$/i;
app.post("/api/files/save", (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const content = req.body?.content;
    if (!name || typeof content !== "string") return res.status(400).json({ error: "缺少 name 或 content" });
    if (!SAVE_EXT_OK.test(name)) return res.status(400).json({ error: "不支持保存这种类型的文件" });
    const p = safePath(name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const b64 = content.match(/^data:[^;]+;base64,(.*)$/s);
    fs.writeFileSync(p, b64 ? Buffer.from(b64[1], "base64") : content);
    res.json({ ok: true, name, files: outputFiles() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- 本地部署预览：把工作目录当静态站点跑在一个独立端口上 ----
// 应用内 iframe 预览走 /api/files/view，够看长相；但真正的网页要有自己的 origin 才对
// （相对路径引资源、fetch、localStorage、手机上开来看）。这里起一个只监听本机的静态服务器。
let previewServer = null; // { srv, port, dir }
function lanAddress() {
  const nets = require("os").networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const ni of list || []) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return null;
}
function previewState() {
  if (!previewServer) return { running: false };
  const lan = previewServer.lanOpen ? lanAddress() : null;
  return {
    running: true,
    port: previewServer.port,
    dir: previewServer.dir,
    lan_open: !!previewServer.lanOpen,
    url: `http://127.0.0.1:${previewServer.port}/`,
    lan_url: lan ? `http://${lan}:${previewServer.port}/` : null,
  };
}
app.get("/api/preview/status", (_req, res) => res.json(previewState()));
app.post("/api/preview/start", (req, res) => {
  const dir = getWorkspaceDir();
  // lan=true 才对局域网开放：开了手机能扫，但同一个 Wi-Fi 下的人也能翻整个工作目录，所以默认关
  const lanOpen = !!(req.body && req.body.lan);
  // open=文件名：服务就绪后用系统默认浏览器打开它
  const openName = req.body && req.body.open ? String(req.body.open).replace(/^\/+/, "") : null;
  const done = (st) => {
    if (openName) openWithSystem(st.url + encodeURIComponent(openName));
    res.json(st);
  };
  // 已经在跑且参数一致：不用重起，但该开的浏览器还是得开。
  // （这里以前是直接 return，把 open 一起吞了——而「在浏览器打开」按钮只在服务已启动时才出现，
  //   必然走这条分支，所以那个按钮点了从来没反应过。）
  if (previewServer && previewServer.dir === dir && previewServer.lanOpen === lanOpen) return done(previewState());
  if (previewServer) { try { previewServer.srv.close(); } catch {} previewServer = null; }
  const site = express();
  site.use(express.static(dir, { extensions: ["html"] }));
  // 端口 0 = 让系统分配空闲端口，避免和用户本机其它服务撞车
  const srv = site.listen(0, lanOpen ? "0.0.0.0" : "127.0.0.1", () => {
    previewServer = { srv, port: srv.address().port, dir, lanOpen };
    done(previewState());
  });
  srv.on("error", (e) => {
    if (!res.headersSent) res.status(500).json({ error: "本地预览服务起不来：" + e.message });
  });
});
app.post("/api/preview/stop", (_req, res) => {
  if (previewServer) { try { previewServer.srv.close(); } catch {} previewServer = null; }
  res.json({ running: false });
});

// 用系统默认程序打开（Word/PPT/Excel 等交给本机 Office/WPS）
app.post("/api/files/open/:name", (req, res) => {
  try {
    const p = safePath(req.params.name);
    if (!fs.existsSync(p)) return res.status(404).json({ error: "文件不存在" });
    openWithSystem(p);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/chat", async (req, res) => {
  const { sessionId, message, mode, regen, kb_ids, expert } = req.body || {};
  if (!sessionId || !message) return res.status(400).json({ error: "缺少 sessionId 或 message" });
  const user = req.user; // authGuard 已挂上
  // 积分闸门默认是关的（本地个人用不该被自己的账本拦），开了才查余额
  if (user && account.creditsEnabled() && user.credits <= 0) {
    return res.status(402).json({ error: "积分不足，无法执行任务。管理员可以在左下角「账号 · 用量」里充值，或者干脆把「积分限额」关掉。" });
  }
  if (activeRuns.has(sessionId)) {
    return res.status(409).json({ error: "该会话已有任务在运行，可用「插队」把补充说明注入当前任务。" });
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.on("error", () => {});
  // 客户端可能中途断开（刷新页面/断网/电脑睡眠），任务照跑：
  // 主连接断了就不再写它，事件继续发给 /api/chat/stream 续流进来的订阅者
  const runState = { ctrl: new AbortController(), interject: [], asks: new Map(), subscribers: new Set(), events: null };
  const send = (event) => {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    if (!res.destroyed && !res.writableEnded) { try { res.write(line); } catch {} }
    for (const sub of runState.subscribers) { try { sub.write(line); } catch {} }
  };

  const sess = getSession(sessionId);
  if (user && !sess.user) sess.user = user.username;
  const sessLLM = llmForSession(sess); // 本对话生效的模型（含专家子代理、标题、记账）
  const sessKey = sessLLM.key || sessLLM.provider; // 健康账本按「渠道::模型」记账，同名渠道下多模型不串账
  if (regen) {
    // 重新生成：回滚掉最后一轮（用户消息及其后的所有内容），下面会把同一条消息重新入队
    const lastUser = sess.history.map((h) => h.role).lastIndexOf("user");
    if (lastUser >= 0) sess.history.splice(lastUser);
    if (sess.transcript.length && sess.transcript[sess.transcript.length - 1].type === "assistant") sess.transcript.pop();
    if (sess.transcript.length && sess.transcript[sess.transcript.length - 1].type === "user") sess.transcript.pop();
  }
  // 截断兜底标题要先去掉「【任务类型：X】」这个给模型看的前缀，不然起标题失败时历史列表全是它
  if (!sess.title) sess.title = message.replace(/^\s*【任务类型：[^】]*】\s*/, "").slice(0, 24);
  sess.history.push({ role: "user", content: message });
  // 每一轮自己盖时间戳。以前只有会话级的 updated_at，于是自进化的挖掘器只能拿它当近似——
  // 结果是**一个会话里几个月前的失败和今天的失败共用同一个时间**。这不是精度问题：
  // scoreRules 按"规则生效以来"开窗打分，只要这个会话今天被打开过，它里面规则生效**之前**的
  // 失败就全算进"生效之后"，规则越有效越会被判「没起作用」并建议下架。
  const turnAt = new Date().toISOString();
  sess.transcript.push({ type: "user", text: message, mode, at: turnAt });
  const asstEvents = [];
  sess.transcript.push({ type: "assistant", events: asstEvents, at: turnAt });
  autosaveSession(sessionId, 0); // 先把用户这句话落盘，后面再崩至少问题还在

  runState.events = asstEvents; // 续流端点靠它补发已记录的事件
  activeRuns.set(sessionId, runState);
  persistRunning();
  const emitFn = recordingEmit(send, asstEvents, sessionId);
  const total = { prompt: 0, completion: 0, cached: 0, calls: 0, elapsed_ms: 0 };
  // 首轮对话：并行起一个真正的短标题（拿消息前 24 个字截断当标题太丑）。
  // 跟任务并行跑，任务收尾时基本已就绪，不给任务加等待；花的 token 记进同一笔账
  let titleP = null;
  if (sess.transcript.filter((e) => e.type === "user").length === 1) {
    titleP = sessLLM
      .chat({
        system: "你给任务起标题。只输出 6~14 个字的中文短标题概括这个任务，不要引号、标点、任何前后缀。",
        history: [{ role: "user", content: String(message).slice(0, 500) }],
        tools: [],
        signal: AbortSignal.timeout(20000),
      })
      .then((r) => {
        addUsage(total, r && r.usage);
        return r && r.text ? String(r.text) : null;
      })
      .catch(() => null);
  }
  // 默认工作空间：每个对话固定一个成果子文件夹（任务_月日_标题），根目录不再越堆越乱；
  // 用户自选的工作目录 / 项目目录保持原地读写不变（素材要在原文件夹里就地处理）
  let taskBaseDir = null;
  if (path.resolve(getWorkspaceDir()) === dataPath("workspace")) {
    if (!sess.dir) assignSessionDir(sess, message);
    taskBaseDir = sess.dir;
  }
  if (taskBaseDir) send({ type: "dir", dir: taskBaseDir }); // 成果面板标「本对话」用；不进回放记录
  // Goal 模式：第一次用目标消息建目标（拆成验收标准）；已有进行中的目标就直接接着冲
  const goalMode = mode === "goal";
  if (goalMode && (!sess.goal || sess.goal.status !== "active")) {
    const criteria = await deriveGoalCriteria(sessLLM, message, total);
    sess.goal = { text: String(message).slice(0, 500), criteria: criteria.map((t) => ({ text: t, done: false })), status: "active", round: 0 };
    autosaveSession(sessionId, 0);
  }
  if (sess.goal) send({ type: "goal", goal: sess.goal }); // 目标卡状态直播；不进回放记录（回放时从会话里取）
  let runFailed = null; // 整跑是否以异常收场（记进模型健康账本）
  // 知识库检索：用户在输入框勾了库，就用这句话去库里召回几段，拼进任务上下文。
  // 检索失败不让任务挂掉——顶多是这轮没有资料可依，agent 照常跑。
  const kbIds = Array.isArray(kb_ids) ? kb_ids.filter(Boolean) : [];
  let kbCtx = "";
  if (kbIds.length) {
    try {
      const r = await knowledge.buildContext(message, kbIds);
      if (r.text) {
        kbCtx = r.text;
        send({ type: "status", text: `已从知识库检索到 ${r.hits.length} 段相关内容` });
        // 引用元数据随事件发给界面：答复底下的「来源」就靠它，重开对话回放也还在
        if (r.citations && r.citations.length) emitFn({ type: "citations", citations: r.citations });
      } else {
        send({ type: "status", text: "知识库未检索到相关内容" });
      }
    } catch (e) {
      send({ type: "status", text: "知识库检索失败：" + e.message });
    }
  }
  if (global.__wbPet) try { global.__wbPet.setState("working", sess.title || String(message).slice(0, 40)); } catch {}
  // 界面里选定的专家：这是系统层面的选择，不该靠用户消息里塞一句「请以…的角色」来表达。
  // 用户既然点了这位专家，就把它写进任务上下文并要求协调者委派——保证它一定会被调用到，
  // 不依赖用户在提示词里再写一遍（那样既多余，漏写就调不到了）。
  let expertCtx = "";
  const pickedExpert = expert ? experts.find((e) => e.name === expert) : null;
  if (pickedExpert) {
    expertCtx =
      `\n\n## 本次任务指定的专家\n用户在界面上选定了专家「${pickedExpert.name}」` +
      `${pickedExpert.alias ? `（花名「${pickedExpert.alias}」）` : ""}，职责：${pickedExpert.description || pickedExpert.category || "（无说明）"}。\n` +
      `这是用户的明确指定：你必须通过 delegate_to_expert 把任务委派给「${pickedExpert.name}」执行，不要自己直接动手。` +
      `委派的任务描述要自包含（目标、输入文件名、期望产出文件名），专家看不到你和用户的对话历史。`;
  } else if (expert) {
    send({ type: "status", text: `界面选定的专家「${expert}」已不存在，本次按通用流程执行` });
  }
  try {
    // 外层：目标轮（普通消息只走一轮；goal 模式没达标自动再跑，最多 GOAL_MAX_ROUNDS 轮）
    let lastFinal = "";
    let roundStopped = null; // 本目标轮里任务被强制收尾的原因（超时/上限/手停）；有它就不再自动开新轮
    for (let goalRound = 0; ; goalRound++) {
      roundStopped = null;
      // 进行中的目标注入任务上下文：agent 每一轮都对着验收标准干活，不跑偏
      let goalCtx = "";
      if (sess.goal && sess.goal.status === "active") {
        goalCtx = `\n\n## 本对话的目标（Goal 模式）\n目标：${sess.goal.text}\n验收标准（打勾的已达成，别重做）：\n` +
          sess.goal.criteria.map((c, i) => `${i + 1}. [${c.done ? "✓" : " "}] ${c.text}`).join("\n") +
          `\n交付物必须能通过未达成的验收标准。`;
      }
      // 内层：任务收尾瞬间可能还有没被 agent 循环消化的插队消息 → 追加为新一轮，直到清空
      for (;;) {
        const r = await runtime.runTask({
          taskLabel: sess.title || String(message).slice(0, 24),
          baseDir: taskBaseDir,
          llmOverride: sessLLM,
          history: sess.history,
          emit: emitFn,
          mode: ["ask", "plan", "craft"].includes(mode) ? mode : "craft",
          user: user ? user.username : undefined,
          projectContext: (projectContextOf(activeProject()) || "") + kbCtx + goalCtx,
          expertContext: expertCtx,
          kbIds,
          stopSignal: runState.ctrl.signal,
          getInterject: () => runState.interject.splice(0),
          // ask_user 工具的等待端：回答从 /api/chat/answer 进来；超时或用户点停止都放行 null
          askUser: ({ askId, timeoutMs }) => new Promise((resolve) => {
            const done = (v) => {
              clearTimeout(timer);
              runState.asks.delete(askId);
              runState.ctrl.signal.removeEventListener("abort", onAbort);
              resolve(v);
            };
            const timer = setTimeout(() => done(null), timeoutMs);
            const onAbort = () => done(null);
            runState.ctrl.signal.addEventListener("abort", onAbort);
            runState.asks.set(askId, done);
          }),
        });
        addUsage(total, r && r.usage);
        if (r && r.finalText) lastFinal = r.finalText;
        if (r && r.stopped) roundStopped = r.stopped;
        const leftover = runState.interject.splice(0);
        if (!leftover.length || runState.ctrl.signal.aborted) break;
        for (const m of leftover) {
          sess.history.push({ role: "user", content: m });
          emitFn({ type: "interject", text: m });
        }
      }
      // 没有进行中的目标 / 用户已手动停止 → 不验收不加轮
      if (!sess.goal || sess.goal.status !== "active" || runState.ctrl.signal.aborted) break;
      await verifyGoal(sess, sessLLM, lastFinal, total);
      sess.goal.round = (sess.goal.round || 0) + 1;
      send({ type: "goal", goal: sess.goal });
      autosaveSession(sessionId, 0);
      if (!goalMode || sess.goal.status === "done" || goalRound + 1 >= GOAL_MAX_ROUNDS) break;
      // 这轮是被超时/上限硬切断的：同样的条件再跑一轮大概率原样再撞，别把用户的时间和钱烧在死循环里
      if (roundStopped) {
        emitFn({ type: "interject", text: `【目标验收】这轮任务被强制收尾（${roundStopped}），暂停自动补跑。解决后可以直接说「继续」接着冲目标。` });
        break;
      }
      // 没达标 → 把未达成项作为下一轮指令，接着冲（进回放记录，回放时能看懂为什么又跑了一轮）
      const unmet = sess.goal.criteria.filter((c) => !c.done).map((c) => "· " + c.text).join("\n");
      const fb = `【目标验收 · 第 ${sess.goal.round} 轮】以下验收标准还没达成：\n${unmet}\n只补这些未达成项，别重做已达成的部分。`;
      sess.history.push({ role: "user", content: fb });
      emitFn({ type: "interject", text: fb });
    }
  } catch (e) {
    runFailed = e.message;
    const streak = (modelFailStreak.get(sessKey) || 0) + 1;
    modelFailStreak.set(sessKey, streak);
    let emsg = e.message;
    if (streak >= 2) {
      emsg += `\n\n💡 模型「${sessLLM.model || sessLLM.provider}」已连续失败 ${streak} 次，多半是这个模型/渠道本身不可用：可以点输入框旁的模型按钮给本对话单独换一个，或到 设置 → 模型 换全局默认。`;
    }
    send({ type: "error", message: emsg });
    asstEvents.push({ type: "error", message: emsg });
  } finally {
    activeRuns.delete(sessionId);
    persistRunning();
    if (global.__wbPet) try { global.__wbPet.setState(runFailed ? "error" : "done", runFailed ? String(runFailed).slice(0, 80) : "任务完成"); } catch {}
    // 本机系统通知：窗口失焦/最小化时用户看不到画面，跑完了得吭一声。
    // 手动停止不弹（用户自己停的，心里有数）；出错时把标题带上，多任务并行才知道是哪个炸了
    try {
      const label = sess.title || String(message || "").slice(0, 20);
      if (runFailed) notify.desktop("error", "任务出错", label, { session: sessionId });
      else if (!runState.ctrl.signal.aborted) notify.desktop("done", "任务完成", label + "，成果已就绪", { session: sessionId });
    } catch {}
  }
  if (total.calls > 0) modelFailStreak.delete(sessKey); // 有成功调用就算这个模型活着，清连挂计数
  // 健康账本：异常收场记一败；正常收场且真调过模型记一胜（秒停等一次没调的不记，记了是噪声）
  if (runFailed) recordModelHealth(sessKey, false, runFailed);
  else if (total.calls > 0) recordModelHealth(sessKey, true);

  // 记账：按整个任务（含插队追加轮）的总 tokens 扣积分
  if (user && total.calls > 0) {
    const spent = account.chargeRun(user, { ...total, model: sessLLM.model, provider: sessLLM.provider, source: "web", sessionId });
    // 不限额时 spent 是 0，就别在结果下面挂一行「扣 0 积分」了，那只是噪声
    if (spent > 0) emitFn({ type: "credits", spent, balance: user.credits });
  }

  // 标题生成失败/没赶上就保持截断标题，绝不为它多等
  if (titleP) {
    const t = await Promise.race([titleP, new Promise((r) => setTimeout(r, 3000, null))]);
    const clean = t && t.replace(/[\r\n"“”「」『』]/g, "").trim().slice(0, 20);
    if (clean) { sess.title = clean; send({ type: "title", title: clean }); }
  }
  // 这一轮什么都没产出的话，别留一个空文件夹在工作空间里。
  //
  // 空文件夹的来路不止一条：executeTool 拿到 baseDir 就 mkdir（连只读工具也会）、
  // 脚本的 cwd 也要目录先在。逐个堵必漏，所以在回合收尾处一处收口。
  // 用 rmdirSync 而不是 rm -r：**它删不掉非空目录**，这是天生的保险——
  // 万一判断有误，最坏结果是删不动报个错，绝不会连着成果一起没了。
  //
  // 顺带把名字修好：清掉之后 sess.dir 置空，下一轮重新分配时 sess.title 已经是
  // 模型生成的真短标题了，于是「任务_0822_你好」这种名字自己就没了。
  if (taskBaseDir && sess.dir && !(sess.pending_uploads || []).length) {
    const full = path.join(getWorkspaceDir(), sess.dir);
    try {
      if (fs.existsSync(full) ? !fs.readdirSync(full).length : true) {
        if (fs.existsSync(full)) fs.rmdirSync(full); // 非空会抛，抛了就什么都不动
        assignedDirs.delete(sess.dir);
        sess.dir = null;
      }
    } catch {} // 删不动就留着，一个空文件夹远好过一次误删
  }
  saveSession(sessionId);
  // 收尾只是刷一遍完整文件列表，不是"本回合有产出"的通报：changed 明确给空，
  // 免得前端拿本地 mtime 猜一把，把工作目录里的旧文件当成新成果又把面板弹出来
  send({ type: "files", files: outputFiles(), changed: [] });
  send({ type: "done" });
  if (!res.destroyed && !res.writableEnded) { try { res.end(); } catch {} }
  for (const sub of runState.subscribers) { try { sub.end(); } catch {} }
  runState.subscribers.clear();
});

// 插队：往正在运行的任务里注入一条补充消息（agent 在下一个安全间隙读到并继续）
app.post("/api/chat/interject", (req, res) => {
  const { sessionId, message } = req.body || {};
  const text = String(message || "").trim();
  const run = activeRuns.get(sessionId);
  if (!run) return res.status(409).json({ ok: false, error: "该会话没有正在运行的任务" });
  if (!text) return res.status(400).json({ ok: false, error: "消息为空" });
  run.interject.push(text);
  res.json({ ok: true, queued: run.interject.length });
});

// ask_user 的回答通道：agent 弹的问题，用户点选/输入后从这里回填给正在等待的那次工具调用
app.post("/api/chat/answer", (req, res) => {
  const { sessionId, askId, answer } = req.body || {};
  const run = activeRuns.get(sessionId);
  if (!run) return res.status(409).json({ ok: false, error: "该会话没有正在运行的任务" });
  const resolve = run.asks && run.asks.get(String(askId || ""));
  if (!resolve) return res.status(404).json({ ok: false, error: "这个问题已过期或已回答过" });
  const text = String(answer || "").trim().slice(0, 2000);
  if (!text) return res.status(400).json({ ok: false, error: "回答为空" });
  resolve(text);
  res.json({ ok: true });
});

// 正在运行任务的会话列表：前端刷新后靠它找回后台任务，断流后靠它判断任务是否还活着。
// 回 { sessions: [...] } 而不是裸数组：前端按名字取字段，裸数组会让它永远读到空，
// 于是「刷新后接回后台任务」这条路径静默失效（任务其实还在跑，界面却看不到）。
app.get("/api/chat/running", (req, res) => {
  const ids = [...activeRuns.keys()].filter((id) => {
    if (!req.user || req.user.role === "admin") return true;
    const s = sessions.get(id);
    return !s || !s.user || s.user === req.user.username;
  });
  res.json({ sessions: ids });
});

// 断点续流：把 transcript 里已记录的事件从 from 序号补发，然后接上直播（页面刷新/断网重连后无缝接回）。
// textOffset 处理最后一条还在增长的合并文本：客户端已看过前 textOffset 个字符，只补后半段。
// slice 到加入订阅是同步完成的，中间不会漏事件也不会重复。
app.get("/api/chat/stream/:id", (req, res) => {
  const run = activeRuns.get(req.params.id);
  if (!run || !run.events) return res.status(404).json({ error: "该会话没有正在运行的任务" });
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.on("error", () => {});
  const from = Math.max(0, parseInt(req.query.from, 10) || 0);
  const textOffset = Math.max(0, parseInt(req.query.textOffset, 10) || 0);
  run.events.slice(from).forEach((ev, i) => {
    const out = i === 0 && textOffset && ev.type === "text" ? { type: "text", delta: String(ev.delta).slice(textOffset) } : ev;
    try { res.write(`data: ${JSON.stringify(out)}\n\n`); } catch {}
  });
  run.subscribers.add(res);
  req.on("close", () => run.subscribers.delete(res));
});

// 历史会话回放
// 文件根本不存在时要说实话。会话是按数据目录存的（装机态 ~/KylinWork、开发态仓库目录、
// KYLINWORK_HOME 可覆盖），而前端侧栏那份历史索引存在 localStorage 里、不跟着数据目录走——
// 换过运行方式之后索引里的 id 这边就是没有的。以前这种情况一律回空 transcript（HTTP 200），
// 界面只能显示「没有可恢复的内容（可能引擎重启时未落盘）」，把「换了数据目录」误报成「数据丢了」。
app.get("/api/session/:id", (req, res) => {
  if (!fs.existsSync(sessFile(req.params.id))) {
    return res.status(404).json({
      error: "引擎里没有这条会话（它的内容可能不在当前数据目录下）",
      missing: true,
    });
  }
  const s = getSession(req.params.id);
  res.json({ transcript: s.transcript, dir: s.dir || null, model: s.model || null, goal: s.goal || null });
});

// 归档目标：目标卡上点 ✕。已达成/不想要了都走这里，不删记录只改状态
app.post("/api/session/:id/goal", (req, res) => {
  const s = getSession(req.params.id);
  if (!s.goal) return res.status(400).json({ error: "该对话没有目标" });
  if ((req.body || {}).action === "close") {
    s.goal.status = "closed";
    saveSession(req.params.id);
  }
  res.json({ ok: true, goal: s.goal });
});

// ---------- 内置评测（界面版）：spawn 子进程跑 eval/run.js ----------
// 子进程隔离是刚需：评测会 setWorkspaceDir 到自己的沙盒目录，进程内跑会把主应用的工作空间劫走
const evalState = { running: false, lines: [], startedAt: 0, model: "", exit: null };
function evalSummaryBrief(j) {
  if (!j) return null;
  // 兼容两代格式：v3 有 repeat/pass1_avg/attempts，旧格式按 k=1 折算，前端只走一条代码路径
  return {
    at: j.at, model: j.model, model_id: j.model_id, score_pct: j.score_pct,
    repeat: j.repeat || 1,
    pass1_avg: j.pass1_avg != null ? j.pass1_avg : (j.tasks ? Math.round((j.full_pass / j.tasks) * 100) : 0),
    flaky_tasks: j.flaky_tasks || [], fail_code_counts: j.fail_code_counts || {},
    baseline: j.baseline || null,
    tasks: j.tasks, full_pass: j.full_pass, checks_passed: j.checks_passed, checks_total: j.checks_total,
    tokens_total: j.tokens_total, avg_prompt_per_call: j.avg_prompt_per_call || 0,
    commit: j.commit || "", judge: j.judge || null, human: j.human || null,
    results: (j.results || []).map((r) => {
      const k = r.k || 1;
      const passes = r.passes != null ? r.passes : (r.passed === r.total ? 1 : 0);
      return {
        id: r.id, name: r.name, level: r.level || 1, kind: r.kind || "",
        passed: r.passed, total: r.total, elapsed_s: r.elapsed_s,
        k, passes, pass_rate: r.pass_rate != null ? r.pass_rate : +(passes / k).toFixed(3),
        flaky: !!r.flaky, fail_codes: r.fail_codes || [],
        attempts: (r.attempts || []).map((a) => ({ n: a.n, passed: a.passed, total: a.total, elapsed_s: a.elapsed_s, fail_code: a.fail_code || null })),
        tool_calls: r.tool_calls || 0, tool_errors: r.tool_errors || 0,
        judge: r.judge ? (r.judge.dims ? { passed: r.judge.passed, total: r.judge.total } : (r.judge.score ? { score: r.judge.score, verdict: r.judge.verdict || "" } : null)) : null,
        human: r.human || null,
        failed: (r.checks || []).filter((c) => !c.ok).map((c) => c.name),
      };
    }),
  };
}
function evalHistory(limit = 20) {
  const out = [];
  try {
    const root = dataPath("eval", "runs");
    for (const d of fs.readdirSync(root).sort().reverse()) {
      const j = store.readJson(path.join(root, d, "results.json"), null);
      if (j) out.push({ dir: d, ...evalSummaryBrief(j) });
      if (out.length >= limit) break;
    }
  } catch {}
  return out;
}
app.post("/api/eval/start", (req, res) => {
  if (evalState.running) return res.status(409).json({ error: "已有一轮评测在跑，等它结束" });
  const model = String((req.body || {}).model || config.active_model);
  if (!(config.models || []).some((m) => m.name === model)) return res.status(400).json({ error: `模型「${model}」不在列表里` });
  const args = [appPath("eval", "run.js"), "--model", model];
  const only = String((req.body || {}).task || "").trim();
  if (only) args.push("--task", only);
  const judge = String((req.body || {}).judge || "").trim();
  if (judge && !(config.models || []).some((m) => m.name === judge)) return res.status(400).json({ error: `评委模型「${judge}」不在列表里` });
  if (judge) args.push("--judge", judge);
  const repeat = Math.max(1, Math.min(5, Math.round(+(req.body || {}).repeat) || 1));
  if (repeat > 1) args.push("--repeat", String(repeat));
  evalState.running = true; evalState.lines = []; evalState.startedAt = Date.now(); evalState.model = model; evalState.exit = null;
  const child = require("child_process").spawn(process.execPath, args, {
    cwd: appPath(),
    env: { ...process.env, KYLINWORK_HOME: DATA_DIR, ELECTRON_RUN_AS_NODE: "1" }, // execPath 是 Electron，不加就弹新应用实例
  });
  let buf = "";
  const onData = (d) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trimEnd(); buf = buf.slice(i + 1);
      if (line) { evalState.lines.push(line); if (evalState.lines.length > 400) evalState.lines.shift(); }
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("close", (code) => { evalState.running = false; evalState.exit = code; });
  child.on("error", (e) => { evalState.running = false; evalState.exit = -1; evalState.lines.push("评测进程启动失败: " + e.message); });
  res.json({ ok: true, model });
});
app.get("/api/eval/status", (_req, res) => {
  res.json({ running: evalState.running, model: evalState.model, startedAt: evalState.startedAt, exit: evalState.exit, lines: evalState.lines });
});
app.get("/api/eval/history", (_req, res) => {
  const bl = store.readJson(dataPath("eval", "baseline.json"), null);
  res.json({ runs: evalHistory(), baseline: bl ? { at: bl.at, commit: bl.commit || "", model: bl.model || "", source_dir: bl.source_dir || "" } : null });
});
// 钉基线：把某次跑批的各题通过率写进 eval/baseline.json，之后每次跑批自动逐题对比、退步点名
app.post("/api/eval/baseline", (req, res) => {
  const dir = String((req.body || {}).dir || "");
  if (!/^[\w.-]+$/.test(dir)) return res.status(400).json({ error: "目录名不合法" });
  const j = store.readJson(dataPath("eval", "runs", dir, "results.json"), null);
  if (!j) return res.status(404).json({ error: "没有这次评测的记录" });
  const bl = {
    at: j.at, commit: j.commit || "", model: j.model, repeat: j.repeat || 1,
    pass1_avg: j.pass1_avg != null ? j.pass1_avg : (j.tasks ? Math.round((j.full_pass / j.tasks) * 100) : 0),
    score_pct: j.score_pct, source_dir: dir,
    tasks: Object.fromEntries((j.results || []).map((r) => {
      const k = r.k || 1;
      const passes = r.passes != null ? r.passes : (r.passed === r.total ? 1 : 0);
      return [r.id, { pass_rate: r.pass_rate != null ? r.pass_rate : +(passes / k).toFixed(3) }];
    })),
  };
  fs.mkdirSync(dataPath("eval"), { recursive: true });
  fs.writeFileSync(dataPath("eval", "baseline.json"), JSON.stringify(bl, null, 2));
  res.json({ ok: true, baseline: { at: bl.at, commit: bl.commit, model: bl.model, source_dir: dir } });
});
// 单次评测完整明细：每题 checks、AI 评委理由、人工分、最终回复摘录、产物清单
app.get("/api/eval/run/:dir", (req, res) => {
  const dir = String(req.params.dir || "");
  if (!/^[\w.-]+$/.test(dir)) return res.status(400).json({ error: "目录名不合法" });
  const j = store.readJson(dataPath("eval", "runs", dir, "results.json"), null);
  if (!j) return res.status(404).json({ error: "没有这次评测的记录" });
  res.json({ dir, ...j });
});
// 人工打分：写回该次评测的 results.json，与机器分 / AI 评委分并列保存，互不覆盖
app.post("/api/eval/human", (req, res) => {
  const b = req.body || {};
  const dir = String(b.dir || "");
  if (!/^[\w.-]+$/.test(dir)) return res.status(400).json({ error: "目录名不合法" });
  const file = dataPath("eval", "runs", dir, "results.json");
  const j = store.readJson(file, null);
  if (!j) return res.status(404).json({ error: "没有这次评测的记录" });
  const r = (j.results || []).find((x) => x.id === String(b.task_id || ""));
  if (!r) return res.status(404).json({ error: "没有这道题" });
  const score = Math.round(+b.score);
  if (!(score >= 1 && score <= 5)) return res.status(400).json({ error: "分数须是 1-5 的整数" });
  r.human = { score, comment: String(b.comment || "").slice(0, 500), by: req.user ? req.user.username : "", at: new Date().toISOString() };
  const scored = (j.results || []).filter((x) => x.human && x.human.score);
  j.human = { scored: scored.length, avg: +(scored.reduce((s, x) => s + x.human.score, 0) / scored.length).toFixed(2) };
  fs.writeFileSync(file, JSON.stringify(j, null, 2));
  res.json({ ok: true, task_id: r.id, human: j.human });
});

// 给单个对话指定模型（null = 跟随全局默认）。只影响这一个对话，不动全局 active_model
app.post("/api/session/:id/model", (req, res) => {
  const name = (req.body || {}).model;
  const rawId = (req.body || {}).model_id;
  const s = getSession(req.params.id);
  if (name === null || name === undefined || name === "") {
    delete s.model;
    delete s.model_id;
  } else {
    const ch = modelCfg.findChannel(config, name);
    if (!ch) return res.status(400).json({ error: `模型「${name}」不在模型列表里` });
    const id = modelCfg.pickModelId(ch, rawId);
    s.model = String(name);
    s.model_id = id;
    // 记住这次手动选择：开了「新对话沿用上次选的模型」时，下个新对话默认就用它
    if (config.last_picked_model !== s.model || config.last_picked_model_id !== id) {
      config.last_picked_model = s.model;
      config.last_picked_model_id = id;
      saveConfig();
    }
  }
  saveSession(req.params.id);
  res.json({ ok: true, model: s.model || null, model_id: s.model_id || null });
});

// 助理模式没有会话 id（消息走 IM 的 local 通道），模型选择只能挂在配置上：选完就存，
// 刷新页面、离开助理页再回来都还是它。不存的话标签会自己弹回全局默认，
// 而下面真正跑任务用的又是标签上那个——那就成了另一种「标签说一套、实际跑一套」
app.post("/api/assist/model", (req, res) => {
  const name = (req.body || {}).model;
  const rawId = (req.body || {}).model_id;
  if (name === null || name === undefined || name === "") {
    delete config.assist_model;
    delete config.assist_model_id;
  } else {
    const ch = modelCfg.findChannel(config, name);
    if (!ch) return res.status(400).json({ error: `模型「${name}」不在模型列表里` });
    config.assist_model = String(name);
    config.assist_model_id = modelCfg.pickModelId(ch, rawId);
  }
  saveConfig();
  res.json({ ok: true, model: config.assist_model || null, model_id: config.assist_model_id || null });
});

// 删除会话（内存 + 磁盘一起删）
app.delete("/api/session/:id", (req, res) => {
  sessions.delete(req.params.id);
  try { fs.unlinkSync(sessFile(req.params.id)); } catch {}
  res.json({ ok: true });
});

// 停止正在运行的任务：中断当前模型调用，agent 循环在下一个检查点收尾
app.post("/api/chat/stop", (req, res) => {
  const run = activeRuns.get((req.body || {}).sessionId);
  if (!run) return res.json({ ok: false, error: "该会话没有正在运行的任务" });
  run.ctrl.abort();
  res.json({ ok: true });
});

let scheduler;

// ---------- 定时任务管理 API ----------
// 路由本体在 engine/api/schedules.js。scheduler 是 main() 里才建的（晚绑定），
// 所以传一个 getter 过去，不在那边 require。
app.use(createSchedulesRouter({ getScheduler: () => scheduler }));

/** 给 IM / 定时任务的 runtime 包一层记账：消耗记到管理员（首个用户）名下，开了积分闸门才在 0 分时拒跑 */
function accountedRuntime(baseRuntime, source) {
  return {
    ...baseRuntime,
    runTask: async (args) => {
      const owner = account.defaultUser();
      if (owner && account.creditsEnabled() && owner.credits <= 0) {
        throw new Error("积分不足：管理员可以在 Web 端「账号 · 用量」里充值，或者把「积分限额」关掉");
      }
      // 调用方（助理页）指定了模型就解析成真正的 LLM 顶上去。模型名不在列表里时 llmForSession
      // 返回的是会报错的桩，宁可当场报错也不许悄悄退回全局默认
      const { modelName, modelId, ...rest } = args || {};
      const runLLM = modelName ? llmForSession({ model: modelName, model_id: modelId }) : llm;
      // IM / 定时任务没有登录态，记忆按管理员算（和积分记账口径保持一致）
      const r = await baseRuntime.runTask({
        user: owner ? owner.username : undefined,
        taskLabel: source === "im" ? "IM 对话" : source === "schedule" ? "定时任务" : source,
        // IM / 定时任务的产物也各归各的文件夹（仅默认工作空间；调用方可在 args 里覆盖）
        baseDir:
          path.resolve(getWorkspaceDir()) === dataPath("workspace")
            ? source === "im" ? "IM_对话" : source === "schedule" ? "定时任务" : null
            : null,
        projectContext: projectContextOf(activeProject()),
        ...rest,
        ...(modelName ? { llmOverride: runLLM } : {}),
      });
      if (owner && r && r.usage && r.usage.calls > 0) {
        account.chargeRun(owner, { ...r.usage, model: runLLM.model, provider: runLLM.provider, source });
      }
      return r;
    },
  };
}

async function main() {
  // config.json 里配的 + Agent Plugins 插件 mcp.json 里声明的，一起起。
  // 插件那边坏一条只跳过一条（规范要求的失败隔离），不影响 config 里的服务器。
  let pluginServers = [];
  try {
    pluginServers = pluginsMgr.pluginMcpServers();
  } catch (e) {
    console.warn("[插件] MCP 配置读取失败:", e.message);
  }
  // MCP 连接不挡启动：窗口秒开，连接器在后台就绪（agent 每次跑任务都是现取 toolDefs，
  // 晚几秒连上也不丢工具）。首个定时 tick 在 +20s，届时早已连完。
  mcpManager
    .startAll([...(config.mcp_servers || []), ...pluginServers])
    .then(() => console.log(`MCP 工具就绪: ${mcpManager.toolDefs().length} 个`))
    .catch((e) => console.warn("[MCP] 启动失败:", e.message));
  const badPlugins = pluginsMgr.loadPlugins().filter((p) => !p.ok);
  for (const p of badPlugins) console.warn(`[插件] ${p.name} 装不上: ${p.error}`);
  runtime = createAgentRuntime({ config, llm, mcpManager, experts, expertTeams });

  const scheduleRuntime = accountedRuntime(runtime, "schedule");
  scheduler = createScheduler({
    runtime: scheduleRuntime,
    // 每次执行开一条真正的会话，运行记录里带上它的 id —— 前端据此把定时任务
    // 也列进左侧任务列表（见 scheduler.js 的 startSession）
    startSession: (args) => startScheduleSession({ ...args, runtime: scheduleRuntime }),
    onResult: (item, text) =>
      notify.pushBots(config, `【KylinWork·定时任务】${item.name}\n${(text || "").slice(0, 800)}`),
  });
  // 让调度器认识「工作空间名字 → 目录」：随时手动建的任务、AI 用 create_schedule 建的任务，
  // 都能按名字选工作空间，不必让用户去填绝对路径
  setWorkspaceResolver((v) => {
    const s = String(v || "").trim();
    if (!s) return "";
    if (path.isAbsolute(s)) return s;
    ensureProjects();
    const p = (config.projects || []).find((x) => x.name === s);
    if (!p) {
      throw new Error(`没有名为「${s}」的工作空间。可用的：${(config.projects || []).map((x) => x.name).join("、") || "（暂无）"}；也可以直接填绝对路径`);
    }
    return p.dir;
  });
  // AI 的 create_schedule 工具晚绑定到这台调度器上
  setActiveScheduler(scheduler);

  // 夜间复盘：**默认关**。开了之后每 10 分钟看一次表，到点且今天还没跑过就跑一轮。
  // 它只生成提案，永远不会自己改提示词——第二天早上你在 设置→自进化 里决定要不要。
  let evolveLastDay = "";
  setInterval(async () => {
    const ev = config.evolve || {};
    if (!ev.auto) return;
    const d = new Date();
    const day = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    if (d.getHours() !== (ev.hour === undefined ? 3 : ev.hour) || evolveLastDay === day) return;
    evolveLastDay = day;
    try {
      const r = await evolve.runReview({ llm, days: ev.days || evolve.CAPS.window });
      evolve.recordRun({ ok: true, trigger: "夜间", turns: r.mined.turns, added: (r.added || []).length, gated: (r.gated || []).length, notes: r.notes || [] });
      if ((r.added || []).length) {
        notify.pushBots(config, `【KylinWork·自进化】昨夜复盘：${r.mined.turns} 个回合，${r.added.length} 条改进提案等你审（设置→自进化）`);
      }
    } catch (e) {
      // 后台飞轮吞掉异常，等于这条链早就停了而你还以为它在转。成败都落一行，界面上看得见
      try { evolve.recordRun({ ok: false, trigger: "夜间", error: e.message }); } catch {}
      console.warn("[自进化] 夜间复盘失败:", e.message);
    }
  }, 10 * 60 * 1000);

  // IM 远程指挥路由（飞书/QQ 长连接 · 企业微信与公众号回调 · 通用 webhook）
  imBridge = createImRouter({ config, runtime: accountedRuntime(runtime, "im"), sessions: imSessions, outputFiles, saveConfig });
  app.use(imBridge.router);
  imBridge
    .startFeishuWs()
    .then((s) => { if (s.state !== "off") console.log(`飞书长连接: ${s.state}`); })
    .catch((e) => console.warn("[飞书] 长连接启动失败:", e.message));
  imBridge
    .startQQ()
    .then((s) => { if (s.configured) console.log(`QQ 长连接: ${s.state}`); })
    .catch((e) => console.warn("[QQ] 长连接启动失败:", e.message));
  imBridge
    .startIlink()
    .then((s) => { if (s.configured) console.log(`微信 iLink 长轮询: ${s.state}`); })
    .catch((e) => console.warn("[微信iLink] 长轮询启动失败:", e.message));

  // 兜底：任何路由里没接住的异常都变成 JSON，别甩一整页 HTML 堆栈给前端
  // （前端一律 r.json()，甩 HTML 的话界面只会显示「加载失败」，真正的原因谁也看不见）
  app.use((err, req, res, next) => {
    console.error(`[${req.method} ${req.path}]`, err.message);
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: err.message || "服务器内部错误" });
  });

  sweepInterruptedRuns(); // 上次没善终的任务先标注中断，再开门迎客

  const port = +process.env.PORT || config.server.port || 3800;
  // 默认只听本机：这个进程手里有 run_shell 和整个文件系统，绑 0.0.0.0 等于把 shell 挂到公网。
  // 要放出去（Docker / 服务器）必须显式 HOST=0.0.0.0，并且自己在前面套 HTTPS + 反代。
  const host = process.env.HOST || config.server.host || "127.0.0.1";
  const server = app.listen(port, host, () => {
    if (host !== "127.0.0.1" && host !== "localhost") {
      console.warn(`⚠️  正在监听 ${host}:${port}（非本机）。请确认前面有反向代理 + HTTPS，且已经注册了管理员账号——否则任何人都能拿到这台机器的 shell。`);
    }
    console.log(`KylinWork 已启动: http://localhost:${port}（服务端初始化 ${Date.now() - BOOT_T0}ms）`);
    // 连错环境是要命的事（在测试环境测出来的结论写到生产里），所以启动时把环境喊出来
    console.log(
      proxy.TARGET
        ? `云端平台: ${proxy.ENV_NAME} → ${proxy.TARGET}`
        : "云端平台: 未配置（本地功能不受影响；要启用登录/模型广场/技能市场，见 config.example.json 的 environment 段）"
    );
    console.log(`模型: ${llm.provider} / ${llm.model}`);
    console.log(`技能: ${runtime.getSkills().map((s) => s.name).join(", ") || "无"}`);
    console.log(`专家团: ${experts.map((e) => e.name).join(", ") || "无"}`);
    console.log(`MCP 工具: ${mcpManager.toolDefs().length} 个`);
    const okPlugins = pluginsMgr.loadPlugins().filter((p) => p.ok);
    if (okPlugins.length) console.log(`Agent Plugins: ${okPlugins.map((p) => p.name).join(", ")}`);
    console.log(`工作目录: ${getWorkspaceDir()}`);
  });
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error(`端口 ${port} 已被占用（可能 Web 版已在运行），本进程不再重复启动服务，窗口将连接已运行的实例。`);
    } else {
      throw e;
    }
  });
}

process.on("SIGINT", () => {
  mcpManager.stopAll();
  process.exit(0);
});

main().catch((e) => {
  console.error("启动失败:", e);
  process.exit(1);
});
