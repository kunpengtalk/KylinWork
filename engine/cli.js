#!/usr/bin/env node
"use strict";
/**
 * KylinWork CLI — 终端里直接跑 agent 任务，与 Web/IM 共用同一套运行时与配置。
 *
 * 用法：
 *   node cli.js "帮我调研xxx并写成报告"       # 单发任务，跑完即退出
 *   node cli.js                              # 交互式 REPL（连续对话，保留上下文）
 *   node cli.js -c                           # 接着最近的会话继续聊（--continue）
 *   node cli.js -r                           # 列出历史会话，挑一个续接（--resume）
 *   node cli.js --mode ask "这个报错什么意思"
 *   node cli.js --session s_xxx "接着上次做" # 续接指定会话（data/sessions/<id>.json）
 *   node cli.js --no-mcp "..."               # 跳过 MCP 连接，启动更快
 *
 * 交互模式内建命令：/help /mode /new /files /sessions /resume /compact /cost /model /exit
 * npm link 后可直接用 `wb "任务"`。
 */

const fs = require("fs");
const path = require("path");
const { dataPath, preferData, allocateRunDir } = require("./paths");
const readline = require("readline");
const { createLLM } = require("./llm");
const { setWorkspaceDir, getWorkspaceDir } = require("./tools");
const { McpManager } = require("./mcp");
const { createAgentRuntime } = require("./agent");
const account = require("./account");
const store = require("./store");

const VERSION = require(path.join(__dirname, "..", "package.json")).version || "0.0.0";

// 内置 AI 引擎（pi）要求 Node ≥22.19。CLI 直接跑在本机 Node 上，版本不够就明确说出来，
// 别让用户在"模块加载失败/流式输出乱码"上瞎猜
(function assertNodeVersion() {
  const [maj, min] = String(process.versions.node).split(".").map(Number);
  if (maj > 22 || (maj === 22 && min >= 19)) return;
  console.error(
    `\n[环境] 本机 Node ${process.versions.node} 低于 KylinWork 要求的 22.19（内置 AI 引擎 pi 的硬性要求）。\n` +
      `  解法二选一：① 升级本机 Node 到 22.19 以上；② 用桌面版 npm run app —— 它自带运行时，不依赖本机 Node。\n`
  );
  process.exit(1);
})();

// ---------- 参数解析 ----------
const argv = process.argv.slice(2);
const opts = { mode: "craft", session: null, mcp: true, cont: false, resume: null };
const words = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--mode") opts.mode = argv[++i] || "craft";
  else if (a === "--session") opts.session = argv[++i] || null;
  else if (a === "--no-mcp") opts.mcp = false;
  else if (a === "-c" || a === "--continue") opts.cont = true;
  else if (a === "-r" || a === "--resume") {
    const nxt = argv[i + 1];
    if (nxt && !nxt.startsWith("-")) { opts.resume = nxt; i++; } else opts.resume = true;
  } else if (a === "-v" || a === "--version") { console.log(`KylinWork CLI v${VERSION}`); process.exit(0); }
  else if (a === "-h" || a === "--help") { printHelp(); process.exit(0); }
  else words.push(a);
}
const oneShot = words.join(" ").trim();

function printHelp() {
  console.log(`KylinWork CLI v${VERSION} — 终端 Agent（命令行交互）
用法：
  wb "任务描述"         单发任务
  wb                    交互式对话（/help 看内置命令）
  wb -c                 接着最近的会话继续聊
  wb -r [会话id]        挑一个历史会话续接（不给 id 则列出可选）
选项：
  --mode craft|plan|ask 执行模式（默认 craft）
  --session <id>        续接指定会话
  --no-mcp              跳过 MCP 连接器，启动更快
  -v, --version         显示版本`);
}

// ---------- 终端着色（非 TTY 时输出纯文本） ----------
const tty = process.stdout.isTTY && process.stdin.isTTY;
const dim = (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const yellow = (s) => (tty ? `\x1b[33m${s}\x1b[0m` : s);
const red = (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s);
const green = (s) => (tty ? `\x1b[32m${s}\x1b[0m` : s);
const cyan = (s) => (tty ? `\x1b[36m${s}\x1b[0m` : s);
const bold = (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s);

// ---------- 配置与运行时（与 engine/index.js 同源） ----------
const CONFIG_PATH = dataPath("config.json");
if (!fs.existsSync(CONFIG_PATH)) {
  console.error(red("找不到 config.json，请先运行一次 npm start 生成，或从 config.example.json 复制。"));
  process.exit(1);
}
const config = store.readJson(CONFIG_PATH, {});
if (config.workspace_dir) {
  try { setWorkspaceDir(config.workspace_dir); } catch {}
}
const llm = createLLM(config);
const expertsDoc = store.readJson(preferData("experts.json"), {}) || {};
let experts = expertsDoc.experts || [];
let expertTeams = expertsDoc.teams || [];
const mcpManager = new McpManager();

// ---------- 会话持久化（与 engine/index.js 同一目录同一结构） ----------
const SESS_DIR = dataPath("data", "sessions");
let sessionId = opts.session || "cli_" + new Date().toISOString().slice(0, 10).replace(/-/g, "");
let sessFile = path.join(SESS_DIR, sessionId.replace(/[^\w-]/g, "_") + ".json");
let sess = store.readJson(sessFile, { history: [], transcript: [], title: "" });
function saveSess() {
  sess.updated_at = new Date().toISOString();
  store.writeJsonAtomic(sessFile, sess);
}
// /cost 用的本进程累计用量（sess.transcript 里是历史轮次的，这里记"这一趟聊了多少"）
const sessionUsage = { prompt: 0, completion: 0, cached: 0, calls: 0 };

function loadSession(id) {
  if (!id) return false;
  const safe = String(id).replace(/[^\w-]/g, "_");
  const file = path.join(SESS_DIR, safe + ".json");
  if (!fs.existsSync(file)) return false;
  const loaded = store.readJson(file, { history: [], transcript: [], title: "" });
  if (!loaded || !Array.isArray(loaded.history)) return false;
  sess = loaded;
  sessionId = safe;
  sessFile = file;
  return true;
}

/** 按最后更新时间倒序列出历史会话（最多 limit 条） */
function listSessions(limit = 12) {
  let files = [];
  try {
    files = fs.readdirSync(SESS_DIR).filter((f) => f.endsWith(".json") && !f.endsWith(".bak.json"));
  } catch { return []; }
  const rows = files.map((f) => {
    const file = path.join(SESS_DIR, f);
    let info = {};
    try { info = store.readJson(file, {}); } catch {}
    return {
      id: f.replace(/\.json$/, ""),
      title: String(info.title || "").slice(0, 40),
      updated: String(info.updated_at || ""),
      turns: Array.isArray(info.transcript) ? info.transcript.length : 0,
    };
  });
  rows.sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
  return rows.slice(0, limit);
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return (sameDay ? "" : d.getMonth() + 1 + "月" + d.getDate() + "日 ") + d.toTimeString().slice(0, 5);
}

// ---------- 思考指示器（任务等待期间的转圈，不占日志） ----------
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinner = null;
function spinnerStart(label) {
  if (!tty || spinner) return;
  const t0 = Date.now();
  let i = 0;
  const draw = () => {
    const secs = Math.round((Date.now() - t0) / 1000);
    process.stdout.write(`\r\x1b[2m${SPIN[i++ % SPIN.length]} ${label} ${secs}s\x1b[0m`);
  };
  draw();
  spinner = { timer: setInterval(draw, 150) };
}
function spinnerStop() {
  if (!spinner) return;
  clearInterval(spinner.timer);
  spinner = null;
  process.stdout.write("\r\x1b[K");
}
// 任何输出都在 2 秒安静后重新挂上指示器——"思考中"就是模型在喘气的空隙
let quietTimer = null;
function kickQuiet(st) {
  if (!tty || !st.taskActive) return;
  clearTimeout(quietTimer);
  quietTimer = setTimeout(() => {
    if (st.taskActive && !spinner) spinnerStart(`思考中${st.step ? ` · 第 ${st.step} 步` : ""}`);
  }, 2000);
}

// ---------- 输出原语：先收指示器再写，保证不串行 ----------
function say(s) { spinnerStop(); process.stdout.write(s); }
function sayLine(s) { spinnerStop(); process.stdout.write(s + "\n"); }

// ---------- ask_user 的终端应答（选项菜单 + 自由输入 + 倒计时） ----------
// Agent 问问题时会阻塞在这里等答案；返回 null 表示用户放弃/超时，Agent 按自己的判断继续。
function askInTerminal(question, options, timeoutMs) {
  return new Promise((resolve) => {
    if (!tty) { resolve(null); return; }
    const stdin = process.stdin;
    if (stdin.isTTY) stdin.setRawMode(true);
    process.stdin.resume();
    readline.emitKeypressEvents(stdin);
    let buf = "";
    let settled = false;
    const deadline = Date.now() + Math.max(10000, timeoutMs || 300000);
    const render = () => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      const mm = Math.floor(left / 60);
      const ss = String(left % 60).padStart(2, "0");
      const hint = options.length ? `输入 1-${options.length} 或直接回答，回车跳过（剩 ${mm}:${ss}）` : `直接回答，回车跳过（剩 ${mm}:${ss}）`;
      process.stdout.write(`\r\x1b[K\u001b[2m${hint}\u001b[0m \u001b[36m›\u001b[0m ${buf}`);
    };
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearInterval(ticker);
      stdin.removeListener("keypress", onKey);
      if (stdin.isTTY) stdin.setRawMode(false);
      process.stdout.write("\r\x1b[K");
      resolve(val);
    };
    const onKey = (str, key) => {
      key = key || {};
      if (key.ctrl && key.name === "c") { finish(null); return; } // 放弃提问，Agent 按默认继续
      if (key.name === "return" || key.name === "enter") {
        const v = buf.trim();
        if (!v) { finish(null); return; }
        const n = Number(v);
        if (/^\d+$/.test(v) && n >= 1 && n <= options.length) finish(options[n - 1].label);
        else finish(v);
        return;
      }
      if (key.name === "backspace") { buf = buf.slice(0, -1); render(); return; }
      if (key.ctrl && key.name === "u") { buf = ""; render(); return; }
      if (key.name === "left" || key.name === "right" || key.name === "up" || key.name === "down") return;
      if (str && !/^[\x00-\x1f\x7f]/.test(str)) { buf += str; render(); }
    };
    stdin.on("keypress", onKey);
    const ticker = setInterval(() => {
      if (Date.now() >= deadline) { finish(null); return; }
      render();
    }, 1000);
    render();
  });
}

// ---------- 工具/事件渲染 ----------
const READ_ICON = new Set(["read_file", "list_files", "search_files", "web_search", "fetch_url", "render_page", "library_list", "library_read", "check_page", "look_at_image"]);
const WRITE_ICON = new Set(["write_file", "edit_file", "gen_diagram", "html_to_image", "generate_image", "generate_video", "text_to_speech", "save_skill", "feishu_doc_create", "remember", "forget"]);
const iconFor = (name) => (READ_ICON.has(name) ? "·" : WRITE_ICON.has(name) ? "+" : name === "run_shell" || name === "run_node" ? "⚡" : name.startsWith("delegate") ? "→" : "·");

/** 把参数预览压成一行好读的样子：JSON 取第一个关键字段，命令/代码取首行截断 */
function fmtInput(pv) {
  const s = String(pv || "").trim();
  if (!s) return "";
  if (s[0] === "{") {
    try {
      const o = JSON.parse(s);
      for (const k of ["path", "url", "query", "dir", "name", "title", "keyword"]) {
        if (o[k] != null) return `${k} ${String(o[k]).slice(0, 120)}`;
      }
      const v = Object.values(o)[0];
      if (v != null) return String(v).slice(0, 120);
    } catch {}
  }
  return s.length > 140 ? s.slice(0, 140) + "…" : s;
}

function renderDiff(diff) {
  for (const e of diff) {
    if (e.op === "+") say(green("  + " + e.text) + "\n");
    else if (e.op === "-") say(red("  - " + e.text) + "\n");
    else say(dim("    " + e.text) + "\n");
  }
}

function renderAskBox(question, options) {
  sayLine(yellow("  ┌─ 需要你拍板 ─────────────────────────────────────"));
  for (const w of String(question || "").split("\n")) sayLine(`  │ ${w}`);
  options.forEach((o, i) => {
    sayLine(`  │   ${cyan(String(i + 1))} ${o.label}${o.detail ? dim(" — " + o.detail) : ""}`);
  });
  sayLine(yellow("  └───────────────────────────────────────────────────"));
}

function makeEmit(st) {
  return (ev) => {
    kickQuiet(st);
    if (ev.type === "text") {
      if (ev.depth > 0) return;
      say(ev.delta);
    } else if (ev.type === "tool_use") {
      const who = ev.expert ? `${ev.expert} · ` : "";
      const pv = fmtInput(ev.input_preview || ev.purpose || "");
      st.lastToolId = ev.id;
      if (pv) sayLine(`  ${dim(iconFor(ev.name))} ${cyan(who + ev.name)} ${dim(pv)}`);
      else sayLine(`  ${dim(iconFor(ev.name))} ${cyan(who + ev.name)}`);
    } else if (ev.type === "tool_result") {
      // 并发工具的结果返回顺序不定，不能闭眼贴到最后一行——先确认还是它
      if (ev.id && st.lastToolId !== ev.id) sayLine(`  ${dim("·")} ${cyan(ev.name)}`);
      st.lastToolId = null;
      const head = String(ev.preview || "").split("\n")[0].slice(0, 140);
      if (ev.isError) sayLine(`  ${red("✗")}${head ? dim(" " + head) : ""}`);
      else say(`  ${green("✓")}${head ? dim(" " + head) : ""}\n`);
      if (tty && ev.diff && Array.isArray(ev.diff) && ev.diff.length) renderDiff(ev.diff);
    } else if (ev.type === "parallel") {
      sayLine(dim(`  ⚡ ${ev.count} 个只读工具并发执行`));
    } else if (ev.type === "ask_user") {
      renderAskBox(ev.question, ev.options || []);
    } else if (ev.type === "ask_answer") {
      if (ev.timeout) sayLine(dim("  └ 超时未答，按 Agent 判断继续"));
      else sayLine(dim(`  └ 你的回答：${String(ev.answer)}`));
    } else if (ev.type === "interject") {
      sayLine(dim(`  ✎ 你插话：${String(ev.text).slice(0, 120)}`));
    } else if (ev.type === "status") {
      sayLine(dim(`  ⚠ ${ev.text}`));
    } else if (ev.type === "limit") {
      sayLine(yellow(`  ⏱ ${ev.note}，任务强制收尾`));
    } else if (ev.type === "failover") {
      sayLine(yellow(`  ⟳ ${ev.note}`));
    } else if (ev.type === "sleep") {
      sayLine(dim(`  💤 ${ev.note}`));
    } else if (ev.type === "compact") {
      sayLine(dim(`  🧹 上下文已自动压缩（${ev.removed} 条更早内容 → 1 条摘要）`));
    } else if (ev.type === "trim") {
      sayLine(dim(`  ✂ 上下文超预算已截断`));
    } else if (ev.type === "auto_continue") {
      sayLine(yellow(`  ↻ ${ev.note}`));
    } else if (ev.type === "milestones") {
      const items = ev.items || [];
      if (items.length) {
        const done = items.filter((m) => m.done).length;
        sayLine(dim(`  ☑ ${ev.file}：${done}/${items.length} 步完成`));
      }
    } else if (ev.type === "expert_start") {
      sayLine(yellow(`  👥 委派专家「${ev.expert}」` + (ev.team ? `（${ev.team} 团）` : "")) + dim(` ${String(ev.task || "").slice(0, 80)}`));
    } else if (ev.type === "expert_done") {
      sayLine(dim(`  ✅ 专家「${ev.expert}」完成`));
    } else if (ev.type === "team_start") {
      sayLine(yellow(`  👥 专家团「${ev.team}」接力开工`));
    } else if (ev.type === "team_done") {
      sayLine(dim(`  ✅ 专家团「${ev.team}」完成`));
    } else if (ev.type === "step_start") {
      st.step = ev.step;
      if (st.step === 1) kickQuiet(st); // 第一步不用额外输出，Agent 会先说话或直接上工具
    } else if (ev.type === "usage") {
      st.usage = ev;
      sessionUsage.prompt += ev.prompt || 0;
      sessionUsage.completion += ev.completion || 0;
      sessionUsage.cached = (sessionUsage.cached || 0) + (ev.cached || 0);
      sessionUsage.calls += ev.calls || 0;
    } else if (ev.type === "files") {
      st.files = ev.files || st.files;
    }
    // sources 是给网页端「来源」卡片用的，终端不刷屏
  };
}

function printSummary(st) {
  say("\n");
  if (st.usage) {
    const u = st.usage;
    const secs = Math.round((u.elapsed_ms || 0) / 1000);
    sayLine(dim(`✧ 本次 ${(u.prompt + u.completion).toLocaleString()} tokens（入 ${u.prompt.toLocaleString()} / 出 ${u.completion.toLocaleString()}${u.cached ? `，缓存 ${u.cached.toLocaleString()}` : ""}）· ${u.calls} 次调用 · ${secs}s · ${u.provider}（${u.model}）`));
  }
  if (st.credits && st.credits.spent > 0) {
    sayLine(dim(`✦ 本次扣 ${st.credits.spent} 积分 · 余额 ${st.credits.balance.toLocaleString()}`));
  }
  if (st.files && st.files.length) {
    // files 里的名字是相对工作区的路径（含成果子目录前缀），提示语跟着指到真正落盘的地方
    sayLine(dim(`📁 成果目录 ${sess.dir ? path.join(getWorkspaceDir(), sess.dir) : getWorkspaceDir()}：`) + st.files.slice(0, 8).map((f) => f.name).join("、"));
  }
  say("\n");
}

// ---------- 执行一轮任务（Ctrl+C 停止当前任务而不是直接退出） ----------
async function runOnce(runtime, text, mode) {
  // 积分闸门：默认是关的（本地个人用不限额），开了才拦。CLI 消耗记在管理员（首个注册用户）名下
  const owner = account.defaultUser();
  if (owner && account.creditsEnabled() && owner.credits <= 0) {
    console.error(red(`积分不足（${owner.username} 余额 0）：去 Web 端「账号 · 用量」里充值，或者把「积分限额」关掉。`));
    return;
  }
  if (sess.title === "" || sess.history.length === 0) sess.title = text.slice(0, 24);
  // CLI 会话也一个会话一个成果目录（CLI_月日_标题），跟 Web 对话同一套规矩：
  // 不然命令行跑出来的东西全堆工作区根目录，过两天谁也说不清哪个文件是哪次跑的。
  // 挂在 sess 上持久化，/resume 续接同一会话时继续落同一个文件夹（与 Web 的 sess.dir 同字段）
  if (!sess.dir && path.resolve(getWorkspaceDir()) === dataPath("workspace")) {
    sess.dir = allocateRunDir(getWorkspaceDir(), "CLI", sess.title);
    saveSess();
  }
  sess.history.push({ role: "user", content: text });
  const st = { streamed: false, usage: null, files: null, step: 0, taskActive: true };
  const emit = makeEmit(st);
  const ctrl = new AbortController();
  const onSigint = () => {
    spinnerStop();
    sayLine(yellow("（收到 Ctrl+C，正在停止任务…再按一次强制退出）"));
    ctrl.abort();
    process.once("SIGINT", () => process.exit(130));
  };
  process.once("SIGINT", onSigint);
  let finalText = "";
  try {
    // ask_user 在终端里直接弹可交互的选项——这是"终端 Agent"体验的核心，别让问题在
    // 无人值守的默认值里悄悄过去
    const askUser = async ({ question, options, timeoutMs }) =>
      askInTerminal(question, options || [], timeoutMs);
    const r = await runtime.runTask({
      history: sess.history,
      baseDir: sess.dir,
      emit,
      mode: ["ask", "plan", "craft"].includes(mode) ? mode : "craft",
      user: owner ? owner.username : undefined, // 记忆按人取，命令行走管理员这本账
      stopSignal: ctrl.signal,
      askUser,
    });
    finalText = r.finalText || "";
  } catch (e) {
    sayLine(red(`\n出错了：${e.message}`));
  }
  st.taskActive = false;
  clearTimeout(quietTimer);
  spinnerStop();
  process.removeListener("SIGINT", onSigint);
  // 落盘：Web 端打开该会话也能回放（最终文本 + 用量）
  sess.transcript.push({ type: "user", text, mode });
  const events = [];
  if (finalText) events.push({ type: "text", delta: finalText });
  if (st.usage) events.push(st.usage);
  sess.transcript.push({ type: "assistant", events });
  saveSess();
  // 记账：与 Web 端同一本账（data/usage.json）
  if (owner && st.usage && st.usage.calls > 0) {
    const spent = account.chargeRun(owner, { ...st.usage, source: "cli", sessionId });
    st.credits = { spent, balance: owner.credits };
  }
  printSummary(st);
}

// ---------- 会话选择（-r/--resume） ----------
function pickSessionInteractively() {
  console.log(bold("历史会话（按更新时间倒序）："));
  const rows = listSessions(15);
  if (!rows.length) { console.log(dim("（还没有可续接的会话）")); return null; }
  rows.forEach((r, i) => {
    const cur = r.id === sessionId ? " ←" : "";
    console.log(`  ${cyan(String(i + 1).padStart(2, " "))}  ${r.title || "(无标题)"}${dim(` · ${r.turns} 轮 · ${fmtTime(r.updated)}${cur}`)}`);
  });
  console.log(dim("输入序号续接，空回车返回："));
  // 简单的行选择即可，不需要完整 raw 交互
  return new Promise((ok) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("> ", (ans) => {
      rl.close();
      const n = Number((ans || "").trim());
      if (/^\d+$/.test((ans || "").trim()) && n >= 1 && n <= rows.length) ok(rows[n - 1].id);
      else ok(null);
    });
  });
}

// ---------- 主流程 ----------
if (require.main === module) {
(async () => {
  if (!oneShot && !process.stdin.isTTY) { printHelp(); process.exit(1); }
  if (opts.mcp && (config.mcp_servers || []).length) {
    process.stdout.write(dim(`连接 MCP（${config.mcp_servers.length} 个，--no-mcp 可跳过）… `));
    try {
      await mcpManager.startAll(config.mcp_servers);
      console.log(dim(`${mcpManager.toolDefs().length} 个工具`));
    } catch (e) {
      console.log(red(`连接失败：${e.message}`));
    }
  }
  const runtime = createAgentRuntime({ config, llm, mcpManager, experts, expertTeams });

  // 会话续接：-c 取最近一条；-r 不带参数先列出来挑；-r <id> 直接续
  let resumedFrom = null;
  if (opts.resume && typeof opts.resume === "string") {
    resumedFrom = opts.resume;
    if (!loadSession(opts.resume)) { console.log(red(`会话不存在：${opts.resume}`)); opts.resume = null; }
  }
  if (opts.cont && !opts.resume) {
    const latest = listSessions(1)[0];
    if (latest) { resumedFrom = latest.id; loadSession(latest.id); }
  }

  console.log(bold(`KylinWork Agent · v${VERSION}`));
  console.log(dim(`模型 ${llm.provider}（${llm.model}）· 模式 ${opts.mode} · 工作目录 ${getWorkspaceDir()}`));
  if (resumedFrom) console.log(dim(`⇄ 会话 ${resumedFrom} 续接自 ${fmtTime(sess.updated_at)}（${(sess.transcript || []).length} 轮）`));

  if (oneShot) {
    await runOnce(runtime, oneShot, opts.mode);
    mcpManager.stopAll();
    process.exit(0);
  }

  if (opts.resume === true) {
    const picked = await pickSessionInteractively();
    if (picked) { loadSession(picked); console.log(dim(`⇄ 已切换到会话 ${sessionId}`)); }
  }

  // ---- REPL ----
  console.log(dim("（/help 全部命令 · /mode 切模式 · /new 开新会话 · /sessions 看历史 · /cost 看用量 · /exit 退出）"));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () => new Promise((ok) => rl.question(tty ? `\x1b[36mwb${sessionId !== "cli_" + new Date().toISOString().slice(0, 10).replace(/-/g, "") ? `(${sessionId.slice(0, 5)})` : ""}>\x1b[0m ` : "wb> ", ok));
  for (;;) {
    const line = (await ask()).trim();
    if (!line) continue;
    const [cmd, ...rest] = line.split(/\s+/);
    if (cmd === "/exit" || cmd === "/quit") break;
    if (cmd === "/help") { printHelp(); console.log(dim("交互命令：/mode <craft|plan|ask>  /new  /files  /sessions  /resume <序号|id>  /compact  /cost  /model  /exit")); continue; }
    if (cmd === "/mode") {
      const m = rest[0];
      if (["ask", "plan", "craft"].includes(m)) { opts.mode = m; console.log(dim(`已切到 ${m} 模式`)); }
      else console.log(dim(`当前 ${opts.mode}；用法 /mode craft|plan|ask`));
      continue;
    }
    if (cmd === "/new") {
      // 换到一个全新会话文件，别把今天的日常会话盖掉
      const stamp = new Date().toISOString().replace(/[-T:.Z]/g, "").slice(2, 14);
      const fresh = "cli_" + stamp;
      sess = { history: [], transcript: [], title: "" };
      sessionId = fresh;
      sessFile = path.join(SESS_DIR, fresh + ".json");
      console.log(dim(`上下文已清空，新会话 ${fresh}`));
      continue;
    }
    if (cmd === "/files") {
      try { console.log(fs.readdirSync(getWorkspaceDir()).filter((f) => !f.startsWith(".")).join("\n") || dim("（空）")); } catch {}
      continue;
    }
    if (cmd === "/sessions") {
      const rows = listSessions();
      if (!rows.length) { console.log(dim("（还没有历史会话）")); continue; }
      rows.forEach((r, i) => {
        const cur = r.id === sessionId ? " ←" : "";
        console.log(`  ${cyan(String(i + 1).padStart(2, " "))}  ${r.title || "(无标题)"}${dim(` · ${r.turns} 轮 · ${fmtTime(r.updated)}${cur}`)}`);
      });
      console.log(dim(`用法 /resume <序号> 切过去续聊。`));
      continue;
    }
    if (cmd === "/resume") {
      const arg = rest.join(" ");
      let id = null;
      if (arg) {
        const n = Number(arg);
        if (/^\d+$/.test(arg)) { const rows = listSessions(); const pick = rows[n - 1]; id = pick && pick.id; }
        else id = arg;
      }
      if (!id) { console.log(dim("用法：/resume <会话序号|会话id>，先 /sessions 看列表")); continue; }
      if (loadSession(id)) console.log(dim(`⇄ 已切换到会话 ${sessionId}（${sess.history.length} 条历史，最近更新 ${fmtTime(sess.updated_at)}）`));
      else console.log(red(`会话不存在：${id}`));
      continue;
    }
    if (cmd === "/compact") {
      console.log(dim("压缩会话历史（旧内容归档到 data/compact-archive，历史不足阈值时不做）…"));
      try {
        await runtime.compact(sess.history, {});
        console.log(dim("完成。"));
      } catch (e) {
        console.log(red(`压缩失败：${e.message}`));
      }
      continue;
    }
    if (cmd === "/cost") {
      const u = sessionUsage;
      console.log(dim(`本进程累计：${(u.prompt + u.completion).toLocaleString()} tokens（入 ${u.prompt.toLocaleString()} / 出 ${u.completion.toLocaleString()}）· ${u.calls} 次调用`));
      console.log(dim(`当前会话 ${sessionId}：${(sess.transcript || []).length} 轮 · 最近更新 ${fmtTime(sess.updated_at)}`));
      continue;
    }
    if (cmd === "/model") {
      console.log(`${llm.provider}（${llm.model}）${dim(" · 备用渠道 " + (config.agent && config.agent.failover_model ? config.agent.failover_model : "未配置"))}`);
      continue;
    }
    await runOnce(runtime, line, opts.mode);
  }
  rl.close();
  mcpManager.stopAll();
  process.exit(0);
})();
}

module.exports = { makeEmit, askInTerminal, renderDiff, fmtInput, renderAskBox, listSessions, loadSession, VERSION };
