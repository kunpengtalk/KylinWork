// Phase 3 全栈集成检查：faux 假模型驱动新的 createAgentRuntime→runTask→pi 会话
// 验证：write_file 真实落盘 / ask_user 交互 / delegate_to_expert 递归子会话 / history 导出 / usage / 事件流
// 运行：node scripts/pi-run-check.mjs
import { createRequire } from "node:module";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { createAgentRuntime } = require("../engine/agent.js");
const { setWorkspaceDir } = require("../engine/tools.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-"));
setWorkspaceDir(tmp);
const MD = "e2e-产出.md";

const config = {
  agent: { max_steps: 20, tool_timeout_ms: 30000, max_runtime_ms: 120000, llm_timeout_ms: 60000 },
  im: {},
  security: require("../engine/security.js").DEFAULTS,
};
const experts = [{ name: "文案写手", description: "写作", system: "你是文案写手，专写文案。" }];

// ---- faux 假模型：按调用顺序消费脚本 ----
const faux = fauxProvider();
const mr = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false, modelsPath: null });
mr.registerNativeProvider(faux.provider);
const model = faux.getModel();

faux.setResponses([
  // 1) 主会话第一轮：写字 + 调 write_file
  fauxAssistantMessage([{ type: "text", text: "我现在写文件。" }, fauxToolCall("write_file", { path: MD, content: "# e2e\n管线通了。" }, { id: "t_w0" })], { stopReason: "toolUse" }),
  // 2) 主会话第二轮：问用户一题
  fauxAssistantMessage([{ type: "text", text: "先确认一下。" }, fauxToolCall("ask_user", { question: "报告交什么格式？", options: [{ label: "Markdown", detail: "可直接预览" }, { label: "PDF", detail: "排版固定" }] }, { id: "t_ask" })], { stopReason: "toolUse" }),
  // 3) 主会话第三轮：委派专家
  fauxAssistantMessage([{ type: "text", text: "把文案交给专家。" }, fauxToolCall("delegate_to_expert", { expert: "文案写手", task: "把 # e2e 改为两百字宣传文案，存 expert.md" }, { id: "t_del" })], { stopReason: "toolUse" }),
  // 4) 专家子会话第一轮：写文件
  fauxAssistantMessage([{ type: "text", text: "我来写。" }, fauxToolCall("write_file", { path: "expert.md", content: "这是专家写的文案。" }, { id: "t_w1" })], { stopReason: "toolUse" }),
  // 5) 专家子会话第二轮：收尾
  fauxAssistantMessage("专家完成，已产出 expert.md。", { stopReason: "end" }),
  // 6) 主会话第四轮：收尾
  fauxAssistantMessage("全部完成：产出 md 和专家文案。", { stopReason: "end" }),
]);

// ---- 注入假运行时，跑通整条 runTask ----
const runtime = createAgentRuntime({
  config,
  llm: {},
  mcpManager: { toolDefs: () => [], isMcpTool: () => false, call: async () => ({ content: "stub", isError: true }) },
  experts,
  expertTeams: [],
  modelRuntimeOverride: mr,
  piRuntime: { model },
});

const events = [];
const emit = (ev) => { events.push(ev); };
let askCalls = 0;
const r = await runtime.runTask({
  history: [{ role: "user", content: "做一个小 e2e：产出报告并找专家写文案" }],
  emit,
  askUser: async ({ options }) => { askCalls++; return options[0].label; },
});

const mdf = fs.existsSync(path.join(tmp, MD)) ? fs.readFileSync(path.join(tmp, MD), "utf8") : "";
const exp = fs.existsSync(path.join(tmp, "expert.md")) ? fs.readFileSync(path.join(tmp, "expert.md"), "utf8") : "";
const types = events.map((e) => e.type);
const toolUses = events.filter((e) => e.type === "tool_use").map((e) => e.name);
const expertStarts = events.filter((e) => e.type === "expert_start").length;
const usageEvt = events.find((e) => e.type === "usage");

console.log("=== PI RUN CHECK ===");
console.log("finalText:", r.finalText);
console.log("stopped:", r.stopped, "| usage:", JSON.stringify(r.usage));
console.log("file md:", JSON.stringify(mdf), "| expert.md:", JSON.stringify(exp));
console.log("events:", [...new Set(types)].join(","));
console.log("tool_use 顺序:", toolUses.join(" → "));
console.log("expert_start 次数:", expertStarts, "| ask 次数:", askCalls);

if (!mdf.includes("管线通了")) throw new Error("主会话 write_file 未真实落盘");
if (!exp.includes("专家写的文案")) throw new Error("专家子会话 write_file 未真实落盘");
if (askCalls !== 1) throw new Error("ask_user 应被调用 1 次");
if (expertStarts !== 1) throw new Error("应委派 1 次专家");
if (!toolUses.includes("write_file") || !toolUses.includes("ask_user") || !toolUses.includes("delegate_to_expert")) throw new Error("工具调用顺序不对: " + toolUses.join(","));
if (!usageEvt || !(usageEvt.prompt > 0)) throw new Error("usage 事件缺失");
if (!r.finalText.includes("全部完成")) throw new Error("最终文本不对: " + r.finalText);
console.log("\n✅ PI RUN CHECK PASSED（全栈：pi 会话 + 工具 + ask + 委派 + history/usage 导出）");
fs.rmSync(tmp, { recursive: true, force: true });
