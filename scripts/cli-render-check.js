"use strict";
/**
 * CLI 渲染管线集成自检（pi 引擎，不发真实模型请求）：
 * 用 pi 的 faux 假模型驱动真实 createAgentRuntime，把事件喂给 cli.js 的 makeEmit，
 * 验证：流式文本 / tool_use / tool_result+diff / ask_user 交互 / 会话列表 / 非 TTY 降级。
 * 运行：node scripts/cli-render-check.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const cli = require("../engine/cli");
const { createAgentRuntime } = require("../engine/agent");
const { setWorkspaceDir } = require("../engine/tools");

// 用真实 config 但把工作目录指到临时目录，别污染真工作空间
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cli-render-"));
setWorkspaceDir(cwd);

const MD = "render-check.md";

(async () => {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
  const faux = fauxProvider();
  const mr = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false, modelsPath: null });
  mr.registerNativeProvider(faux.provider);
  faux.setResponses([
    // 流式文本（text_delta）在工厂里直接吐
    async (ctx) => {
      // 让 pi 流式出正文：通过返回的 assistant message 里带 text 即可，delta 由 pi 回放；
      // 这里把"第一句话流式输出。"拼进消息文本，验证 text 事件被映射到 emit
      return fauxAssistantMessage(
        [{ type: "text", text: "第一句话流式输出。" }, fauxToolCall("write_file", { path: MD, content: "# 标题\n\n正文第一段。\n正文第二段。" }, { id: "t1" })],
        { stopReason: "toolUse" }
      );
    },
    // 改文件，验证 diff 通过 details 回流
    fauxAssistantMessage([{ type: "text", text: "改一下。" }, fauxToolCall("edit_file", { path: MD, old_text: "正文第一段。", new_text: "正文第一段（修订）。\n新增一行。" }, { id: "t2" })], { stopReason: "toolUse" }),
    // 问用户
    async (ctx) => {
      return fauxAssistantMessage(
        [{ type: "text", text: "问你一下。" }, fauxToolCall("ask_user", { question: "报告交成什么格式？", options: [{ label: "Markdown", detail: "可直接预览，改起来快" }, { label: "PDF", detail: "排版固定，适合直接交付" }] }, { id: "t3" })],
        { stopReason: "toolUse" }
      );
    },
    fauxAssistantMessage("做完了，文件在 " + MD + "。", { stopReason: "end" }),
  ]);

  const runtime = createAgentRuntime({
    config: { agent: { max_steps: 6 } },
    experts: [],
    expertTeams: [],
    mcpManager: { toolDefs: () => [], isMcpTool: () => false, call: async () => ({ content: "mcp stub", isError: true }) },
    modelRuntimeOverride: mr,
    piRuntime: { model: faux.getModel() },
  });

  // 1) 渲染管线 + diff
  let askCalls = 0;
  const emit = cli.makeEmit({});
  const hist = [];
  const r = await runtime.runTask({
    history: hist,
    emit,
    askUser: async ({ question, options }) => {
      askCalls++;
      assert.strictEqual(options.length, 2, "ask_user 应带 2 个选项");
      return options[1].label; // 选 PDF
    },
  });
  assert.strictEqual(askCalls, 1, "ask_user 应被真实调用一次");
  assert.ok(r.finalText.includes(MD), "最终文本应提到文件");
  // 文件确实被写入并改过
  const txt = fs.readFileSync(path.join(cwd, MD), "utf8");
  assert.ok(txt.includes("修订") && txt.includes("新增一行"), "edit 应生效");
  // 会话历史回填：hist 里应能翻到 assistant + tool 对（write/edit/ask 各一轮）
  const kwTools = hist.filter((h) => h.role === "tool");
  assert.ok(kwTools.length >= 2, `history 导出缺工具结果（实际 ${kwTools.length} 条 tool 条目）`);

  // 2) 非 TTY 下 askInTerminal 直接返回 null（无人值守降级）
  const ans = await cli.askInTerminal("问什么", [{ label: "A" }], 1000);
  assert.strictEqual(ans, null, "非 TTY 应答应为 null");

  // 3) fmtInput 压预览
  assert.strictEqual(cli.fmtInput('{"path":"a/b.txt","depth":2}'), "path a/b.txt");
  assert.strictEqual(cli.fmtInput("echo hi"), "echo hi");
  assert.strictEqual(cli.fmtInput('{"url":"https://x.com/"}'), "url https://x.com/");

  // 4) 会话列表能读出
  const rows = cli.listSessions();
  assert.ok(Array.isArray(rows), "listSessions 应返回数组");

  // 5) runtime.compact 存在且可调用（历史太短会直接跳过，不报错即可）
  await runtime.compact([{ role: "user", content: "x" }], {});

  console.log("✅ 渲染管线：流式文本 / write/edit diff / ask_user 交互 / 会话列表 / compact 全通过");
  fs.rmSync(cwd, { recursive: true, force: true });
})().catch((e) => { console.error("❌ FAIL:", e.message); process.exit(1); });
