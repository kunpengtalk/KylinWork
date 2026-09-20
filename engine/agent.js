"use strict";
/**
 * Agent 核心运行时 — 被 Web 界面、IM 接入、专家委派共同复用。
 * 主 Agent 是"协调者"：可直接干活，也可通过 delegate_to_expert 把子任务委派给专家子智能体。
 */

const { TOOL_DEFS, executeTool, outputFiles, getWorkspaceDir } = require("./tools");
const piAdapter = require("./pi-adapter");
const modelCfg = require("./model-config");
const { loadSkills } = require("./skills");
const awake = require("./awake"); // 睡眠治理：任务期间防睡 + 睡了顺延时限
// 定时任务：只用到那个晚绑定的注册表（getActiveScheduler），所以顶层 require 也不会跟
// scheduler → tools 形成环；以前在内联 require 里现取，把模块图藏了起来。
const schedulerRegistry = require("./scheduler");

const DELEGATE_TOOL = {
  name: "delegate_to_expert",
  description:
    "把一个子任务委派给专家团中的一位专家（子智能体）执行，返回该专家的完成汇报。专家与你共享同一个工作目录，它生成的文件你可以直接使用。适合把大任务拆成调研、分析、写作、做PPT等阶段分别委派。",
  input_schema: {
    type: "object",
    properties: {
      expert: { type: "string", description: "专家名称，必须是专家团列表中的一个" },
      task: {
        type: "string",
        description: "子任务描述。要自包含：写清目标、输入（如已有文件名）、期望产出（如文件名）。",
      },
    },
    required: ["expert", "task"],
  },
};

const DELEGATE_TEAM_TOOL = {
  name: "delegate_to_team",
  description:
    "把一个完整任务交给一个专家团（智能体团队）。团里的专家会按名单顺序接力：每位都能看到前面同事的汇报和产出文件，做完交给下一位，最后返回全队的汇报汇总。适合一句话就要走完「调研→分析→成稿→做PPT」整条流水线的任务；只需要一个环节时用 delegate_to_expert 更省时间。",
  input_schema: {
    type: "object",
    properties: {
      team: { type: "string", description: "专家团名称，必须是专家团列表中的一个" },
      task: {
        type: "string",
        description: "交给整个团的任务描述。要自包含：目标、已有输入（文件名）、最终期望交付物。团里每位专家都会看到这段原文。",
      },
    },
    required: ["team", "task"],
  },
};

const ASK_USER_TOOL = {
  name: "ask_user",
  description:
    "向用户提一个关键问题并等待回答（前端会弹出选项卡片，用户点选或输入后你才继续，等待时间不算任务时长）。两类时机要主动用：①开工前——需求含糊到可能白干一场，或风格/范围/平台/受众/篇幅这类选择会让交付物完全不同（典型：封面图是 AI 生图还是 HTML 排版截图、报告交 Word 还是 PDF 还是飞书文档、视频出横版还是竖版），先问一题再动手，比做完返工强；②执行中——要花钱、不可逆动作、覆盖/删除已有内容、对外发布，或只有用户本人知道的偏好（预算/口味/时间安排）。纯技术细节自己定，别拿它当聊天；一次只问一个问题，给 2~4 个具体可点的选项。用户可能不在电脑前：超时没人答就按你认为最合理的默认继续，并在汇报里注明。",
  input_schema: {
    type: "object",
    properties: {
      question: { type: "string", description: "要问的问题，一句话说清，别夹多个问题" },
      options: {
        type: "array",
        description: "2~4 个选项。用户也可以两个都不选、自己输入",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "选项本身，一个短语，20 字以内" },
            detail: { type: "string", description: "选了它会得到什么、代价是什么，一句话。用户就是靠这句做判断的，不许省，也不许只是把 label 换个说法重说一遍" },
          },
          required: ["label", "detail"],
        },
      },
    },
    required: ["question", "options"],
  },
};

const FEISHU_DOC_TOOL = {
  name: "feishu_doc_create",
  description:
    "把 Markdown 内容创建成一篇飞书云文档，直接交付到用户的飞书（复用已配置的飞书机器人凭证）。支持表格（markdown 表格语法）和图片：独占一行的 ![说明](工作目录里的文件或URL) 会真插成文档里的图（SVG 自动转 PNG）——先用 gen_diagram 画图再引用，报告即图文并茂。成功返回文档链接。若因权限不足失败：先把返回的开通指引和链接告诉用户，然后立刻带 wait_for_permission:true 重调本工具——它会自动轮询等用户开通，权限一生效就建好文档继续任务，用户不用回来喊你。",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "文档标题" },
      markdown: {
        type: "string",
        description:
          "文档正文 Markdown。支持标题、列表、引用、代码块、**加粗**、`行内代码`、表格（|a|b|），以及独占一行的图片 ![说明](路径或URL)。",
      },
      wait_for_permission: {
        type: "boolean",
        description: "权限不足时轮询等待用户开通（每 20 秒重试，最多约 10 分钟），开通即自动创建。只在第一次因权限失败、且已把开通指引告诉用户之后用。",
      },
    },
    required: ["title", "markdown"],
  },
};

const USE_SKILL_TOOL = {
  name: "use_skill",
  description: "加载一个技能包的完整内容（操作指南与代码模板）。执行对应类型任务前先加载相关技能。",
  input_schema: {
    type: "object",
    properties: { name: { type: "string", description: "技能名称" } },
    required: ["name"],
  },
};

const CREATE_SCHEDULE_TOOL = {
  name: "create_schedule",
  description:
    "建一个定时任务：到点自动执行一段指令（无人值守跑，用全新会话，产出落在工作空间里，界面上在「自动化」页管理）。时间用 repeat 描述，比 cron 好懂：每 N 分钟 / 每 N 小时 / 每天几点 / 每周几几点 / 每月几号几点 / 只跑一次。默认在当前工作空间里跑；用户明确说要在别的工作空间跑时，把 workspace 填成那个工作空间的名字（可用名字见系统提示里的工作空间列表，也可填绝对路径）。建完把「名称 + 下次运行时间 + 所在工作空间」回报给用户。",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "任务名称，如「每天早上生成日报」" },
      task: { type: "string", description: "到点要执行给 AI 的指令。写清楚产出什么、放哪里——它无人值守，不会有人现场补充说明" },
      workspace: { type: "string", description: "在哪个工作空间里跑：填工作空间名字（推荐）或绝对路径。省略 = 跟随当前工作空间" },
      repeat: {
        type: "object",
        description: "重复规则。按 type 给对应字段",
        properties: {
          type: { type: "string", enum: ["minutes", "hours", "daily", "weekly", "monthly", "once"], description: "minutes=每N分钟；hours=每N小时；daily=每天；weekly=每周几；monthly=每月几号；once=只跑一次（给 at）" },
          every: { type: "integer", description: "minutes：间隔分钟(1-59)；hours：间隔小时(1-24)" },
          hour: { type: "integer", description: "daily/weekly/monthly：几点(0-23)" },
          minute: { type: "integer", description: "hours/daily/weekly/monthly：几分(0-59)" },
          days: { type: "array", items: { type: "integer" }, description: "weekly：星期几，0=周日，1=周一，…，6=周六，可多选" },
          day: { type: "integer", description: "monthly：几号(1-31)" },
          at: { type: "string", description: "once：具体时间，ISO 字符串，如 2026-09-21T15:00:00" },
        },
        required: ["type"],
      },
      cron: { type: "string", description: "可选。老式 5 字段 cron（分 时 日 月 周），只有 repeat 表达不了时才用；给了 repeat 就以 repeat 为准" },
    },
    required: ["task"],
  },
};

const fs = require("fs");
const path = require("path");
const { dataPath } = require("./paths");
const os = require("os");
const memory = require("./memory");
const evolve = require("./evolve");

// ================= 成果核验（治「幻觉执行」） =================
// 模型有时在文本里"表演"跑命令并声称文件已生成，实际一个工具都没调。
// 收尾前核对它声称的产物是否真在磁盘上，不在就打回去要求真实执行。
const CLAIM_RE = /(生成成功|导出成功|保存成功|创建成功|已生成|已保存|已导出|已创建|已写入|生成完毕|制作完成|下载|✅)/;
const DELIVER_EXTS = "pptx|pptm|docx|doc|xlsx|xls|pdf|zip|mp4|mov|png|jpe?g|gif|csv|html|md|svg";

/**
 * 工作目录里所有文件名 → 字节数。一条回复往往声称生成了好几个文件，
 * 一个名字走一遍目录树等于同一棵树扫好几遍，扫一次记下来就够了。
 */
function workspaceIndex() {
  const idx = new Map();
  let root;
  try { root = getWorkspaceDir(); } catch { return idx; }
  const stack = [[root, 0]];
  let visited = 0;
  while (stack.length && visited < 3000) {
    const [dir, d] = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      visited++;
      if (e.isFile()) {
        // 同名文件出现在多个子目录时，非空的那份说了算——否则一个残留的空壳会把真交付判成"空文件"
        if (!idx.has(e.name) || idx.get(e.name) === 0) {
          try { idx.set(e.name, fs.statSync(path.join(dir, e.name)).size); } catch { idx.set(e.name, -1); }
        }
      } else if (e.isDirectory() && d < 4 && e.name !== "node_modules" && !e.name.startsWith(".")) {
        stack.push([path.join(dir, e.name), d + 1]);
      }
    }
  }
  return idx;
}

function sizeOf(p) {
  try { return fs.statSync(p).size; } catch { return -1; }
}

/**
 * 返回 [{ name, why }]：why = "missing"（磁盘上根本没有）或 "empty"（文件在但 0 字节）。
 * 空文件也必须打回——写到一半失败、编码出错都会留下一个 0 字节的壳，
 * 只查存在性的话这种"交付"会被判为成功，用户点开才发现是空的。
 */
function missingDeliverables(text) {
  if (!text || !CLAIM_RE.test(text)) return [];
  const found = new Set();
  const pathRe = new RegExp(`(?:~|\\/(?:Users|home|tmp|private|var))\\/[^\\s"'\`（）()<>|,;：:*?]+\\.(?:${DELIVER_EXTS})\\b`, "gi");
  for (const m of text.match(pathRe) || []) found.add(m);
  const bareRe = new RegExp(`(?:^|[\\s"'\`（(：:、，=])([\\w\\u4e00-\\u9fff().&＆_-]+\\.(?:${DELIVER_EXTS}))\\b`, "gim");
  let mm;
  while ((mm = bareRe.exec(text))) { if (!mm[1].includes("/")) found.add(mm[1]); }
  const bad = [];
  let idx = null;
  for (const p of found) {
    let size;
    if (path.isAbsolute(p)) size = sizeOf(p);
    else if (p.startsWith("~")) size = sizeOf(path.join(os.homedir(), p.slice(1)));
    else {
      if (!idx) idx = workspaceIndex(); // 真有相对文件名要查时才扫目录
      size = idx.has(p) ? idx.get(p) : -1;
    }
    if (size < 0) bad.push({ name: p, why: "missing" });
    else if (size === 0) bad.push({ name: p, why: "empty" });
  }
  return bad;
}

// ================= 上下文预算（治「跑到一半突然 400」） =================
// 工具结果是上下文的绝对大头：read_file 5 万字、fetch_url 2 万字、run_shell 3 万字，
// 一个跑满 25 步的深度调研任务能堆到几十万字符，把模型上下文撑爆——表现是任务跑到一半
// 突然报 LLM 接口错误 400，前面做的全丢。这里在每次请求前把「老的」工具结果截短：
// 模型真正需要原文的是刚做完那几步，更早的它已经把结论写进自己的回复里了。
// 只截 tool 结果、不删任何消息——OpenAI 侧 tool_calls 必须有对应的 tool 消息应答，删了就是 400。
const CTX_KEEP_HEAD = 300; // 老结果保留的开头字符数（够模型认出这步干了什么）

function entryChars(e) {
  if (e.role === "user") return String(e.content || "").length;
  // 助手消息按真正发出去的那份算：raw 里存着整条消息的真实体积（含 thinking 块，往往比正文大好几倍）
  if (e.role === "assistant") return (e.raw && e.raw.chars) || String(e.text || "").length + JSON.stringify(e.toolCalls || []).length;
  let n = 0;
  if (e.role === "tool") for (const r of e.results || []) n += String(r.content || "").length;
  return n;
}
function historyChars(history) {
  let n = 0;
  for (const e of history) n += entryChars(e);
  return n;
}

// 「可重取」的工具结果：截掉不心疼——要用的时候再调一次工具就能拿回原文。
// 跑代码的输出/报错不在此列：那是一次性的现场证据，截掉就真没了。
const REFETCHABLE_TOOLS = new Set(["read_file", "fetch_url", "list_files", "search_files", "library_read", "library_list", "web_search", "render_page", "check_page"]);

// 削到多低才收手。削"刚好够"是个隐形的烧钱姿势：一超预算就每步再削一点点，
// 而历史被改了一个字节，后面整段缓存前缀就作废——于是每一步都是全价重买。
// 一次削到 75% 留出空档，接下来十几步历史都是逐字不变的，缓存才吃得住。
const CTX_LOW_WATER = 0.75;

/** 就地截短老工具结果直到进预算，返回省下的字符数（0 = 本来就没超） */
function trimHistory(history, maxChars, keepRecent = 3) {
  let total = historyChars(history);
  if (total <= maxChars) return 0;
  const toolIdx = [];
  history.forEach((e, i) => { if (e.role === "tool") toolIdx.push(i); });
  // 最近 keepRecent 轮工具结果留原文，从最老的开始截
  const older = toolIdx.slice(0, Math.max(0, toolIdx.length - keepRecent));
  let saved = 0;
  // 两轮裁剪：先动可重取的，还不够再动不可重现的（老会话的结果没记工具名，归入第二轮）。
  // 低水位只用在第一轮：可重取的结果多削一点无所谓（要用再调一次工具就有），
  // 而第二轮动的是跑代码的输出那种一次性现场证据，削一个字都是净损失，够用就停。
  const passes = [
    { wants: (r) => !r.isError && REFETCHABLE_TOOLS.has(r.name), target: Math.floor(maxChars * CTX_LOW_WATER) },
    { wants: () => true, target: maxChars },
  ];
  for (const { wants, target } of passes) {
    for (const i of older) {
      for (const r of history[i].results || []) {
        if (!wants(r)) continue;
        const s = String(r.content || "");
        if (s.length <= CTX_KEEP_HEAD * 2) continue;
        r.content = s.slice(0, CTX_KEEP_HEAD) + `\n…（原输出 ${s.length} 字符，为控制上下文长度已截断。需要完整内容请重新调用工具获取。）`;
        const cut = s.length - r.content.length;
        saved += cut;
        total -= cut;
        if (total <= target) break;
      }
      if (total <= target) break;
    }
    if (total <= maxChars) return saved;
  }
  return saved;
}

/**
 * 系统提示词里注入真实日期：不给的话模型会拿训练截止日当"今天"，凡是"最新/本周"的任务全歪。
 * 只精确到小时——分钟是个昂贵的小数点：system 是所有 provider 缓存前缀的第一段，
 * 写进分钟就等于每过一分钟整段前缀作废，多轮会话里每一轮都在全价重买同样的几十万 token。
 * "现在/马上/今晚"这类安排本来也只需要钟点粒度。
 */
function envToday() {
  const d = new Date();
  const week = "日一二三四五六"[d.getDay()];
  const slot = d.getHours() < 5 ? "凌晨" : d.getHours() < 12 ? "上午" : d.getHours() < 18 ? "下午" : "晚上";
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日（星期${week}）${slot} ${d.getHours()} 点左右`;
}

function safeWorkspaceDir(baseDir) {
  try { return baseDir ? path.join(getWorkspaceDir(), baseDir) : getWorkspaceDir(); } catch { return "（未设置）"; }
}

/** 当前生效的模型渠道 + 选中模型（base_url / api_key / model / provider），给「没配视觉模型时拿主模型看图」兜底用。 */
function activeChannel(config) {
  const sel = modelCfg.activeSelection(config);
  const e = sel && sel.channel;
  if (e && e.base_url && sel.modelId) return { base_url: e.base_url, api_key: e.api_key, model: sel.modelId, provider: e.provider };
  const legacy = config.provider === "anthropic" ? config.anthropic : config.openai;
  return legacy && legacy.model ? { ...legacy, provider: config.provider } : {};
}

function createAgentRuntime({ config, llm, mcpManager, experts, expertTeams = [], llmFactory, piRuntime, modelRuntimeOverride }) {
  // 备用渠道换道要现造一个 LLM 客户端；懒 require 避免环形依赖，测试时可注入假工厂做零 token 验证
  // pi 场景下这层的"渠道"是模型名；makeLLM 保留给需要现造 LLM 客户端的旧路径
  const makeLLM = llmFactory || ((cfg) => require("./llm").createLLM(cfg));
  /** pi 模型运行时：懒创建一次；测试可注入假运行时（faux provider 假模型） */
  const _piMR = modelRuntimeOverride || (piRuntime && piRuntime.modelRuntime) || null;
  let _getMR = null;
  async function getModelRuntime() {
    if (_piMR) return _piMR;
    if (!_getMR) _getMR = piAdapter.createModelRuntime(config);
    return _getMR;
  }
  /**
   * 渠道变更后必须调（设置里改了 API Key / 增删渠道 / 换默认模型）：
   * pi 的 ModelRuntime 在注册时就把 base_url + api_key 吃进去了，缓存不丢会一直用旧凭证，
   * 表现是"设置里改了 key，跑任务还是报鉴权失败"。
   */
  function resetModelRuntime() {
    _getMR = null;
  }
  const _piModel = (piRuntime && piRuntime.model) || null;
  function injectedModel() {
    return _piModel;
  }
  /** 团里挂着的成员可能已被删掉，取用时按当前专家表过一遍 */
  function teamMembers(team) {
    return (team.members || []).map((n) => experts.find((e) => e.name === n)).filter(Boolean);
  }
  // 技能每次任务实时加载（save_skill 新建的技能立即可用）
  function getSkills() {
    return loadSkills();
  }

  async function baseSystemPrompt(user, hint, baseDir) {
    const skills = getSkills();
    // 用户可以给助理改名（设置 → 个性化）。名字得进提示词，不然用户喊"小秘"它一脸茫然
    const myName = String((config.assistant || {}).name || "").trim() || "KylinWork";
    let p = `你是 ${myName}，一个 AI 办公智能体。用户用自然语言下达办公任务，你自主思考、拆解任务、规划步骤、调用工具执行，最终交付可验证的成果。用户叫你「${myName}」，被问到你是谁就用这个名字。

## 当前环境
- 现在是 ${envToday()}。凡是涉及"最新/今年/近期/本周"的判断一律以这个日期为准，不要用你训练数据里的时间。用户说"现在/马上/今晚"这类词时，按上面的钟点安排，别默认从早上开始。需要最新事实（价格、政策、版本号、人事、榜单）必须 web_search 现查，不许凭记忆答。
- 工作目录（成果文件都放这里）：${safeWorkspaceDir(baseDir)}
- 写文件一律用**相对文件名**（\`报告.html\`、\`demo/index.js\`），相对路径就是从上面这个目录起算的。别再在前面拼一遍目录名——那会在它下面又建一层同名目录。
- 运行环境：${{ darwin: "macOS", win32: "Windows", linux: "Linux" }[process.platform] || process.platform}，本机执行，run_shell 拿到的是用户的真实电脑。

## 工具能力
- run_node：执行 Node.js 代码。已安装库：pptxgenjs(PPT)、docx(Word)、exceljs(Excel)，以及 Node 内置模块。
- run_shell：执行 shell 命令（${process.platform === "win32" ? "Windows cmd，注意用 cmd 语法：del/copy/where、路径反斜杠" : "zsh/bash"}），可用系统已装的 CLI 工具（git、curl、ffmpeg、lark-cli 等）。调现成命令行工具用它，写程序逻辑用 run_node。
- read_file：读文件（大文件用 start_line/end_line 只读要看的那段）
- write_file：**新建**文件。写长文档用 append:true 一节一节续写，别把前文重新吐一遍（既慢又容易越写越短）。写完会自动做语法/结构自检，报了问题就当场修
- edit_file：改已有文件里的某一段（精确替换）。改代码、改文档只用它，不要 write_file 整篇重写
- search_files：全文搜索，返回 文件:行号:命中行。找定义、找调用点、改名前找引用，用它
- list_files：列目录（depth 给 2~3 可一次看清项目结构）
- remember / forget：把跨任务成立的用户偏好记进长期记忆 / 删掉某条
- web_search：联网搜索（标题/链接/摘要），查资料先搜索定位来源
- fetch_url：抓取网页全文或直接调 JSON 接口（带真实浏览器请求头；配合 web_search 的结果 URL 用）
- render_page：用内置浏览器真打开页面、等 JS 渲染完再取正文，专治动态站点（B 站、微博、单页应用）
- check_page：验收做好的网页（静态体检 + 真浏览器打开一遍看有没有报错、是不是白屏）。交付 HTML 之前必须跑
- gen_diagram：文本描述 → 专业图（mermaid 流程/时序/甘特、dot 架构图、echarts 数据图表、plantuml UML），一次生成 SVG+PNG 文件。文档/PPT/飞书文档要配图一律用它，不要手写 SVG 文件
- use_skill：加载技能包（做对应任务前先加载）
- library_list / library_read：查看用户的资料库与灵感笔记（跨项目共享的长期参考资料，任务涉及用户偏好/素材时先查）`;
    if ((config.im || {}).feishu && (config.im.feishu.app_id || config.im.feishu.doc_app_id)) {
      p += `\n- feishu_doc_create：把 Markdown 内容创建成飞书云文档交付给用户（用户要求"发到飞书/建飞书文档"时用它，不要自己找凭证写脚本）`;
    }

    if (skills.length) {
      // 描述截到 80 字：这里只是让模型会「选」技能，全文在 use_skill 加载时才给。
      // 第三方技能爱写整段英文简介，不截的话光这份清单就吃掉小一千 tokens、每一步都重复计费
      const brief = (d) => { const t = String(d || "").replace(/\s+/g, " ").trim(); return t.length > 80 ? t.slice(0, 80) + "…" : t; };
      p += `\n\n## 可用技能\n` + skills.map((s) => `- ${s.name}：${brief(s.description)}`).join("\n");
    }
    p += `

## 工作规范
1. 接到任务先简短说明计划（2-4 句），然后立即执行，不要等用户确认。信息不全时不要停下来用**文字**反问，自己挑一个最合理的默认假设、写在开场白里继续做。要问就用 ask_user 工具（弹可点的选项卡片），而且只在两种情况下问：①缺了它整件事会白做的关键信息（发给谁、用哪个账号）；②选错了成品形态会完全不同的岔路。这两类之外一律自己定，一次只问一个。
2. 涉及已有文件/项目的任务，动手前先 list_files、search_files、read_file 把现场看清楚，不要凭文件名猜内容。**看明白之后直接改**——用户让你改，你就改，不要回头问"要不要我改""确认后我再动手"；只有删文件、清空目录、推远端这类不可逆的事才值得停下来问一句。改的方式是 edit_file 精准替换，不是 write_file 整篇盖掉。
3. 成果文件写到工作目录根目录，文件名有意义。**一件产出只留一份**——写完不要再 cp 一份到别处（工作空间根目录也不行）：聊天里的产出卡片和右侧文件面板本来就能直接预览、直接「所在位置」，多出来的副本只会让用户看到同一个文件显示两遍。用户要把成果拿去别的地方，等他开口再动。**HTML / Markdown / CSS / JSON / 纯文本一律用 write_file 直接写内容，绝不要在 run_node 里用模板字符串拼**——网页正文里几乎必然出现 \`\${...}\`、反引号或 </script\>，会把外层模板字面量截断，直接 SyntaxError。run_node 只留给真的需要跑逻辑的活（pptxgenjs 出 PPT、docx 出 Word、exceljs 出 Excel、批量处理、算数据）。
3.1 消息里带「已上传文件：xxx」就是用户拖进来或粘贴进来的东西，一律先看再动手：
   - 图片（.png/.jpg/…）用 look_at_image，带上一个具体问题（"把报错原文一字不差抄下来"、"这页分几块、各放了什么"）。**别用 read_file 读图**，读出来是乱码。图不进对话历史，只有你问到的答案会进，所以一次就把要用的细节问全。
   - 「粘贴文本_….txt」是用户粘进来的大段文字（日志、报错、整篇文档），用 read_file 读；很长就先读头尾再 search_files 定位，别整篇灌进上下文。
4. 交付前自检：凡是生成的文件，写完必须再 read_file / list_files 读回来确认真的存在、内容完整（长文档至少核对开头结尾和篇幅），发现残缺就当场修好再交付。
4.1 **大任务先立进度档**：预计十步以上、或要产出多个文件的任务，第一步先在工作目录 write_file 建 PROGRESS.md：目标一句话 + 分步清单（- [ ] 待做 / - [x] 已完成）。此后每完成一步就 edit_file 打勾。任务被打断或续跑时，先读 PROGRESS.md 从断点接着做，绝不从头重来。
5. 代码报错要读懂原因、修正重试，不要放弃；同一处连续失败 3 次就换思路，别在死路上空转。
5.1 抓不到网页不等于做不到（高频翻车点）。一条路走不通就换下一条，**同一个目标至少真试满三种路子**才允许说抓不到：
   - fetch_url 拿回来是空壳 → 用 render_page 真渲染一遍；
   - 页面正文是异步加载的 → 去找它背后的数据接口（站点常见的 api.xxx.com/... 形式）直接 fetch_url，接口返回 JSON 比解析 HTML 靠谱得多；
   - 接口要签名/被风控挡 → 用 run_shell 调本机现成的命令行工具（curl 带完整请求头、yt-dlp 取视频站元数据、rss 源等），本机装了什么先 \`which\` 一下再说没有；
   - 还是不行 → web_search 搜同样的内容，从能打开的转载页/镜像站/第三方数据站拿。
   把「需要登录 Cookie / 需要官方 API 权限」当结论直接停手，是不合格的交付。真要用户的登录态才继续，先把不需要登录也能拿到的那部分做完再说。
5.2 **不许用文字问句结束回合**：严禁用「请告诉我你的选择：1... 2... 3...」「需要我尝试哪种方式？」这类话收尾，那是把活推回给用户。**技术路线**（用哪个库、抓哪条接口、跑几轮、代码怎么组织）的优劣你自己判断得了——挑最可能成的那个直接动手，失败了再换。这一条禁的是把选择题写在**回复正文**里，**不是禁 ask_user 工具**：成品形态会完全不同的岔路（封面图走生图还是排版截图、报告交 Word 还是 PDF、视频出横版还是竖版）该用 ask_user 就用，它弹的是可点的选项卡片，用户点一下就继续。同理，严禁把代码贴在回复里说"我能这样做"——能跑就 run_node / run_shell 真跑，回复里只放结论。
5.3 **只读的活一次性并发发出去**：要查 5 个关键词、要抓 6 个链接、要读 3 个文件时，在同一轮里一口气发多个工具调用（web_search / fetch_url / render_page / read_file / list_files / library_read），系统会并发执行，只花最慢那一个的时间；一个一个来是把等待时间叠加。会写文件、跑命令、委派专家的调用不要和别的混在一轮里发——那些的先后顺序有意义，混在一起会被退回串行。
6. 完成后简要总结做了什么、生成了哪些文件。
7. 始终用中文交流——包括报错说明、失败复盘、自我纠正这些中途叙述，任何时候都不许切成英文。工具返回的英文报错要翻成人话讲给用户听（原始报错可以放进代码块，但结论必须是中文）。
8. 用户消息里的「@某文件名」指工作目录中的文件（用 read_file 读取）；「/某技能名」表示要求使用该技能（先 use_skill 加载）；「【任务类型：X】」是场景标签，按该场景的最佳实践来做。
9. 工具能做到的事必须自己调工具真正执行，严禁把命令贴在回复里让用户代跑（除非确实需要用户本人登录/授权才能做的事）。
10. 严禁虚构执行结果（红线）：没有真实调用工具，绝不能声称「已生成/已保存/生成成功」，不能编造文件大小、页数、命令输出或下载链接（sandbox: 开头的链接是假的，禁止输出）。做不到就如实说做不到。系统会自动核验你声称生成的文件是否真实存在，虚构会被当场打回重做。
11. 严禁虚构事实（红线）：数字、日期、人名、机构、政策条款、引用链接，只能来自工具真实拿到的内容。查不到就写「未查到公开信息」，不许用"大约""据业内估算"糊过去，更不许编造看起来很像的 URL。交付物里每个关键数字都要能指回来源。

## 改代码（改用户已有的项目时按这个来）
1. 先看清楚再动手：search_files 找到要改的位置 → read_file 把那一段（含上下文）读出来。别只看文件名和函数名就下笔。
2. 一次只改一处，用 edit_file。old_text 逐字带上（含缩进），带足上下文保证全文唯一；报"不唯一"就多带几行再来，报"没找到"就回去 read_file 看真实内容，不要靠猜反复试。
3. **绝不整篇重写用户的文件**。write_file 只用于新建。整篇重写会把你没读过的部分一起换掉，而且用户的 diff 会变成全红，根本没法审。
4. 改完自检：语法能不能过（node -c 之类的检查、或直接跑起来）、项目有测试就跑测试、改了函数签名就 search_files 找出所有调用点一并改掉。自检失败自己修，别把坏的交出去。
5. 顺手发现的其它问题：说出来，但不要顺手一起改。用户要的是这一件事的干净改动。
6. 收尾时说清楚：改了哪几个文件的哪几处、为什么这么改、验证过什么。

## 写文档（报告、方案、分析、说明书）
1. 先定骨架再落笔：动笔前用一两句话把「读者是谁、他看完要能做什么决定、分几节」定下来，再开写。上来就写第一段的文档，写到一半必然跑偏。
2. **每节先给结论，再给依据**。小标题要有信息量（写「获客成本三个月涨了 2.4 倍」，不写「现状分析」）。段落 3-5 行断开，能列表就列表，能表格就表格。
3. 数字必须可追溯：每个关键数字后面跟上来源（链接或文件名）。查不到就写「未查到公开信息」，不许用"大约""据业内估算"糊过去。
4. 删掉所有废话：「随着…的不断发展」「众所周知」「综上所述」「本文将」这类开场白和过渡句一律不要。凑字数不如把一个论点说透。
5. 长文档分节 append 写：先 write_file 写标题和目录，之后每节用 append:true 追加。一次生成上万字的整篇内容会被截断，而且中途出错要从头再来。
6. 写完必须 read_file 读回来核对：开头结尾在不在、篇幅对不对、有没有半截话、代码围栏是不是成对闭合。自检不过就当场修，别交出去。
7. 交付时说清楚：文件名、多少字、分几节、数据截止到哪天。

## 做网页（HTML 交付物）
1. **单文件自包含**：CSS 写 \`<style>\`、JS 写 \`<script>\`、图标用内联 SVG 或 emoji。**绝不引外部 CDN**（cdn.jsdelivr、unpkg、bootstrap、echarts CDN 等）——用户断网、换台电脑、发给同事，页面当场白屏。需要图表就自己用内联 SVG 或 canvas 画。
2. 必备骨架：\`<!DOCTYPE html>\`、\`<meta charset="utf-8">\`、\`<meta name="viewport" content="width=device-width, initial-scale=1">\`、有信息量的 \`<title>\`、\`lang="zh-CN"\`。
3. 手机上也要能看：宽度用 %/rem/clamp()，别写死 px；多栏布局用 flex/grid 并配 \`@media (max-width: 768px)\` 塌成单栏；表格外面套一层 \`overflow-x:auto\`。
4. 深色模式要跟随系统：颜色统一定义成 \`:root\` 上的 CSS 变量，再用 \`@media (prefers-color-scheme: dark)\` 覆盖一遍变量。别把颜色散写在各处，改起来必漏。
5. 视觉别糊弄：不超过 4 个主色（一个主色 + 一个强调色 + 中性灰阶）、间距一律用 4 的倍数、同类元素左对齐对齐死、正文行高 1.6～1.75、正文宽度别超过 40 字。
6. **内容必须是真数据**：页面里的数字、案例、引用都来自工具真拿到的东西，不许拿 Lorem ipsum、示例数据、占位图充数交付。
7. **写完必须跑一次 check_page**：白屏和 JS 报错光看源码看不出来。报错就改到干净为止，再告诉用户"做好了"。
8. 交付时给出文件名，并提醒用户可以在成果区直接点开预览。

## 长期记忆
- 用户说「以后都这样」「记住…」「别再…」「我习惯…」，或者纠正了你一个会反复出现的做法 → 立刻调 remember 记一句话结论。不记，下次任务你还会犯同样的错。
- 不止等用户开口：任务里摸清的、下次还会用到的稳定事实（用户的业务/产品叫什么、常用账号或主页链接、固定的交付格式、反复用到的文件路径），收尾前主动 remember 一条。判断标准：下个月做类似任务这条还成立、还省事，就值得记。
- 只记跨任务成立的东西（偏好、习惯、常用路径、身份、明确的纠正）。这次任务的过程、临时数据不要记。
- 绝不把密钥、密码、令牌记进去（记忆是明文存的，还会进每一次的系统提示词）。
- 用户说「不用记这个了」→ forget。

## 回复排版（重要）
- 结构固定三段式：**动手前**先用一两句说明你准备做什么、怎么做；**过程中**工具调用之间的过渡叙述控制在一两句话（界面会把中间过程折叠收起）；**收尾**最后一条消息必须是完整、自洽的最终结论/交付说明——用户默认只看到开场白和这段结论，别把关键信息只写在中间过程里。
- 回复用 Markdown 结构化输出：小标题（##/###）分段、要点用列表、关键结论/数字用**加粗**、代码和命令放代码块、对比数据用表格。
- 代码块必须用三反引号围栏包裹并标注语言（\`\`\`python、\`\`\`bash、\`\`\`text 等），围栏要成对闭合。严禁把语言名单独写一行然后直接贴裸代码——那样界面无法渲染成代码块。凡是代码、命令、文件树、日志、XML 片段，一律进围栏（SVG 信息图见下一节，用 \`\`\`svg 围栏会被直接渲染成图）。
- 结论先行，再给必要细节；不要把内心推演过程大段写出来（"让我想想""我先检查一下"这类只保留一句即可）。
- 不要虚构进度和等待（"预计耗时X秒，请稍候""正在生成中"这类话不要说）：要么直接调工具真的去做，要么直接给结果。

## 画信息图（内联 SVG，强烈推荐）
把结构化的结论画成一张图，比十行文字管用。**直接在回复正文里写 \`\`\`svg 围栏**，界面会边输出边把它画出来（用户看到图自己长出来），不用写文件、不用调工具。
- 什么时候画：人物/品牌/产品「画像」、方案对比、流程与时间线、数据拆解、能力雷达、结构总览——凡是"几个维度 + 每个维度几条结论"的东西都适合。一次回复最多 1～2 张，别刷屏。
- 图是结论的可视化，**不能代替文字结论**：图前面照样要有一段说人话的总结。图里的每个数字都必须是工具真拿到的，编数字画得再好看也是红线。
- 硬性写法（不遵守就会显示不出来或在暗色模式下变成黑底黑字）：
  1. 根元素必须带 \`viewBox\`，**不要写死 width/height 的像素值**，界面会自适应铺满；
  2. **这条只对回复正文里的 \`\`\`svg 围栏成立**：文字颜色、描边颜色只用这几个语义变量：\`var(--color-text-primary)\`（标题/正文）、\`var(--color-text-secondary)\`（次要说明）、\`var(--color-text-tertiary)\`（弱化标注）、\`var(--color-border-primary|secondary|tertiary)\`（分隔线/边框）、\`var(--color-bg-subtle)\`（浅底块）；字体统一 \`font-family="var(--font-sans)"\`。品牌色/强调色（高亮标签、数据条）可以直接写 hex；
  3. SVG **不会自动折行**：中文长句要自己拆成多个 \`<tspan x="…" dy="…">\`，或者提前断句，别指望它自己换行；
  4. \`<script>\`、\`<foreignObject>\`、外链图片/字体一律会被安全层清掉，别用；要用 \`<style>\` 就用类名，界面会自动把它限死在这张图里。
- 排版参考：竖版长图（viewBox 宽 680、高按内容给）最稳；顶部大标题+副标题，中间分区块，每块一个小节标题+若干条目，区块之间用细分隔线，末尾可以留一行数据来源。

### ⚠️ 写进文件的 SVG 不能沿用上面那套变量
上面那套 \`var(--color-text-primary)\` 之所以能用，是因为图渲染在应用页面里、变量是页面定义的。
**一旦你把 SVG 写进一个 .html 或 .svg 文件，那个文件是独立的，这些变量根本不存在**——
\`fill: var(--没定义的)\` 会让整条声明作废、回落到默认的黑色，底块和文字一起变黑，
用户打开就是一片看不清。而且在应用内预览时它是好的，只有用浏览器打开才露馅。

写文件时三选一：① 在这个文件自己的 \`:root\` 里把用到的变量定义出来；② 直接写死颜色值；
③ 至少写兜底 \`var(--x, #333)\`。另外：**同一个文件里已经定义了一套变量（比如 --ink/--bg），
就用它自己那套**，别混进另一套名字。写完 write_file 会自动查这一项，报出来就当场改。

### ⚠️ gen_diagram 画的图往 HTML 里贴：一个字符都不许改
流程图/架构图/时序图/思维导图一律 \`gen_diagram\` 画，别手写 SVG。要把它内联进报告时，
**把 .svg 文件的内容原样复制进去**——尤其是 \`<svg id="mmdXXXX">\` 这个 id 和 \`<style>\` 里的
\`#mmdXXXX ...\` 选择器，两边是绑死的。你只要为了"防冲突"改了其中一边（哪怕只加个后缀），
整张图的样式会一条都不生效，回落成黑字、没底色、框线全丢——**这就是用户说的"黑底黑字、排版乱成一团"**。
mermaid 每次渲染的 id 本来就是随机数，根本不会撞，不需要改名。
唯一允许动的是宽度：给 \`<svg>\` 加 \`width="100%"\` 并去掉写死的 width/height 像素值。
写完 write_file 会自动查这一项，报出来说明你确实改坏了，把图重新原样贴一遍。`;
    if (config.persona) {
      p += `\n\n## 用户的个性化偏好\n${config.persona}`;
    }
    // 记忆按账号取：共享的 + 这个人自己的。别人的偏好不该串到他头上；
    // hint 是本次任务线索，记忆装不下提示词预算时按它挑最相关的
    // 自进化规则排在记忆前面：记忆是"这个用户怎么想的"，规则是"你自己在哪儿摔过"。
    // 摔过的坑得先想起来，不然照着用户偏好又摔一次。两块都过预算上限，不会无限撑长。
    try { p += evolve.promptBlock(); } catch {} // 规则目录读不了不该让整个任务起不来
    p += await memory.promptBlock(user, hint);
    return p;
  }

  async function coordinatorSystemPrompt(user, hint, baseDir) {
    let p = await baseSystemPrompt(user, hint, baseDir);
    if (experts.length) {
      p += `\n\n## 可委派的专家（delegate_to_expert）\n`;
      p += experts
        .map((e) => `- ${e.name}${e.alias ? `·${e.alias}` : ""}：${e.description}${(e.skills || []).length ? `（擅长技能：${e.skills.join("、")}）` : ""}`)
        .join("\n");
    }
    const teams = expertTeams.filter((t) => teamMembers(t).length >= 2);
    if (teams.length) {
      p += `\n\n## 可委派的专家团（delegate_to_team，整队接力）\n`;
      p += teams.map((t) => `- ${t.name}：${t.description || "（无说明）"}｜成员依次为 ${teamMembers(t).map((e) => e.name).join(" → ")}`).join("\n");
    }
    if (experts.length) {
      p += `\n\n委派原则：
- 简单任务自己直接做，别为了"显得专业"绕一圈委派，那只是白烧 token 和时间。
- 需要单一环节的专业能力（只是查资料 / 只是做 PPT）→ delegate_to_expert。
- 一句话要走完整条流水线（调研→分析→成稿→做图/做 PPT）→ 直接 delegate_to_team，别自己一个个串。
- 委派时任务描述必须自包含：目标、输入文件名、期望产出文件名。专家看不到你和用户的对话历史。
- 拿回专家汇报后，你要自己核一遍：说生成的文件真的存在吗？结论和用户要的对得上吗？不对就补做或再委派，别直接把专家的话转述给用户就收工。`;
    }
    return p;
  }

  async function expertSystemPrompt(expert, user, hint, baseDir) {
    let p =
      (await baseSystemPrompt(user, hint, baseDir)) +
      `\n\n## 你的专家角色：${expert.name}${expert.alias ? `（花名「${expert.alias}」）` : ""}\n${expert.system}`;
    if ((expert.skills || []).length) {
      p += `\n\n## 你的专属技能（动手前先 use_skill 加载，再按技能里的规范做）\n${expert.skills.map((s) => `- ${s}`).join("\n")}`;
    }
    p += `\n\n你是被主协调者委派的专家。完成后用一段简明汇报结束：做了什么、产出了哪些文件（写真实文件名）、关键结论、还有什么没做完。汇报会被原样交回协调者，别写客套话。`;
    return p;
  }

  const READ_ONLY_TOOLS = ["read_file", "list_files", "search_files", "fetch_url", "render_page", "web_search", "library_list", "library_read", "look_at_image"];

  function toolList(depth, mode) {
    if (mode === "ask" || mode === "plan") {
      return [...TOOL_DEFS.filter((t) => READ_ONLY_TOOLS.includes(t.name)), USE_SKILL_TOOL];
    }
    const tools = [...TOOL_DEFS, USE_SKILL_TOOL, ASK_USER_TOOL, ...mcpManager.toolDefs()];
    // 建定时任务是「动手」类操作，只在 Craft 模式给；子代理不给，免得套娃建任务
    if (depth === 0) tools.push(CREATE_SCHEDULE_TOOL);
    if ((config.im || {}).feishu && (config.im.feishu.app_id || config.im.feishu.doc_app_id)) tools.push(FEISHU_DOC_TOOL);
    if (depth === 0 && experts.length) tools.push(DELEGATE_TOOL);
    // 团委派只给主协调者：专家在团里接力时 depth 已经 >0，再让它组团会套娃
    if (depth === 0 && expertTeams.some((t) => teamMembers(t).length >= 2)) tools.push(DELEGATE_TEAM_TOOL);
    return tools;
  }

  function modePrompt(mode) {
    if (mode === "ask") {
      return `\n\n## 当前模式：Ask（问答）\n只负责回答问题、分析与建议。可以读文件、查资料，但绝不修改文件、不执行代码、不委派专家。回答完即结束。`;
    }
    if (mode === "plan") {
      return `\n\n## 当前模式：Plan（规划）\n只做调研与规划，不实际执行。输出一份结构化执行计划：任务拆解步骤、每步用什么工具/专家、预期产出文件。最后提醒用户切换到 Craft 模式执行。`;
    }
    return `\n\n## 当前模式：Craft（执行）\n用户已经在这个模式里点了「做」，就是要你动手，不是要你确认。
- 直接改文件、直接跑命令、直接交付。**严禁**用「要不要我帮你改？」「确认后我就开始」「你希望用哪种方案？」这类话结束回合——一个回合结束时，要么活干完了，要么真的卡在只有用户本人能解决的事情上（登录、授权、付钱）。
- 方案有好几种、但**成品长得差不多**（用哪个库、代码怎么组织、跑几轮）——自己挑最稳的那个，在开场白里说一句"我按 X 来做"，然后做。做错了再改，比停在原地问强。
- 但**成品形态会完全不同的岔路，不许自己替用户挑**：封面图是 AI 生图还是自己排版截图、报告交 Word 还是 PDF 还是飞书文档、视频出横版还是竖版、文案走口播稿还是图文——这类挑错了等于整件事白做。用 ask_user 把两条路摆出来：label 写选项本身，detail 写"选了它会得到什么、代价是什么"（比如 label"AI 生图" / detail"画面有质感有氛围，但风格随机、不好复现"；label"HTML 排版截图" / detail"版式配色全可控、改起来快，但偏平面没氛围"）。detail 是用户唯一的判断依据，不许省，也不许把 label 换个说法重说一遍。拿到答案再动手。
- 用户已经点名走哪条路了（"你用生图 API 给我做"），就照他说的做——哪怕你觉得另一条更稳，也只能把风险一句话说在前面，不许拿它当理由偷偷换方案。技能文档里的推荐做法同理：那是没人表态时的默认值，不是用来推翻用户的。
- 上面禁的是**文字反问**，不是 ask_user 工具——该问就问，用 ask_user 弹选项，拿到答案接着干：
  · 开工前：需求含糊到可能白干一场，或者风格/范围/平台/受众这类选择会让交付物完全不同——先问一题再动手，比做完返工强；
  · 执行中：要花钱、不可逆、要覆盖/删除已有内容、要对外发布，或碰到只有用户本人知道的偏好（预算、口味、时间安排）。
  一次只问一个问题；问完继续干，不许连环追问，也不许拿它汇报进度。
- 需要审批的危险动作（删除、sudo、碰黑名单文件）系统会自己弹窗拦，不用你在文字里预先请示。
- **结论先行**：交给用户看的东西——回合的最终答复、报告、文档——一律先给结论和建议，再给理由和过程。用户要的是"所以呢"，不是你一步步怎么查到的。长文档第一屏必须有一段能独立读懂的摘要：结论 + 3 条关键依据 + 建议的下一步；把结论埋在第七节里，等于没写。
- **时间盒**：调研、比价、找方案这类活儿，动手前先给自己定个量（查几个来源、看几家、试几种），够了就收手写结论。信息永远查不完，"再多查一点"是最贵的拖延；没查到的写进"待验证"一节交出去，比继续查划算得多。`;
  }

  /**
   * 一次任务运行的"工具分发器"：pi 工具（ToolDefinition.execute）统一落到这里。
   * 特殊工具（ask_user / use_skill / feishu_doc_create / delegate_* / MCP）在此分派，
   * 其余业务工具走 executeTool —— 安全闸门、成果子目录、审批、diff 全部原样保留在 tools.js。
   */
  function buildToolRunner(ctx) {
    const { emit, depth, dl, stats, stopSignal, user, sec, taskLabel, baseDir, askUser, runToken, projectContext, llmOverride, touch } = ctx;
    const loop = ctx.loop; // { hist, errs, nudged } 与 runTask 的 onTurnEnd 共享

    async function dispatch(name, input, signal) {
      if (name === "ask_user") {
        const question = String((input && input.question) || "").trim().slice(0, 500);
        const options = (Array.isArray(input && input.options) ? input.options : [])
          .map((o) =>
            o && typeof o === "object"
              ? { label: String(o.label || "").trim().slice(0, 120), detail: String(o.detail || "").trim().slice(0, 200) }
              : { label: String(o).trim().slice(0, 120), detail: "" }
          )
          .filter((o) => o.label)
          .slice(0, 6);
        if (!question) return { content: "question 不能为空。", isError: true };
        if (!askUser) {
          // IM/定时任务/评测这类无人值守场景没有回答通道，别傻等
          return { content: "当前是无人值守运行，没人在线回答。按你判断的最合理默认继续做，并在最终汇报里注明你替用户做了什么假设。", isError: false };
        }
        const askId = "ask_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const timeoutMs = Math.max(30000, Number(config.agent.ask_user_timeout_ms) || 300000);
        emit({ type: "ask_user", ask_id: askId, question, options, timeout_ms: timeoutMs, depth });
        const t0 = Date.now();
        const answer = await askUser({ askId, question, options, timeoutMs });
        const waited = Date.now() - t0;
        dl.value += waited; // 等用户回答的时间不算任务时长
        if (answer == null) {
          emit({ type: "ask_answer", ask_id: askId, timeout: true, depth });
          return { content: `等了 ${Math.round(waited / 1000)} 秒，用户没有回应。按你判断的最合理默认继续做，并在最终汇报里注明你替用户做了什么假设，别再重复问。`, isError: false };
        }
        emit({ type: "ask_answer", ask_id: askId, answer, depth });
        const picked = options.find((o) => o.label === answer);
        return {
          content: `用户的回答：${answer}` + (picked && picked.detail ? `（这条路你自己写的是：${picked.detail}——照它做）` : ""),
          isError: false,
        };
      }
      if (name === "create_schedule") {
        try {
          const sched = schedulerRegistry.getActiveScheduler();
          if (!sched) return { content: "定时任务功能当前不可用（调度器未启动）。", isError: true };
          if (!input || (!input.repeat && !input.cron)) {
            return { content: "要给一个时间规则：用 repeat（推荐）或 cron。", isError: true };
          }
          const item = sched.add({
            name: input.name,
            task: input.task,
            repeat: input.repeat,
            cron: input.cron,
            workspace_dir: input.workspace,
          });
          const next = sch.nextRunAt(item);
          return {
            content:
              `已创建定时任务「${item.name}」。\n` +
              `工作空间：${item.workspace_dir || "跟随当前工作空间"}\n` +
              `时间规则：${item.repeat ? sch.describeRepeat(item.repeat) : item.cron}\n` +
              `下次运行：${next || "（规则不成立，可能永不触发，请核对）"}`,
            isError: false,
          };
        } catch (e) {
          return { content: `创建定时任务失败：${e.message}`, isError: true };
        }
      }
      if (name === "use_skill") {
        const skills = getSkills();
        const skill = skills.find((s) => s.name === ((input && input.name) || "").trim());
        const dirNote = skill && skill.hasAssets
          ? `【技能目录】${skill.dir}\n该技能自带 scripts/templates 等资源文件（在上述目录内，不在工作目录）。技能文档里的相对路径都相对这个目录；运行其脚本用 run_shell 先 cd 进该目录，但产出的成果文件仍要写到工作目录。\n\n`
          : "";
        return skill
          ? { content: dirNote + skill.content, isError: false }
          : { content: `技能不存在: ${input && input.name}。可用: ${skills.map((s) => s.name).join(", ")}`, isError: true };
      }
      if (mcpManager.isMcpTool(name)) {
        return await mcpManager.call(name, input);
      }
      if (name === "feishu_doc_create") {
        try {
          const { createFeishuDoc } = require("./feishu-doc");
          const resolveImage = (rel) => {
            const ws = getWorkspaceDir();
            const cand = path.isAbsolute(rel)
              ? [path.resolve(rel)]
              : [...(baseDir ? [path.resolve(ws, baseDir, rel)] : []), path.resolve(ws, rel)];
            for (const p of cand) {
              if ((p === ws || p.startsWith(ws + path.sep)) && fs.existsSync(p)) return p;
            }
            return null;
          };
          const r = await createFeishuDoc((config.im || {}).feishu, input, { deadline: dl.value, stopSignal, resolveImage });
          return {
            content: `飞书文档已创建：${r.url}（${r.blocks} 个内容块${r.images ? `，含 ${r.images} 张图` : ""}）${r.warn ? `\n⚠️ ${r.warn}` : ""}\n请把这个链接告诉用户。`,
            isError: false,
          };
        } catch (e) {
          return { content: `创建飞书文档失败：${e.message}`, isError: true };
        }
      }
      if (name === "delegate_to_expert") {
        if (depth > 0) return { content: "专家不能再委派他人，请直接完成任务。", isError: true };
        const expert = experts.find((e) => e.name === ((input && input.expert) || "").trim());
        if (!expert) {
          return { content: `专家不存在: ${input && input.expert}。可用: ${experts.map((e) => e.name).join(", ")}`, isError: true };
        }
        emit({ type: "expert_start", expert: expert.name, task: input && input.task });
        const sub = await runTask({
          projectContext,
          history: [{ role: "user", content: input && input.task }],
          emit: (ev) => emit({ ...ev, expert: expert.name }),
          systemPrompt: await expertSystemPrompt(expert, user, String((input && input.task) || "").slice(0, 500), baseDir),
          depth: depth + 1,
          user,
          taskLabel,
          runToken,
          baseDir,
          deadline: dl.value,
          stats,
          stopSignal,
          sec,
          llmOverride,
          askUser,
        });
        emit({ type: "expert_done", expert: expert.name });
        return { content: `【专家 ${expert.name} 的汇报】\n${sub.finalText || "(无文字汇报)"}`, isError: false };
      }
      if (name === "delegate_to_team") {
        if (depth > 0) return { content: "专家不能再委派他人，请直接完成任务。", isError: true };
        const team = expertTeams.find((t) => t.name === ((input && input.team) || "").trim());
        if (!team) {
          return { content: `专家团不存在: ${input && input.team}。可用: ${expertTeams.map((t) => t.name).join(", ") || "（无）"}`, isError: true };
        }
        const members = teamMembers(team);
        if (members.length < 2) return { content: `专家团「${team.name}」的成员已不足 2 人，请改用 delegate_to_expert。`, isError: true };

        emit({ type: "team_start", team: team.name, members: members.map((m) => m.name), task: input && input.task });
        const reports = [];
        for (let i = 0; i < members.length; i++) {
          const m = members[i];
          if (stopSignal && stopSignal.aborted) break;
          if (Date.now() >= dl.value) {
            reports.push({ name: m.name, text: "（未执行：全队已达最大运行时间）" });
            break;
          }
          const brief =
            `【全队任务】${input && input.task}\n\n` +
            `【你的位置】你是第 ${i + 1}/${members.length} 棒${i === members.length - 1 ? "（最后一棒，你要产出最终交付物）" : ""}\n\n` +
            (reports.length
              ? `【前面同事的汇报】\n${reports.map((r) => `— ${r.name}：\n${r.text}`).join("\n\n")}\n\n只做你这一棒该做的部分，直接用同事已产出的文件，不要重做他们做过的事。`
              : `你是第一棒，从零开始。`);
          emit({ type: "expert_start", expert: m.name, team: team.name, task: brief });
          const sub = await runTask({
            projectContext,
            history: [{ role: "user", content: brief }],
            emit: (ev) => emit({ ...ev, expert: m.name, team: team.name }),
            systemPrompt: await expertSystemPrompt(m, user, String((input && input.task) || "").slice(0, 500), baseDir),
            depth: depth + 1,
            user,
            taskLabel,
            runToken,
            baseDir,
            deadline: dl.value,
            stats,
            stopSignal,
            sec,
            llmOverride,
            askUser,
          });
          emit({ type: "expert_done", expert: m.name, team: team.name });
          reports.push({ name: m.name, text: sub.finalText || "(无文字汇报)" });
        }
        emit({ type: "team_done", team: team.name });
        return {
          content:
            `【专家团「${team.name}」的全队汇报】（${reports.length}/${members.length} 棒完成）\n\n` +
            reports.map((r) => `— ${r.name}：\n${r.text}`).join("\n\n"),
          isError: false,
        };
      }
      // 普通业务工具：安全闸门、成果子目录、审批、diff 全在 tools.js 里原样生效
      return await executeTool(name, input || {}, {
        knownTools: toolList(depth, "craft").map((t) => t.name), // 拼错工具名时给出最接近的真名
        timeoutMs: config.agent.tool_timeout_ms,
        search: config.search,
        media: config.media,
        visionFallback: activeChannel(config),
        security: sec || config.security,
        deadline: dl.value,
        stopSignal: signal || stopSignal,
        taskLabel,
        baseDir,
        memory: { user },
      });
    }

    return async function runToolCall(name, input, signal) {
      const loopKey = name + "\u0000" + JSON.stringify(input || {});
      const seen = loop.hist.get(loopKey);
      // 循环检测：同一工具+同一入参连续 4 次拿到一模一样的结果，第 5 次不再执行
      if (seen && seen.streak >= 4 && name !== "ask_user") {
        return { content: `【系统拦截】你已用完全相同的参数连续 ${seen.streak} 次调用 ${name}，每次结果都一模一样，本次未执行。别再重复同样的动作：换参数、换工具或换一条实现路径；确实无路可走就停止并如实说明卡在哪里。`, isError: true };
      }
      const hb = touch ? setInterval(touch, 5000) : null; // 长工具期间持续心跳，别被卡壳看门狗误杀
      let r;
      try {
        r = await dispatch(name, input || {}, signal);
      } catch (e) {
        // 工具抛出来的异常就地变成一条工具结果，别让 pi 的状态机看到半截调用
        r = { content: `（${name} 执行时抛出异常：${(e && e.message) || e}）`, isError: true };
      } finally {
        if (hb) clearInterval(hb);
        if (touch) touch();
      }
      if (r.extendMs) dl.value += r.extendMs;
      const sig = String(r.content).slice(0, 2000);
      loop.hist.set(loopKey, { sig, streak: seen && seen.sig === sig ? seen.streak + 1 : 1 });
      loop.errs.set(name, r.isError ? (loop.errs.get(name) || 0) + 1 : 0);
      return r;
    };
  }


  // ── 长会话自动压缩 ──────────────────────────────────────────────
  // trimHistory 只截工具输出，对话轮永不清理：会话越聊越大越钝越贵，模型还会拿
  // 自己几十轮前的旧话当依据（「发不了文件」的幻觉就是这么反复复发的）。
  // 超阈值时把早期轮次交给模型浓缩成一条接手摘要，只留最近几轮原文。
  const COMPACT_MARK = "【系统·上下文压缩】";
  /** 从被压缩的轮次里机械提取读/改过的文件，并把上一份摘要里的清单接续下来。
   *  清单不靠摘要模型转述（模型会丢文件名），跨多次压缩累计保留。 */
  function collectFileOps(old) {
    const read = new Set(), wrote = new Set();
    for (const e of old) {
      if (e.role === "assistant") {
        for (const c of e.toolCalls || []) {
          const p = String((c.args || c.input || {}).path || "").trim();
          if (!p) continue;
          if (c.name === "read_file") read.add(p);
          else if (c.name === "write_file" || c.name === "edit_file") wrote.add(p);
        }
      } else if (e.role === "user" && String(e.content || "").startsWith(COMPACT_MARK)) {
        const s = String(e.content);
        const grab = (label, set) => {
          const m = new RegExp(`【${label}】([^\\n]*)`).exec(s);
          if (m) for (const f of m[1].split("、")) { const t = f.trim(); if (t && t !== "无") set.add(t); }
        };
        grab("读过的文件", read);
        grab("改过的文件", wrote);
      }
    }
    for (const p of wrote) read.delete(p); // 改过的不用再占「读过」的位置
    const cap = (set) => Array.from(set).slice(-40).join("、") || "无";
    return { read: cap(read), wrote: cap(wrote) };
  }
  /**
   * 压缩用的那次总结调用：优先走 pi（和任务同一个渠道、同一把 key、同一份用量账），
   * 走不通再退回内置 LLM 客户端。两边都不成就抛，由调用方跳过这次压缩。
   * 早先只走内置客户端：它在 pi 化之后成了"第二个渠道栈"——改了 key、走了 failover，
   * 跑任务的换了一遍，压缩还在用旧的，表现是压缩静默失败、长会话突然 400。
   */
  async function summarize(system, userText, pi) {
    if (pi && pi.modelRuntime && pi.model) {
      try {
        const res = await Promise.race([
          pi.modelRuntime.complete(
            pi.model,
            { systemPrompt: system, messages: [{ role: "user", content: userText }] },
            { maxTokens: 1500 }
          ),
          new Promise((_, rej) => setTimeout(() => rej(new Error("压缩调用超时（60s）")), 60000)),
        ]);
        const text = (res.content || []).map((c) => (c.type === "text" ? c.text : "")).join("").trim();
        if (text) {
          return {
            text,
            usage: {
              prompt: (res.usage && res.usage.input) || 0,
              completion: (res.usage && res.usage.output) || 0,
              cached: (res.usage && res.usage.cacheRead) || 0,
            },
          };
        }
      } catch (e) {
        console.warn("[agent] pi 压缩调用失败，退回内置客户端:", e && e.message);
      }
    }
    const r = await llm.chat({
      system,
      history: [{ role: "user", content: userText }],
      tools: [],
      signal: AbortSignal.timeout(60000),
    });
    return { text: String(r.text || "").trim(), usage: r.usage };
  }

  async function compactHistory(history, { emit = () => {}, stats, pi } = {}) {
    if ((config.agent || {}).compact === false) return;
    const budget = config.agent.max_context_chars || 120000;
    const threshold = config.agent.compact_threshold_chars || Math.floor(budget * 0.6);
    if (historyChars(history) <= threshold) return;
    const keepTurns = config.agent.compact_keep_turns || 4;
    const userIdx = [];
    history.forEach((e, i) => { if (e.role === "user") userIdx.push(i); });
    // 首选切在用户轮开头（工具调用/结果永远成对保留）。轮次不够切 = 单轮长跑任务把上下文
    // 顶爆了，退到「分轮压缩」：在助手消息边界下刀，把任务早期的
    // 几十步浓缩掉。不做这一步的话，长任务中途只能靠 trimHistory 盲截，早期结论全丢。
    let cut = userIdx.length > keepTurns ? userIdx[userIdx.length - keepTurns] : -1;
    let splitMode = false;
    if (cut < 1) {
      const keepChars = config.agent.compact_keep_chars || 30000;
      let acc = 0;
      for (let i = history.length - 1; i >= 1; i--) {
        acc += entryChars(history[i]);
        if (acc >= keepChars) {
          // 边界只能落在 user/assistant 开头：切在 tool 前面会把工具结果和它的调用拆散。
          // 往前（更早）找最近的非 tool 条目——越界点常落在工具结果上，它所属的调用必须一起保留
          for (let j = i; j >= 1; j--) if (history[j].role !== "tool") { cut = j; break; }
          break;
        }
      }
      if (cut < 1) return;
      splitMode = true;
    }
    const old = history.slice(0, cut);
    // 大头字符都在保留的最近几轮里时，压旧轮次省不下几个字符，总量照样超阈值，
    // 下一步又会再触发——变成每步烧一次总结调用的死循环。旧轮次不够肉就不压。
    if (historyChars(old) < 8000) return;
    // 老轮次转成纯文本转写；工具结果只留个头，摘要模型不需要全文
    const lines = [];
    for (const e of old) {
      if (e.role === "user") lines.push("用户：" + String(e.content || "").slice(0, 2000));
      else if (e.role === "assistant") {
        if (e.text) lines.push("助手：" + String(e.text).slice(0, 2000));
        for (const c of e.toolCalls || []) lines.push(`（调用 ${c.name} ${JSON.stringify(c.args || c.input || {}).slice(0, 200)}）`);
      } else if (e.role === "tool") {
        for (const r of e.results || []) lines.push("（工具结果：" + String(r.content || "").replace(/\s+/g, " ").slice(0, 300) + "）");
      }
    }
    let transcript = lines.join("\n");
    if (transcript.length > 60000) transcript = "…（更早部分略）\n" + transcript.slice(-60000); // 压缩请求本身也别把上下文顶爆
    const fileOps = collectFileOps(old);
    // 分轮压缩会把本任务的原始指令一起压掉，摘要没写好任务就跑偏——指令原文机械保留，不过模型的手
    let lastInstr = "";
    if (splitMode) {
      for (let i = old.length - 1; i >= 0; i--) {
        const e = old[i];
        if (e.role !== "user") continue;
        const c = String(e.content || "");
        if (c.startsWith(COMPACT_MARK) || c.startsWith("【系统")) continue;
        lastInstr = c.replace(/\s+/g, " ").slice(0, 2000);
        break;
      }
      // 连续多次分轮压缩后，原始指令只活在上一份摘要里——像文件清单一样机械接续，不能靠摘要模型转述
      if (!lastInstr) {
        for (let i = old.length - 1; i >= 0 && !lastInstr; i--) {
          const e = old[i];
          if (e.role !== "user" || !String(e.content || "").startsWith(COMPACT_MARK)) continue;
          const m = /【最近的用户指令原文】([^\n]*)/.exec(String(e.content));
          if (m) lastInstr = m[1].trim();
        }
      }
    }
    const system =
      "你是会话压缩器。把用户给你的对话转写压成一份接手备忘录，严格按以下结构写（没内容的小节写「无」）：\n" +
      "## 目标\n## 已完成\n## 进行中 / 卡住\n## 关键决定（附原因）\n## 下一步\n## 关键上下文\n" +
      "「关键上下文」放继续干活必需的硬事实：路径、命令、报错原文、用户表达过的偏好与纠正。\n" +
      "只写事实不评论，文件名和关键数字一个都别丢。800 字以内，中文。";
    const { text: summary, usage: cu } = await summarize(system, "以下是需要压缩的对话转写：\n\n" + transcript, pi);
    if (cu && stats) { stats.prompt += cu.prompt || 0; stats.completion += cu.completion || 0; stats.cached = (stats.cached || 0) + (cu.cached || 0); stats.calls++; }
    if (!summary) return;
    // 先归档再动刀：压缩只做搬家不做销毁，真要翻旧账去 data/compact-archive 找
    try {
      const dir = dataPath("data", "compact-archive");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${Date.now()}.json`), JSON.stringify(old, null, 2));
    } catch (e) { console.warn("[agent] 压缩归档失败（不拦压缩）:", e.message); }
    history.splice(0, cut, {
      role: "user",
      content:
        `${COMPACT_MARK}以下是本会话更早内容的自动摘要（原文已归档）：\n${summary}\n` +
        (lastInstr ? `【最近的用户指令原文】${lastInstr}\n` : "") +
        `【读过的文件】${fileOps.read}\n【改过的文件】${fileOps.wrote}\n` +
        `（摘要结束。把以上当作既定事实继续，不必向用户复述；若与用户最新要求冲突，以最新要求为准。）`,
    });
    emit({ type: "compact", removed: old.length });
    console.log(`[agent] 上下文已压缩（${splitMode ? "任务分轮" : "会话轮次"}）：${old.length} 条 → 1 条摘要（现约 ${historyChars(history)} 字符）`);
  }

  /**
   * 运行一次 Agent 任务循环。
   * @param history 统一格式会话历史（会被就地追加）
   * @param emit    事件回调（SSE / IM 进度）
   * @returns { finalText }
   */
  // 并行任务共用一个工作目录：文件的某个版本（文件名+mtime）谁的差异检测先认领就归谁，
  // 别的任务再看到同一版本就不算自己的成果——不然 A 对话刚生成的文件会出现在 B 对话的成果卡片里。
  // 文件再次被改（mtime 变了）允许重新认领。账本只是去重提示，清掉最多短暂多报，不丢数据。
  const fileClaims = new Map(); // name -> { owner, mtime }
  let runSeq = 0;

  /**
   * 运行一次 Agent 任务循环（pi 驱动）。策略全部在这层：
   * 看门狗（死线/卡壳/token 预算）、成果核验、循环检测提醒、首页 failover、
   * 插话注入、自动续跑、强制收尾 wrapUp。
   * @param history 统一格式会话历史（运行结束时会就地替换为 pi 会话的完整导出）
   * @param emit    事件回调（SSE / IM 进度）
   * @returns { finalText }
   */
  async function runTask({ history, emit = () => {}, systemPrompt, depth = 0, mode = "craft", deadline, stats, stopSignal, getInterject, user, projectContext, expertContext, sec, taskLabel, runToken, baseDir, llmOverride, askUser }) {
    // 对话选的模型渠道：llmOverride 可能是渠道名串，也可能是旧 llm 对象（取 .provider / .model / .modelId）
    let providerName =
      (typeof llmOverride === "string" ? llmOverride : llmOverride && (llmOverride.provider || llmOverride.model)) ||
      config.active_model ||
      "";
    // 选中渠道下的具体模型 id：同一个渠道挂多个模型时靠它区分；llmOverride 没带就退回全局选中项
    let modelId =
      (llmOverride && typeof llmOverride === "object" && llmOverride.modelId) ||
      (providerName && providerName === config.active_model ? config.active_model_id : "") ||
      "";
    let finalText = "";
    let stopNote = "";
    let honestyRetries = 0;
    let failedOver = false;
    if (!runToken) runToken = ++runSeq;
    const projBlock = projectContext ? `\n\n## 当前项目的背景与规范（用户在项目设置里写的，必须遵守）\n${projectContext}` : "";
    // 界面选定的专家指令只给主协调者：专家子代理（depth>0）没有 delegate_to_expert 工具，
    // 把「你必须委派给 X」塞给它们只会让它们手足无措。
    const expertBlock = depth === 0 && expertContext ? expertContext : "";
    const lastUserMsg = [...history].reverse().find((e) => e && e.role === "user" && typeof e.content === "string");
    const memHint = lastUserMsg ? lastUserMsg.content.slice(0, 500) : "";
    const system = (systemPrompt || (await coordinatorSystemPrompt(user, memHint, baseDir))) + projBlock + expertBlock + modePrompt(mode);
    const maxSteps = config.agent.max_steps || 25;
    if (!deadline) deadline = Date.now() + (config.agent.max_runtime_ms || 1800000);
    if (!stats) stats = { prompt: 0, completion: 0, cached: 0, calls: 0, startedAt: Date.now() };
    const dl = { value: deadline }; // 可变死线：ask 等待、睡眠顺延都往这里加
    const tokBudget = Math.max(0, Math.round(+config.agent.max_tokens_budget || 0));
    // 循环检测共享台账：包装器（工具执行）读它拦第 5 连，onTurnEnd（回合边界）读它喂提醒
    const loop = { hist: new Map(), errs: new Map(), nudged: new Set() };
    let noteStepLimit = null; // 撞步数 / token 预算的备注；撞时间直接置 stopNote
    let lastModelError = null;
    let hangFired = false;
    let drv = null;
    let flushed = false;
    // 中断要幂等：看门狗、步数上限、token 预算、手动停止可能几乎同时要求 abort，
    // 重复调会互相打断；另外记住"是我们主动中断的"，别把 abort 引发的收尾当硬失败抛出去
    let aborting = null;
    const abortNow = () => {
      if (!drv) return;
      if (!aborting) aborting = (async () => { try { await drv.abort(); } catch {} })();
      return aborting;
    };
    // 把 pi 会话的消息树回写进调用方 history（就地替换）。
    // 异常/中断路径也必须回写：跑到哪记到哪，下次续接才不会把已完成的工具重做一遍
    const flushHistory = () => {
      if (!drv || flushed) return;
      flushed = true;
      try {
        const out = drv.exportHistory();
        if (out && out.length) history.splice(0, history.length, ...out);
      } catch (e) {
        console.warn("[agent] 会话导出失败（不影响返回）:", e.message);
      }
    };

    // 任务开始时先记工作目录快照；files 事件带上「这一轮真正新增/改动的文件」。
    // 必须在服务端算：前端那份 mtime 快照是活的，历史回放时早就对不上了，算出来永远是空。
    const baseline = new Map();
    for (const f of outputFiles()) baseline.set(f.name, f.mtime);
    const emitFiles = () => {
      try {
        const files = outputFiles();
        const changed = [];
        for (const f of files) {
          const isNew = baseline.get(f.name) !== f.mtime;
          baseline.set(f.name, f.mtime);
          if (!isNew) continue;
          const claim = fileClaims.get(f.name);
          // 同一版本已被别的并行任务认领 → 是它的产出，不抢功
          if (claim && claim.owner !== runToken && claim.mtime === f.mtime) continue;
          fileClaims.set(f.name, { owner: runToken, mtime: f.mtime });
          changed.push(f.name);
        }
        if (fileClaims.size > 1000) fileClaims.clear();
        emit({ type: "files", files, changed });
        // 长跑可见性：进度档一更新就把里程碑清单推给前端，时间线卡片实时打勾
        const progName = changed.find((n) => n.split("/").pop() === "PROGRESS.md");
        if (progName) {
          const raw = fs.readFileSync(path.join(getWorkspaceDir(), progName), "utf8").slice(0, 20000);
          const items = [];
          for (const line of raw.split("\n")) {
            const m = /^\s*[-*]\s*\[([ xX])\]\s*(.+)/.exec(line);
            if (m) items.push({ text: m[2].trim().slice(0, 120), done: m[1] !== " " });
            if (items.length >= 60) break;
          }
          if (items.length) emit({ type: "milestones", file: progName, items, depth });
        }
      } catch {}
    };

    // 睡眠治理：任务期间按住「别睡」断言；真睡了就把死线顺延
    const releaseAwake = awake.hold();
    const unwatchSleep = awake.watch((sleptMs) => {
      dl.value += sleptMs;
      if (depth === 0) emit({ type: "sleep", ms: sleptMs, note: `检测到本机睡眠 ${Math.round(sleptMs / 1000)} 秒，任务时限已顺延（睡眠不算任务时间）`, depth });
    });

    // 卡壳看门狗：连续 llm_timeout_ms 无任何输出 = 真挂起（pi 有自己的自动重试，但悬空连接它等不到头）
    let stallTimer = null;
    let lastActivity = Date.now();
    // 心跳：ask_user 等用户作答、飞书权限轮询、长命令跑批这类工具执行期间 pi 一个事件都不发，
    // 光靠事件刷新 lastActivity 会被下面这条看门狗误判成"模型挂起"直接把任务掐了
    const touch = () => { lastActivity = Date.now(); };
    const stallMs = Math.max(10000, Math.min(dl.value - Date.now(), config.agent.llm_timeout_ms || 300000));
    const startStallWatch = () => {
      clearInterval(stallTimer);
      lastActivity = Date.now();
      stallTimer = setInterval(() => {
        if (Date.now() - lastActivity > stallMs) {
          clearInterval(stallTimer);
          hangFired = true;
          abortNow();
        }
      }, 5000);
    };
    const stopStallWatch = () => clearInterval(stallTimer);

    // 备用渠道换道：主模型持续报错或挂起时切到用户在设置里显式选好的备用渠道。
    // 默认关（agent.failover_model 为空）。红线：绝不静默降级；每个任务最多换一次
    const failoverName = String((config.agent || {}).failover_model || "").trim();
    const failoverId = String((config.agent || {}).failover_model_id || "").trim();
    const switchToBackup = async (reason) => {
      if (!drv || !failoverName || failedOver || failoverName === providerName) return false;
      const backup = modelCfg.findChannel(config, failoverName);
      if (!backup) return false; // 渠道已被删掉
      const ok = await drv.setModelByProvider(failoverName, failoverId || undefined);
      if (!ok) return false;
      failedOver = true;
      providerName = failoverName;
      modelId = modelCfg.pickModelId(backup, failoverId);
      emit({ type: "failover", note: `${reason}，已切换到备用渠道「${failoverName}」继续本任务`, channel: failoverName, depth });
      return true;
    };

    try {
      const modelRuntime = await getModelRuntime();
      const model = injectedModel() || piAdapter.resolveModel(modelRuntime, config, providerName, modelId);
      if (!model) {
        throw new Error(`没有可用的模型渠道：${providerName || "(未配置)"}${modelId ? " / " + modelId : ""}。请先在 设置 → 模型 里选一个渠道。`);
      }

      const handler = buildToolRunner({
        emit, depth, dl, stats, stopSignal, user, sec, taskLabel, baseDir,
        askUser, runToken, projectContext, llmOverride, loop, touch,
      });
      const piTools = piAdapter.buildPiTools(toolList(depth, mode), handler, { readOnly: new Set(READ_ONLY_TOOLS) });

      drv = await piAdapter.createPiSessionDriver({
        config,
        modelRuntime,
        model,
        systemPrompt: system,
        kwHistory: history,
        tools: piTools,
        cwd: getWorkspaceDir(),
        baseDir,
        emit,
        depth,
        collectSources, // 抓取类工具真拿到来源才报 sources 事件（Web 来源卡片用）
        // 思考过程默认播报（前端默认折叠，想看才展开）。只有显式设成 false 才关
        showThinking: (config.agent || {}).show_thinking !== false,
        host: {
          onAny: () => {
            lastActivity = Date.now();
            // 手动停止要能穿透到运行中的 pi 回合：一看到信号就 abort，别等回合自然结束
            if (stopSignal && stopSignal.aborted) abortNow();
          },
          onToolUpdate: () => {
            lastActivity = Date.now(); // 工具还在吐增量 = 它还活着，别让看门狗误判
          },
          onTurnEnd: ({ turn }) => {
            // 工具批次刚结束，这一批新增/改动的文件此时全在磁盘上，正好播报
            emitFiles();
            // 插话：工具批次结束这个安全点注入（不打断流式输出）
            if (getInterject) {
              for (const m of getInterject()) {
                emit({ type: "interject", text: m, depth });
                if (drv) drv.steer(`【用户插话（在任务执行中补充）】${m}`);
              }
            }
            // 循环检测 3 连提醒：同样在安全点 steer 进去
            const nudges = [];
            for (const [k, v] of loop.hist) {
              if (v.streak >= 3 && !loop.nudged.has("c:" + k)) { loop.nudged.add("c:" + k); nudges.push(`用完全相同的参数调用 ${k.split("\u0000")[0]} 已连续 ${v.streak} 次拿到完全相同的结果`); }
            }
            for (const [name, n] of loop.errs) {
              if (n >= 4 && !loop.nudged.has("e:" + name)) { loop.nudged.add("e:" + name); nudges.push(`${name} 已连续失败 ${n} 次`); }
            }
            if (nudges.length) {
              emit({ type: "text", delta: `\n\n> ⚠️ **循环检测**：${nudges.join("；")}，已提醒换思路。\n\n`, depth });
              if (drv) drv.steer(`【系统·循环检测】${nudges.join("；")}。这是在死路上空转，时间和费用都在烧：立即换思路——换参数、换工具或换一条实现路径；实在无路可走就停下收尾，如实说明卡在哪里，严禁再重复同样的动作。`);
            }
            if (turn >= maxSteps && !noteStepLimit) {
              noteStepLimit = `已达最大步数（${maxSteps}）`;
              abortNow();
            }
          },
          onMessageEnd: ({ message }) => {
            const u = message && message.usage;
            if (u) {
              stats.prompt += u.input || 0;
              stats.completion += u.output || 0;
              stats.cached = (stats.cached || 0) + (u.cacheRead || 0);
              stats.calls++;
              // 直播 token 账：每收到一条模型回复就把累计值播一次，界面上「生成中 ↑x ↓y」
              // 才有实时数字可显示（收尾那次不带 live，前端据此区分「进行中」和「最终账单」）。
              // 只在最外层播：子代理的消耗算在它自己那层，不该混进用户看到的这一条。
              if (depth === 0) {
                emit({
                  type: "usage",
                  model: modelId || providerName,
                  model_id: modelId,
                  provider: providerName,
                  prompt: stats.prompt,
                  completion: stats.completion,
                  cached: stats.cached || 0,
                  calls: stats.calls,
                  live: true,
                });
              }
            }
            if (tokBudget && u) {
              const used = stats.prompt + stats.completion;
              if (used >= tokBudget) {
                if (!stats.budgetWarned) {
                  stats.budgetWarned = true;
                  emit({ type: "status", text: `已达 token 预算（已用 ${used.toLocaleString()}），任务强制收尾`, depth });
                }
                if (!noteStepLimit) noteStepLimit = `已达 token 预算（已用 ${used.toLocaleString()}，预算 ${tokBudget.toLocaleString()}）`;
                abortNow();
              } else if (!stats.budgetWarned && used >= tokBudget * 0.8) {
                stats.budgetWarned = true;
                emit({ type: "status", text: `token 用量已到预算的 ${Math.round((used / tokBudget) * 100)}%（${used.toLocaleString()} / ${tokBudget.toLocaleString()}），超出后任务会强制收尾`, depth });
              }
            }
          },
          onRetryEnd: (ev) => {
            if (ev && ev.success === false) lastModelError = ev.finalError || "模型重试耗尽";
          },
          onCompactionEnd: (ev) => {
            // pi 兜底的上下文压缩结果归档，跟自家 compactHistory 同一目录，不丢历史
            try {
              const dir = dataPath("data", "compact-archive");
              fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(path.join(dir, `pi-${Date.now()}.json`), JSON.stringify(ev.result || {}, null, 2));
            } catch {}
          },
        },
      });

      // 主循环：核验打回 / 撞限自动续跑 / failover 重试，都在一轮 pi prompt 之间
      const autoRounds = depth === 0 ? Math.min(20, Math.max(0, Number(config.agent.auto_continue_rounds) || 0)) : 0;
      let roundsUsed = 0;
      let promptText = drv.text || "请继续执行任务。";

      for (;;) {
        // 跨轮压缩（仅顶层）：指令原文机械保留、旧轮次归档
        if (depth === 0) {
          try { await compactHistory(history, { emit, stats, pi: { modelRuntime, model } }); }
          catch (e) { console.warn("[agent] 上下文压缩失败，本次跳过:", e.message); }
        }
        if (stopSignal && stopSignal.aborted) { stopNote = "已手动停止"; break; }
        if (Date.now() >= dl.value) { stopNote = `已达最大运行时间（${Math.round((config.agent.max_runtime_ms || 1800000) / 60000)} 分钟）`; break; }
        if (tokBudget && stats.prompt + stats.completion >= tokBudget) { stopNote = "已达 token 预算"; break; }

        startStallWatch();
        try {
          await drv.prompt(promptText);
        } catch (e) {
          stopStallWatch();
          if (stopSignal && stopSignal.aborted) { stopNote = "已手动停止"; break; }
          // 主模型持续报错（pi 自动重试已耗尽）：有备用渠道就换道重试本回合
          if (Date.now() < dl.value - 30000 && lastModelError && !failedOver && failoverName) {
            const ok = await switchToBackup(`主模型持续报错（${String(lastModelError).slice(0, 120)}）`);
            if (ok) { lastModelError = null; continue; }
          }
          if (hangFired) { stopNote = `模型响应超时（连续 ${Math.round(stallMs / 1000)} 秒没有任何输出，连接已挂起）`; break; }
          // 是我们自己按上限中断的（步数/预算）——那是正常收尾，不是故障，别当硬错误抛
          if (aborting) { stopNote = noteStepLimit || "已按上限中断"; break; }
          throw e; // 服务端硬错误，任务如实失败
        }
        stopStallWatch();
        if (stopSignal && stopSignal.aborted) { stopNote = "已手动停止"; break; }

        finalText = drv.lastAssistantText() || "";

        // 成果核验：声称已生成却不在磁盘 → 打回（最多 2 次）
        if (depth === 0) {
          const bad = missingDeliverables(finalText);
          if (bad.length && honestyRetries < 2 && Date.now() < dl.value - 30000) {
            honestyRetries++;
            const gone = bad.filter((b) => b.why === "missing").map((b) => b.name);
            const empty = bad.filter((b) => b.why === "empty").map((b) => b.name);
            const parts = [];
            if (gone.length) parts.push(`磁盘上根本不存在：${gone.slice(0, 5).join("、")}`);
            if (empty.length) parts.push(`文件在但是 0 字节空文件：${empty.slice(0, 5).join("、")}`);
            const list = parts.join("；");
            promptText = `【系统自动核验】你上一条回复声称已生成/可获取这些文件，但核验不通过——${list}。在文字里写命令和"✅ 生成成功"不等于执行；写出来是空文件也不算交付。现在立即用 write_file / run_node / run_shell 真实生成一遍，写完用 read_file 或 list_files 读回来确认内容真的在里面，再如实汇报。如果执行失败，就如实报告失败原因和报错内容。严禁再声称不存在或空的文件已生成。`;
            emit({ type: "text", delta: `\n\n> ⚠️ **成果核验未通过**：${list}，已自动打回要求真实执行。\n\n`, depth });
            continue;
          }
        }

        // 命中上限但还能自动续跑（仅顶层；手动停止、模型挂死不续跑）
        const hitLimit = !!(noteStepLimit || hangFired || lastModelError || Date.now() >= dl.value);
        if (hitLimit && !(stopSignal && stopSignal.aborted) && roundsUsed + 1 < autoRounds && Date.now() < dl.value - 5000) {
          roundsUsed++;
          const reason = noteStepLimit || (hangFired ? "模型响应超时" : lastModelError ? "模型持续报错" : "已达运行时限");
          emit({ type: "auto_continue", round: roundsUsed, total: autoRounds, note: `${reason}，自动开启第 ${roundsUsed + 1}/${autoRounds} 轮继续执行`, depth });
          promptText = `【系统】上一轮因${reason}被打断，现在继续执行未完成的任务。先读工作目录里的 PROGRESS.md（若有）接着断点做，不要从头开始。`;
          noteStepLimit = null;
          lastModelError = null;
          hangFired = false;
          continue;
        }
        if (noteStepLimit) stopNote = noteStepLimit;
        break;
      }

      // 模型侧报错且没有任何产出：必须把错误亮给用户，空气泡 + ↑0↓0 比报错更误事。
      // （认证失效、余额不足、参数被拒这类都会走到这——pi 重试耗尽后 stopReason=error，不抛异常。）
      if (lastModelError && !finalText && !stopNote && !(stopSignal && stopSignal.aborted)) {
        emit({ type: "error", message: `模型调用失败：${String(lastModelError).slice(0, 200)}`, depth });
      }

      // 强制收尾：撞上限没手动停 → 补一段交代（不带工具的一轮）
      // limit 事件既给 UI 播报，也是自进化在会话转录里挖「撞了什么墙」的依据
      if (stopNote && !(stopSignal && stopSignal.aborted)) {
        emit({ type: "limit", note: stopNote, depth });
        drv.setActiveTools([]);
        const wrapMsg = `【系统】任务已到上限被强制收尾（${stopNote}）。现在不要再调用任何工具，直接给用户一段收尾说明：
1. 已经做完了什么、产出了哪些文件（只写真实存在的文件名，没生成就别写）；
2. 还差哪些没做完；
3. 下次接着做的话，从哪一步继续最省事。
用中文，简明扼要，不要客套。`;
        try {
          await drv.prompt(wrapMsg);
          const w = drv.lastAssistantText();
          if (w) finalText = w; // 收尾说明顶替半截过程叙述，别把"我先看一下"当最终答复
        } catch (e) { console.warn("[agent] 收尾说明没拿到:", e && e.message); }
      }
      // 收尾提示（手动停止也一样要带上，用户得知道任务停在哪）
      if (stopNote) {
        const notice = `⚠️ ${stopNote}，任务强制收尾。如需继续，可提高设置中的上限或让我接着上次进度做。`;
        finalText = finalText ? `${finalText}\n\n${notice}` : notice;
      }

      flushHistory();
    } finally {
      stopStallWatch();
      unwatchSleep();
      releaseAwake();
      flushHistory(); // 抛错/中断时这里兜底回写
      if (drv) drv.dispose();
    }

    const usage = {
      prompt: stats.prompt,
      completion: stats.completion,
      cached: stats.cached || 0,
      calls: stats.calls,
      elapsed_ms: Date.now() - stats.startedAt,
    };
    if (depth === 0) {
      emit({ type: "usage", model: modelId || providerName, model_id: modelId, provider: providerName, ...usage });
    }
    return { finalText, usage, stopped: stopNote || null };
  }


  return {
    runTask,
    getSkills,
    resetModelRuntime,
    // CLI 的 /compact 与定时任务走这里：手上没有现成的会话，按全局默认渠道现取一个
    compact: async (history, opts = {}) => {
      if (!opts.pi) {
        try {
          const mr = await getModelRuntime();
          opts.pi = { modelRuntime: mr, model: piAdapter.resolveModel(mr, config, config.active_model) };
        } catch {}
      }
      return compactHistory(history, opts);
    },
  };
}

// 并发上限：抓页面是等网络，开太多既没有更快，还容易被对方站点当成扫站封 IP
const PARALLEL_MAX = 3;

/** 限流并发跑一批，结果按原顺序返回（工具结果的顺序要和 tool_calls 对得上） */
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

/**
 * 从一次工具调用里挖出"这一步真访问了哪些网页"，给回复底下的「来源」用。
 * 只认工具层的实际入参与实际返回，不认模型嘴上说参考了什么——那种"来源"经常是编的。
 */
function collectSources(name, input, content) {
  const text = String(content || "");
  if (name === "fetch_url" || name === "render_page") {
    const url = String(input?.url || "");
    // 抓失败的不算来源——放进「来源」里等于告诉用户"我看过这页"，其实没看到
    if (!/^https?:\/\//i.test(url) || /没能拿到正文/.test(text.slice(0, 200))) return [];
    const title = (text.match(/^HTTP\s+\d+\s*·\s*([^\n（(]+)/) || [])[1] || "";
    return [{ url, title: title.trim().slice(0, 80) }];
  }
  if (name === "web_search") {
    // webSearch 的输出是「序号. 标题 \n 缩进的 URL \n 摘要」
    return [...text.matchAll(/^\s*\d+\.\s*(.+)\n\s+(https?:\/\/\S+)/gm)]
      .map((m) => ({ title: m[1].trim().slice(0, 80), url: m[2] }))
      .slice(0, 10);
  }
  return [];
}

module.exports = { createAgentRuntime, missingDeliverables, trimHistory, historyChars, collectSources, mapPool, PARALLEL_MAX };
