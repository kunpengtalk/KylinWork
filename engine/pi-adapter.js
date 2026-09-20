"use strict";
/**
 * pi(0.85 SDK) 适配层 — 把 @earendil-works/pi-coding-agent 的 AgentSession
 * 包成 KylinWork 需要的形状。只做"会话驱动 / 事件映射 / 工具定义 / 模型渠道",
 * 全部 KylinWork 策略（成果核验、循环检测、看门狗、failover、自动续跑…）留在 agent.js。
 *
 * pi 是纯 ESM，这里是 CJS → 所有 pi 对象一律经动态 import() 拿，严禁顶层 require。
 */

const os = require("os");
const path = require("path");
const fs = require("fs");
const { getWorkspaceDir } = require("./tools");
const modelCfg = require("./model-config");

let _pi = null;
/** 懒加载 pi-coding-agent SDK（ESM） */
function pi() {
  if (!_pi) _pi = import("@earendil-works/pi-coding-agent");
  return _pi;
}

// ================= 模型渠道：config.json models[] → pi Provider =================
// KylinWork 的渠道全是"名字 + base_url + api_key + model id"，pi 的 OpenAI 兼容
// 协议（openai-completions）完全对得上；内置 provider 表（deepseek/openrouter…）会被
// 这里的显式注册覆盖，保证 config.json 是唯一事实源。
/**
 * 把 KylinWork 渠道注册进 pi ModelRuntime。
 * setRuntimeApiKey 是异步的，必须等它落定再返回——否则后面的调用会竞态报
 * "Provider is not configured"（第一次跑通、第二次失败就是没等它）。
 */
async function registerConfigProviders(mr, config) {
  const models = Array.isArray(config.models) ? config.models : [];
  const jobs = [];
  let added = 0;
  for (const m of models) {
    const providerId = String(m.name || "").trim();
    // 一个渠道挂多个模型：全部注册进同一个 provider，选中哪个由 resolveModel 决定
    const ids = modelCfg.modelIds(m);
    if (!providerId || !m.base_url || !ids.length) continue;
    try {
      mr.registerProvider(providerId, {
        name: providerId,
        baseUrl: String(m.base_url),
        api: String(m.api || "openai-completions"),
        models: ids.map((id) => ({
          id: String(id),
          name: String(id),
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: Number(m.context_window) || 128000,
          maxTokens: Number(m.max_tokens) || 8192,
          // DeepSeek/Qwen/GLM 这些用 OpenAI 兼容层时若有专有字段，走 compat 兜底
          compat: m.compat || undefined,
        })),
      });
      if (m.api_key) {
        jobs.push(
          mr.setRuntimeApiKey(providerId, String(m.api_key)).catch((e) =>
            console.warn("[pi] 渠道密钥注入失败", providerId, e && e.message)
          )
        );
      }
      added++;
    } catch (e) {
      console.warn("[pi] 渠道注册失败", providerId, e && e.message);
    }
  }
  await Promise.all(jobs);
  return added;
}

/** 建 ModelRuntime（不联网刷目录、不碰用户的 ~/.pi） */
async function createModelRuntime(config, opts = {}) {
  const { ModelRuntime } = await pi();
  const agentDir = opts.agentDir || path.join(os.tmpdir(), "kylinwork-pi-agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const mr = await ModelRuntime.create({
    refreshOnCreate: false,
    allowModelNetwork: false,
    modelsPath: null, // 渠道全部来自 registerProvider，不走 models.json
    authPath: path.join(agentDir, "auth.json"),
  });
  await registerConfigProviders(mr, config);
  return mr;
}

/** 按渠道名 + 模型 id 取 pi Model（渠道 = config.models[] 的 name，如 "DeepSeek"；也认模型 id） */
function resolveModel(mr, config, providerName, modelId) {
  const name = String(providerName || config.active_model || "").trim();
  if (!name) return undefined;
  const entries = Array.isArray(config.models) ? config.models : [];
  // 先按渠道名精确匹配，再按模型 id 匹配（有些老配置把两者混用）
  let entry = entries.find((m) => String(m.name || "").trim() === name);
  let matchedById = false;
  if (!entry) {
    const byId = entries.filter((m) => modelCfg.modelIds(m).includes(name));
    if (byId.length === 1) {
      entry = byId[0];
      matchedById = true;
      if (mr.registerProvider) ensureRegistered(mr, entry);
    }
  }
  if (!entry) return undefined;
  // 没显式给 modelId 时：按 model id 命中的就用它本身；name 是当前选中渠道就用全局选中项；否则用渠道默认
  const want =
    modelId != null && modelId !== ""
      ? modelId
      : matchedById
        ? name
        : String(entry.name) === name
          ? config.active_model_id
          : "";
  const id = modelCfg.pickModelId(entry, want);
  if (!id) return undefined;
  return mr.getModel(String(entry.name), id) || mr.getModel(name, id);
}

function ensureRegistered(mr, entry) {
  // 防御：按 model id 匹配时渠道未必注册过（通常 registerConfigProviders 已全量注册）
  const ids = modelCfg.modelIds(entry);
  for (const id of ids) {
    if (mr.getModel(String(entry.name), id)) return;
  }
  try {
    mr.registerProvider(String(entry.name), {
      name: String(entry.name),
      baseUrl: String(entry.base_url),
      api: String(entry.api || "openai-completions"),
      models: ids.map((id) => ({ id: String(id), name: String(id), reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: Number(entry.context_window) || 128000, maxTokens: Number(entry.max_tokens) || 8192 })),
    });
  } catch (e) { console.warn("[pi] 渠道补注册失败", entry.name, e && e.message); }
}

// ================= 工具定义：TOOL_DEFS 的 JSON-Schema → TypeBox =================
function baseType(v) {
  const t = v || {};
  switch (t.type) {
    case "boolean": return { type: "boolean" };
    case "integer":
    case "number": return { type: "number" };
    case "array": return { type: "array", items: t.items ? baseType(t.items) : { type: "any" } };
    case "object": {
      const props = {};
      for (const [k, vv] of Object.entries(t.properties || {})) props[k] = baseType(vv);
      return { type: "object", properties: props };
    }
    case "null": return { type: "null" };
    case "string":
      if (Array.isArray(t.enum) && t.enum.length) {
        return { type: "string", enum: t.enum.map(String) };
      }
      return { type: "string" };
    default: return { type: "any" };
  }
}

/**
 * 把 TOOL_DEFS 的 input_schema（JSON-Schema 子集）转成 TypeBox schema。
 * 不用 typebox 包：pi 的 TypeBox 校验接受"同构的 schema 对象"
 * （type/properties/required/items/enum），运行时只读这些字段。
 */
function schemaToPiSchema(schema) {
  const root = schema || {};
  if (root.type !== "object") return { type: "object", properties: {} };
  const required = new Set(Array.isArray(root.required) ? root.required : []);
  const properties = {};
  for (const [k, v] of Object.entries(root.properties || {})) {
    const bt = baseType(v);
    if (!required.has(k)) bt.description = v && v.description; // 描述放 description 即可
    properties[k] = bt;
  }
  return { type: "object", properties, required: [...required] };
}

/**
 * 把 KylinWork 工具定义批量包成 pi ToolDefinition。
 * @param defs [{name, description, input_schema}]
 * @param handler (name, params, signal) => Promise<{content, isError, diff?}>
 * @param readOnly 只读工具名集合（允许 pi 并发执行，其余标 sequential）
 */
function buildPiTools(defs, handler, opts = {}) {
  const readOnly = opts.readOnly || new Set();
  return (defs || []).map((def) => ({
    name: def.name,
    label: def.name,
    description: String(def.description || ""),
    parameters: schemaToPiSchema(def.input_schema),
    executionMode: readOnly.has(def.name) ? "parallel" : "sequential",
    execute: async (toolCallId, params, signal) => {
      const r = await handler(def.name, params, signal);
      if (r && r.isError) {
        const err = new Error(String(r.content || def.name + " 执行失败"));
        err.hostContent = r; // 迭代兜底：详情留在 errors 里也读得到
        throw err;
      }
      return {
        content: [{ type: "text", text: String((r && r.content) || "（无输出）") }],
        details: { diff: r && r.diff },
      };
    },
  }));
}

// ================= 会话历史双向转换（KylinWork ↔ pi Message） =================
function zeroUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
function contentText(content) {
  return String(
    (Array.isArray(content) ? content : [])
      .filter((c) => c && c.type === "text")
      .map((c) => c.text || "")
      .join("") || ""
  );
}

/** KylinWork history → pi Message[]（assistant 的 toolCalls 转成 ToolCall 内容块） */
function convertHistoryToPi(kwHistory) {
  const out = [];
  const ts = Date.now();
  for (const e of kwHistory || []) {
    if (!e) continue;
    if (e.role === "user") {
      out.push({ role: "user", content: String(e.content ?? ""), timestamp: ts });
    } else if (e.role === "assistant") {
      const content = [];
      if (e.text) content.push({ type: "text", text: String(e.text) });
      for (const tc of e.toolCalls || []) {
        content.push({ type: "toolCall", id: String(tc.id || "tc_hist"), name: String(tc.name || ""), arguments: tc.input || {} });
      }
      out.push({
        role: "assistant", content, provider: "kylinwork", model: "history", usage: zeroUsage(),
        stopReason: "end", timestamp: ts,
      });
    } else if (e.role === "tool") {
      for (const r of e.results || []) {
        out.push({
          role: "toolResult", toolCallId: String(r.id || "tc_hist"), toolName: String(r.name || "tool"),
          content: [{ type: "text", text: String(r.content ?? "") }], isError: !!r.isError, timestamp: ts,
        });
      }
    }
  }
  return out;
}

/** pi Message[] → KylinWork history（专家/普通回合都能导出；toolResult 挂回所属 assistant） */
function convertPiToHistory(piMessages) {
  const out = [];
  for (const m of piMessages || []) {
    if (!m) continue;
    if (m.role === "user") {
      out.push({ role: "user", content: typeof m.content === "string" ? m.content : contentText(m.content) });
    } else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        text: contentText(m.content),
        toolCalls: (m.content || [])
          .filter((c) => c && c.type === "toolCall")
          .map((c) => ({ id: c.id, name: c.name, input: c.arguments || {} })),
        // 只留轻量元数据：整包 AssistantMessage（thinking 块能比正文大好几倍）落盘
        // 会把 data/sessions/*.json 撑爆，用 chars 记真实体积，上下文估算照样准
        raw: {
          usage: m.usage,
          stopReason: m.stopReason,
          // 模型报错时把原因留底（如 "Authentication Fails, Your api key ... is invalid"），
          // 否则会话里只剩一个 0 token 的空回复，查问题两眼一抹黑
          error: m.errorMessage || "",
          provider: m.provider,
          model: m.model,
          chars: JSON.stringify(m).length,
        },
      });
    } else if (m.role === "toolResult") {
      const text = contentText(m.content);
      // 找它所属的 assistant（同一条 user 消息范围内），插到它后面
      let target = -1;
      for (let i = out.length - 1; i >= 0; i--) {
        const en = out[i];
        if (en.role === "user") break;
        if (en.role === "assistant" && (en.toolCalls || []).some((t) => t.id === m.toolCallId)) { target = i; break; }
      }
      const ins = () => ({ role: "tool", results: [{ id: m.toolCallId, name: m.toolName, content: text, isError: !!m.isError }] });
      if (target < 0) {
        out.push(ins());
      } else {
        const after = out[target + 1];
        if (after && after.role === "tool") after.results.push({ id: m.toolCallId, name: m.toolName, content: text, isError: !!m.isError });
        else out.splice(target + 1, 0, ins());
      }
    }
  }
  return out;
}

// ================= 会话驱动：一次 runTask = 一个 pi 会话 =================
/**
 * 创建一次任务运行的 pi 会话驱动。
 * @param {Object} o
 *  - config, modelRuntime, model
 *  - systemPrompt  组装好的系统提示词
 *  - kwHistory     含最新用户消息（驱动会把它拆成"种子 + 本次指令"）
 *  - tools         pi ToolDefinition[]（已包装好）
 *  - cwd, baseDir
 *  - emit          事件回调（text/step_start/tool_use/tool_result/...）
 *  - host          { beforeToolCall, afterToolResult, onTurnEnd, onMessageEnd,
 *                    onAgentEnd, onError }
 * 返回 { session, text(prompt 文本), prompt(), abort(), steer(), setModelByProvider(),
 *        setActiveTools, lastAssistantText, exportHistory, revert（回滚种子）, dispose }
 */
async function createPiSessionDriver(o) {
  const { createAgentSession, SessionManager, SettingsManager, DefaultResourceLoader, CURRENT_SESSION_VERSION } = await pi();
  const { config, modelRuntime, model, systemPrompt, kwHistory, tools, emit, host = {} } = o;
  const cwd = o.cwd || getWorkspaceDir();
  const depth = o.depth || 0;
  const agentDir = o.agentDir || path.join(os.tmpdir(), "kylinwork-pi-agent");
  fs.mkdirSync(agentDir, { recursive: true });

  // 拆：最后一条 user 消息 = 本次指令；更早的 = 种子上下文
  let lastUser = -1;
  for (let i = (kwHistory || []).length - 1; i >= 0; i--) {
    if (kwHistory[i] && kwHistory[i].role === "user") { lastUser = i; break; }
  }
  const seed = convertHistoryToPi(lastUser > 0 ? kwHistory.slice(0, lastUser) : []);
  const promptText = lastUser >= 0 ? String(kwHistory[lastUser].content ?? "") : "";

  // 历史播种走官方入口 SessionManager.inMemory(cwd, options, entries)：
  // 直接改 session.state.messages 绕过了会话树（leaf/parentId/stats），
  // pi 内部的 branch/fork/压缩/用量统计都读这棵树，写歪了会静默出错。
  const sessionId = "kw-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const nowIso = new Date().toISOString();
  const entries = [{ type: "session", version: CURRENT_SESSION_VERSION, id: sessionId, timestamp: nowIso, cwd }];
  let parentId = null;
  for (let i = 0; i < seed.length; i++) {
    const id = `${sessionId}:${i}`;
    entries.push({ type: "message", id, parentId, timestamp: nowIso, message: seed[i] });
    parentId = id;
  }

  // pi 自带压缩保留作兜底，但阈值压到"真正逼近窗口"才动手：
  // 上下文治理的主力是 KylinWork 的 compactHistory（指令原文机械保留 + 归档到 data/compact-archive），
  // 它按字符阈值早得多就触发；两套同时压会互相打断、还各写一份归档。
  const ctxWindow = Number(model && model.contextWindow) || 128000;
  const reserve = Math.max(4000, Math.floor(ctxWindow * 0.15));

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    systemPrompt: String(systemPrompt || ""),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd,
    sessionManager: SessionManager.inMemory(cwd, { id: sessionId }, entries),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: reserve, keepRecentTokens: reserve },
    }),
    modelRuntime,
    model,
    thinkingLevel: (config.agent && config.agent.thinking_level) || "off",
    noTools: "builtin", // 只留我们注册的 KylinWork 工具
    customTools: tools,
    resourceLoader: loader,
  });
  // 并行播报：pi 的事件时序是「一批 start 连续到达 + 随后结果并行回」，
  // 所以按批计数：第一个结果回来时整批已全部 start，此时按整批数量播报一次
  let batchStarts = 0;
  let batchEnds = 0;
  let parallelNotified = false;
  let turn = 0;
  const callArgs = new Map(); // toolCallId → args（tool_execution_end 不带 args，来源挖掘要用）

  const unsubscribe = session.subscribe((ev) => {
    if (host.onAny) host.onAny(ev);
    if (ev.type === "message_update" && ev.assistantMessageEvent && ev.assistantMessageEvent.type === "text_delta") {
      emit({ type: "text", delta: ev.assistantMessageEvent.delta, depth });
    } else if (ev.type === "state") {
      // 思考状态切换不播报，避免噪音
    } else if (ev.type === "thinking_delta") {
      // 模型的内部独白默认不播（刷屏且不是交付内容）；排查"它到底在想什么"时开 agent.show_thinking
      if (o.showThinking && ev.delta) emit({ type: "thinking", delta: ev.delta, depth });
    } else if (ev.type === "tool_execution_update") {
      // 工具边跑边吐的增量：证明这条调用还活着，长工具（抓页面、跑批）靠它续命
      if (host.onToolUpdate) host.onToolUpdate({ id: ev.toolCallId, name: ev.toolName, delta: ev.delta });
    } else if (ev.type === "tool_execution_start") {
      batchStarts++;
      callArgs.set(ev.toolCallId, ev.args);
      emit({
        type: "tool_use",
        id: ev.toolCallId,
        name: ev.toolName,
        depth,
        purpose: "",
        input_preview: previewArgs(ev.args),
      });
    } else if (ev.type === "tool_execution_end") {
      batchEnds++;
      if (batchStarts >= 2 && !parallelNotified) {
        parallelNotified = true;
        emit({ type: "parallel", count: batchStarts, depth });
      }
      const text = ev.result && ev.result.content ? contentText(ev.result.content) : "";
      if (host.afterToolResult) host.afterToolResult({ name: ev.toolName, content: text, isError: ev.isError });
      emit({
        type: "tool_result",
        id: ev.toolCallId,
        name: ev.toolName,
        depth,
        isError: ev.isError,
        preview: text.slice(0, 800),
        diff: ev.result && ev.result.details && ev.result.details.diff,
      });
      // 来源挖掘：fetch_url/render_page/web_search 真拿到的东西才报（与旧逻辑一致）
      if (o.collectSources && !ev.isError) {
        const args = callArgs.get(ev.toolCallId);
        const srcs = o.collectSources(ev.toolName, args, text);
        if (srcs && srcs.length) emit({ type: "sources", items: srcs, depth });
      }
      callArgs.delete(ev.toolCallId);
      if (batchEnds >= batchStarts) { batchStarts = 0; batchEnds = 0; parallelNotified = false; }
    } else if (ev.type === "turn_start") {
      turn++;
      emit({ type: "step_start", step: turn, depth });
    } else if (ev.type === "turn_end") {
      batchStarts = 0; // 兜底：批次若被中断（abort），别把计数留给下一轮
      batchEnds = 0;
      parallelNotified = false;
      if (host.onTurnEnd) host.onTurnEnd({ turn });
    } else if (ev.type === "message_end" && ev.message && ev.message.usage) {
      if (host.onMessageEnd) host.onMessageEnd({ message: ev.message });
    } else if (ev.type === "agent_end") {
      if (host.onAgentEnd) host.onAgentEnd({ messages: ev.messages, willRetry: ev.willRetry });
    } else if (ev.type === "auto_retry_end") {
      if (host.onRetryEnd) host.onRetryEnd(ev);
    } else if (ev.type === "compaction_end") {
      if (host.onCompactionEnd) host.onCompactionEnd(ev);
    }
  });

  return {
    session,
    text: promptText,
    async prompt(text, opts) {
      await session.prompt(text || promptText, { source: "interactive", ...(opts || {}) });
    },
    async abort() {
      try { await session.abort(); } catch {}
    },
    async steer(text) {
      try { await session.steer(text); } catch (e) { console.warn("[pi] steer 失败:", e.message); }
    },
    async setModelByProvider(providerName, modelId) {
      const m = resolveModel(modelRuntime, config, providerName, modelId);
      if (!m) return false;
      await session.setModel(m);
      return true;
    },
    setActiveTools(names) {
      try { session.setActiveToolsByName(names || []); } catch {}
    },
    lastAssistantText: () => session.getLastAssistantText(),
    exportHistory: () => convertPiToHistory(session.messages),
    usage: () => {
      try {
        const s = session.getSessionStats();
        return { prompt: s.tokens.input, completion: s.tokens.output, cached: s.tokens.cacheRead, calls: 0, totalMessages: s.totalMessages };
      } catch { return null; }
    },
    dispose() {
      try { unsubscribe(); } catch {}
      try { session.dispose(); } catch {}
    },
  };
}

/** 工具参数预览：run 类给代码/命令，其余给第一个关键字段（与旧 previewInput 一致的口径） */
function previewArgs(args) {
  const a = args || {};
  for (const k of ["purpose", "code", "command", "path", "url", "query", "name", "title", "expert"]) {
    if (a[k] != null) {
      const s = String(a[k]).trim();
      return s.length > 160 ? s.slice(0, 160) + "…" : s;
    }
  }
  try {
    const s = JSON.stringify(a);
    return s.length > 200 ? s.slice(0, 200) + "…" : s;
  } catch {
    return "";
  }
}

module.exports = {
  pi,
  createModelRuntime,
  resolveModel,
  registerConfigProviders,
  schemaToPiSchema,
  buildPiTools,
  convertHistoryToPi,
  convertPiToHistory,
  createPiSessionDriver,
  previewArgs,
};
