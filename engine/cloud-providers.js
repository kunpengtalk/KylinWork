"use strict";
/**
 * 模型云服务——服务商（渠道）目录与生命周期。
 * <p>
 * 这一层管的是「一个服务商」：内置目录 + Key + 模型清单 + 启用状态。
 * 它不直接跑模型，而是把启用且配好的服务商**物化**成 config.models 里的渠道，
 * 引擎（llm / pi-adapter）照旧只认渠道，不用改一行。
 * <p>
 * 存储：config.cloud_providers[]。老配置里已有的 config.models 渠道首次启动会被
 * 迁进来（按 base_url 对上内置预设），之后 config.models 就由这一层派生。
 */

const modelCfg = require("./model-config");

/** 目录分区：官方 / 国产 / 聚合 / 海外 / 自定义 */
const SECTIONS = ["official", "cn", "aggregator", "global", "custom"];
const SECTION_LABELS = { official: "官方", cn: "国产", aggregator: "聚合", global: "海外", custom: "自定义" };

/**
 * 内置服务商目录。
 * base_url 一律带 /v1 形式的版本段；provider 缺省 openai（OpenAI 兼容），Anthropic 单独标。
 * models 是常见模型 id 预填，用户可增删；modelTypes 用于名字看不出用途的模型。
 */
const CLOUD_PRESETS = [
  {
    id: "omnilabs", name: "OmniLabs", vendor: "OmniLabs 多模态平台", section: "official",
    baseUrl: "https://omnilabs.vibeadmin.cn/v1", color: "#6D5BFF", models: [],
  },
  {
    id: "deepseek", name: "DeepSeek", vendor: "深度求索", section: "cn",
    baseUrl: "https://api.deepseek.com/v1", color: "#4D6BFE",
    models: ["deepseek-chat", "deepseek-reasoner"], apiKeyUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "qwen-dashscope", name: "通义千问 Qwen", vendor: "阿里云百炼", section: "cn",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", color: "#615CED",
    models: ["qwen-max", "qwen-plus", "qwen-turbo", "qwen-long", "qwen-flash", "text-embedding-v3"],
    modelTypes: { "text-embedding-v3": "embedding" },
    apiKeyUrl: "https://bailian.console.aliyun.com/",
  },
  {
    id: "zhipu", name: "智谱 GLM", vendor: "智谱 AI", section: "cn",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4", color: "#3859FF",
    models: ["glm-4-plus", "glm-4-flash", "glm-4-air", "embedding-3"],
    modelTypes: { "embedding-3": "embedding" },
    apiKeyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
  },
  {
    id: "moonshot", name: "Kimi", vendor: "月之暗面", section: "cn",
    baseUrl: "https://api.moonshot.cn/v1", color: "#111827",
    models: ["kimi-latest", "moonshot-v1-128k", "moonshot-v1-32k", "moonshot-v1-8k"],
    apiKeyUrl: "https://platform.moonshot.cn/console/api-keys",
  },
  {
    id: "doubao", name: "豆包 Doubao", vendor: "字节跳动火山引擎", section: "cn",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3", color: "#3370FF",
    models: ["doubao-seed-1-6-250615", "doubao-1-5-pro-32k-250115", "doubao-1-5-lite-32k-250115"],
  },
  {
    id: "baidu", name: "文心一言", vendor: "百度千帆", section: "cn",
    baseUrl: "https://qianfan.baidubce.com/v2", color: "#2932E1",
    models: ["ernie-4.5-turbo-128k", "ernie-4.5-8k-preview", "ernie-speed-128k"],
    apiKeyUrl: "https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application",
  },
  {
    id: "hunyuan", name: "腾讯混元", vendor: "腾讯云", section: "cn",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1", color: "#0052D9",
    models: ["hunyuan-turbos-latest", "hunyuan-large", "hunyuan-standard"],
    apiKeyUrl: "https://console.cloud.tencent.com/hunyuan/api-key",
  },
  {
    id: "minimax", name: "MiniMax", vendor: "MiniMax 稀宇科技", section: "cn",
    baseUrl: "https://api.minimax.chat/v1", color: "#E5484D",
    models: ["MiniMax-M1", "MiniMax-Text-01", "abab6.5s-chat"],
  },
  {
    id: "spark", name: "讯飞星火", vendor: "科大讯飞", section: "cn",
    baseUrl: "https://spark-api-open.xf-yun.com/v1", color: "#0E5FD8",
    models: ["4.0Ultra", "generalv3.5", "generalv3", "lite"],
    apiKeyUrl: "https://console.xfyun.cn/services/cbm",
  },
  {
    id: "sensenova", name: "商汤商量", vendor: "商汤科技 SenseNova", section: "cn",
    baseUrl: "https://api.sensenova.cn/compatible-mode/v1", color: "#F2643D",
    models: ["SenseNova-V6-5", "SenseChat-5", "SenseChat-Turbo"],
  },
  {
    id: "baichuan", name: "百川大模型", vendor: "百川智能", section: "cn",
    baseUrl: "https://api.baichuan-ai.com/v1", color: "#2F6BFF",
    models: ["Baichuan4-Turbo", "Baichuan4-Air", "Baichuan4"],
  },
  {
    id: "skywork", name: "天工 Skywork", vendor: "昆仑万维", section: "cn",
    baseUrl: "https://api.tiangong.cn/v1", color: "#4472C4",
    models: ["Sky-Chat-3.0", "Skywork-13B"],
  },
  {
    id: "lingyiwanwu", name: "零一万物", vendor: "01.AI", section: "cn",
    baseUrl: "https://api.lingyiwanwu.com/v1", color: "#6E56CF",
    models: ["yi-large", "yi-lightning"],
    apiKeyUrl: "https://platform.lingyiwanwu.com/apikeys",
  },
  {
    id: "stepfun", name: "阶跃星辰", vendor: "StepFun", section: "cn",
    baseUrl: "https://api.stepfun.com/v1", color: "#10B981",
    models: ["step-1-8k", "step-1-flash"],
  },
  {
    id: "siliconflow", name: "硅基流动", vendor: "SiliconFlow", section: "aggregator",
    baseUrl: "https://api.siliconflow.cn/v1", color: "#7C3AED",
    models: ["deepseek-ai/DeepSeek-V3", "deepseek-ai/DeepSeek-R1", "Qwen/Qwen3-235B-A22B", "BAAI/bge-m3", "BAAI/bge-reranker-v2-m3"],
    modelTypes: { "BAAI/bge-m3": "embedding", "BAAI/bge-reranker-v2-m3": "rerank" },
    apiKeyUrl: "https://cloud.siliconflow.cn/account/ak",
  },
  {
    id: "openrouter", name: "OpenRouter", vendor: "第三方聚合", section: "aggregator",
    baseUrl: "https://openrouter.ai/api/v1", color: "#6467F2",
    models: ["openai/gpt-5", "anthropic/claude-sonnet-4", "google/gemini-2.5-pro"],
    apiKeyUrl: "https://openrouter.ai/keys",
  },
  {
    id: "openai", name: "OpenAI", vendor: "GPT 系列", section: "global",
    baseUrl: "https://api.openai.com/v1", color: "#10A37F",
    models: ["gpt-5", "gpt-5-mini", "text-embedding-3-large", "text-embedding-3-small"],
    modelTypes: { "text-embedding-3-large": "embedding", "text-embedding-3-small": "embedding" },
    apiKeyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "anthropic", name: "Anthropic", vendor: "Anthropic 系列", section: "global",
    baseUrl: "https://api.anthropic.com/v1", color: "#D97757", provider: "anthropic",
    models: ["claude-sonnet-4", "claude-opus-4", "claude-haiku-4"],
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "gemini", name: "Google Gemini", vendor: "Google AI", section: "global",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", color: "#4285F4",
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
    apiKeyUrl: "https://aistudio.google.com/app/apikey",
  },
  {
    id: "qwencloud", name: "Qwen Cloud", vendor: "阿里云 Qwen（国际站）", section: "global",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", color: "#615CED",
    models: ["qwen-max", "qwen-plus", "qwen-turbo"],
    apiKeyUrl: "https://modelstudio.console.alibabacloud.com/",
  },
];

const PRESET_BY_ID = new Map(CLOUD_PRESETS.map((p) => [p.id, p]));

function getPreset(id) {
  return PRESET_BY_ID.get(String(id || "")) || null;
}

function isLocalBaseUrl(url) {
  return /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(String(url || ""));
}

/** 补齐 /v1（没有版本段时）——用户手敲地址常常漏这一段 */
function normalizeApiBase(url) {
  const s = String(url || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  if (/\/v\d/i.test(s)) return s;
  if (/compatible-mode|\/api\/paas|\/api\/v\d|\/v1beta/i.test(s)) return s;
  return s + "/v1";
}

/** 小区件：用途的字面与顺序，物化拆渠道、拼渠道名时用 */
const KIND_ORDER = ["chat", "embedding", "rerank"];
const KIND_LABEL = { chat: "对话", embedding: "向量", rerank: "重排" };

/** 模型条目 → 用途（对话/向量/重排）；没标过或标了不认识的值一律当对话 */
function kindOfModel(m) {
  const k = m && m.type;
  return k === "embedding" || k === "rerank" ? k : "chat";
}

/** 按模型名猜用途（对话/向量/重排）；猜不出按对话 */
function classifyModelName(id) {
  const s = String(id || "").toLowerCase();
  if (/rerank|re-rank/.test(s)) return "rerank";
  if (/embed|bge-|gte-|text-embedding|m3e|jina-embed/.test(s)) return "embedding";
  return "chat";
}

function modelTypeOf(preset, id) {
  const mid = String(id || "").trim();
  const map = (preset && preset.modelTypes) || {};
  return map[mid] || null;
}

/** 模型 id → 条目（带用途）。预设有覆盖就用覆盖，否则按名字猜 */
function modelEntry(id, preset) {
  const mid = String(id || "").trim();
  if (!mid) return null;
  return { id: mid, type: modelTypeOf(preset, mid) || classifyModelName(mid) };
}

function normalizeModels(models, preset) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(models) ? models : []) {
    const id = String((raw && raw.id) || raw || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const guess = classifyModelName(id);
    const forced = modelTypeOf(preset, id) || (raw && raw.type);
    out.push({ id, type: ["chat", "embedding", "rerank"].includes(forced) ? forced : guess });
  }
  return out;
}

/** 配好了没有：本地地址不用 Key，其余必须有 Key；且至少一个模型 */
function providerConfigured(p) {
  const hasKey = isLocalBaseUrl(p.base_url) || !!String(p.api_key || "").trim();
  return hasKey && Array.isArray(p.models) && p.models.length > 0;
}

/** 内置服务商的官方地址不可改；自定义随意 */
function isBuiltinBaseLocked(p) {
  return !!p.builtin;
}

function newId() {
  return "custom-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 内置预设 → 服务商记录（未配置状态，供列表展示） */
function providerFromPreset(preset) {
  return {
    id: preset.id,
    preset_id: preset.id,
    name: preset.name,
    vendor: preset.vendor,
    base_url: preset.baseUrl,
    api_key: "",
    models: normalizeModels(preset.models, preset),
    enabled: false,
    kind: "chat",
    provider: preset.provider === "anthropic" ? "anthropic" : "openai",
    color: preset.color || "#64748b",
    section: preset.section,
    builtin: true,
    note: preset.note || "",
    api_key_url: preset.apiKeyUrl || "",
    created_at: 0,
    updated_at: 0,
  };
}

/** 补齐缺省字段，保证旧记录读得动 */
function normalizeProvider(p) {
  const preset = p.preset_id ? getPreset(p.preset_id) : null;
  return {
    id: String(p.id || newId()),
    preset_id: String(p.preset_id || ""),
    name: String(p.name || (preset && preset.name) || "未命名服务商"),
    vendor: String(p.vendor || (preset && preset.vendor) || ""),
    base_url: String(p.base_url || (preset && preset.baseUrl) || ""),
    api_key: String(p.api_key || ""),
    models: normalizeModels(p.models, preset),
    enabled: !!p.enabled,
    kind: ["embedding", "rerank"].includes(p.kind) ? p.kind : "chat",
    provider: p.provider === "anthropic" ? "anthropic" : "openai",
    color: String(p.color || (preset && preset.color) || "#64748b"),
    section: String(p.section || (preset && preset.section) || "custom"),
    builtin: !!p.builtin,
    note: String(p.note || (preset && preset.note) || ""),
    api_key_url: String(p.api_key_url || (preset && preset.apiKeyUrl) || ""),
    created_at: +p.created_at || 0,
    updated_at: +p.updated_at || 0,
  };
}

function ensureStore(config) {
  if (!Array.isArray(config.cloud_providers)) config.cloud_providers = [];
  return config.cloud_providers;
}

/** 按 base_url 认领一个内置预设（迁移老渠道时用） */
function presetByBaseUrl(url) {
  const u = String(url || "").trim().replace(/\/+$/, "").toLowerCase();
  if (!u) return null;
  return CLOUD_PRESETS.find((p) => p.baseUrl.replace(/\/+$/, "").toLowerCase() === u) || null;
}

/** 按名字认领内置预设：老渠道 base_url 为空（如 Anthropic）时靠名字兜底 */
function presetByName(name) {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return null;
  return (
    CLOUD_PRESETS.find((p) => p.name.toLowerCase() === n) ||
    CLOUD_PRESETS.find((p) => n.includes(p.name.toLowerCase()) || p.name.toLowerCase().includes(n)) ||
    null
  );
}

/**
 * 首次启动迁移：把 config.models 里已有的渠道搬进 cloud_providers，
 * Key / 模型 / 高级参数原样保留，绝不因为上了新界面就把用户配好的东西弄丢。
 */
function ensureMigrated(config) {
  const store = ensureStore(config);
  if (config.__cloud_migrated) return store;

  const used = new Set(store.map((p) => p.id));
  for (const ch of Array.isArray(config.models) ? config.models : []) {
    if (ch.cloud_id) continue; // 已经是派生渠道
    const preset = presetByBaseUrl(ch.base_url) || presetByName(ch.name);
    let id = preset ? preset.id : newId();
    // 预设 id 已经被占用（同名自定义渠道）→ 退回自定义 id，别把这条渠道吞掉
    if (used.has(id)) id = newId();
    used.add(id);
    const models = modelCfg.modelIds(ch);
    const rec = normalizeProvider({
      id,
      preset_id: preset ? preset.id : "",
      name: String(ch.name || (preset && preset.name) || "未命名服务商"),
      vendor: preset ? preset.vendor : "",
      base_url: ch.base_url || (preset && preset.baseUrl) || "",
      api_key: ch.api_key || "",
      models: models.map((mid) => ({ id: mid, type: modelTypeOf(preset, mid) || null })),
      enabled: true, // 已经配好的老渠道，默认就是启用的
      kind: modelCfg.kindOf(ch),
      provider: ch.provider === "anthropic" ? "anthropic" : "openai",
      color: preset ? preset.color : "#64748b",
      section: preset ? preset.section : "custom",
      builtin: !!preset,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    store.push(rec);
  }
  config.__cloud_migrated = true;
  // 迁移会把 config.models 清空再按服务商重建：配不全的服务商不会变成渠道。以前是静默丢，
  // 用户只看到「渠道少了」却不知道为什么——这里点名说清楚。
  const skipped = skippedProviders(config);
  if (skipped.length) {
    console.warn(
      `[模型云服务] 迁移完成，但有 ${skipped.length} 个服务商没配全，未生成模型渠道：` +
        skipped.map((s) => `${s.name}（${s.reason}）`).join("、")
    );
  }
  return store;
}

/**
 * 物化：启用且配好的服务商 → config.models 渠道。
 * 手写渠道（没有 cloud_id 的）保留不动，两者共存。
 * <p>
 * 一家服务商可能同时提供对话 / 向量 / 重排模型（聚合平台尤其如此），所以按模型自己的
 * type 拆成多条渠道——用途看的是「这个模型」，不是「这家服务商」。拆出来的渠道里，
 * 与服务商主用途一致的那条沿用服务商原名（知识库里的「渠道::模型」复合键因此不会失联），
 * 其余加「· 向量 / · 重排」后缀区分。
 */
function materializeChannels(config) {
  const store = ensureStore(config);
  const manual = (Array.isArray(config.models) ? config.models : []).filter((m) => !m.cloud_id);
  const derived = [];
  for (const p of store) {
    if (!p.enabled || !providerConfigured(p)) continue;
    const primary = kindOfModel({ type: p.kind });
    const models = (Array.isArray(p.models) ? p.models : [])
      .map((m) => ({ id: String((m && m.id) || m || "").trim(), kind: kindOfModel(m) }))
      .filter((m) => m.id);
    for (const kind of [primary, ...KIND_ORDER.filter((k) => k !== primary)]) {
      const ids = models.filter((m) => m.kind === kind).map((m) => m.id);
      if (!ids.length) continue;
      derived.push({
        name: kind === primary ? p.name : `${p.name} · ${KIND_LABEL[kind]}`,
        provider: p.provider === "anthropic" ? "anthropic" : "openai",
        base_url: p.base_url,
        api_key: p.api_key || "",
        model: ids[0],
        models: ids,
        kind,
        cloud_id: p.id,
      });
    }
  }
  config.models = [...manual, ...derived];
  modelCfg.normalizeChannels(config);
  return config.models;
}

/** 列表：内置目录（未配置的补一行占位）+ 已保存的服务商 */
function listProviders(config) {
  const store = ensureMigrated(config);
  const saved = new Map(store.map((p) => [p.id, normalizeProvider(p)]));
  const out = [];
  for (const preset of CLOUD_PRESETS) {
    out.push(saved.get(preset.id) || providerFromPreset(preset));
  }
  for (const p of store) {
    if (!getPreset(p.id) && !p.preset_id) out.push(normalizeProvider(p));
  }
  // 只挂 preset_id 但 id 不是预设 id 的记录（少见）也带上
  for (const p of store) {
    if (!out.some((x) => x.id === p.id)) out.push(normalizeProvider(p));
  }
  return out.map(toPublic);
}

/** 给前端的形状：不外泄内部字段名风格差异 */
function toPublic(p) {
  return {
    id: p.id,
    preset_id: p.preset_id,
    name: p.name,
    vendor: p.vendor,
    base_url: p.base_url,
    api_key: p.api_key,
    has_key: !!String(p.api_key || "").trim(),
    models: p.models,
    enabled: p.enabled,
    kind: p.kind,
    provider: p.provider,
    color: p.color,
    section: p.section,
    builtin: p.builtin,
    note: p.note,
    api_key_url: p.api_key_url,
    configured: providerConfigured(p),
    base_locked: isBuiltinBaseLocked(p),
    is_default_base: p.builtin && p.base_url === (getPreset(p.preset_id) || {}).baseUrl,
    local: isLocalBaseUrl(p.base_url),
  };
}

function findProvider(config, id) {
  const store = ensureStore(config);
  return store.find((p) => p.id === String(id || "")) || null;
}

/** 新建 / 更新服务商。传 preset_id 时按内置预设建；否则建自定义 */
function upsertProvider(config, input) {
  const store = ensureStore(config);
  const b = input || {};
  let id = String(b.id || "").trim();
  // 预设既可能从 preset_id 来，也可能 id 本身就是预设 id（内置服务商）
  const preset = getPreset(b.preset_id || id);
  if (!id && preset) id = preset.id;
  if (!id) id = newId();

  let rec = store.find((p) => p.id === id);
  const now = Date.now();
  if (!rec) {
    rec = normalizeProvider(preset ? { ...providerFromPreset(preset), id } : { id, section: "custom", created_at: now });
    rec.created_at = now;
    store.push(rec);
  }

  if (b.name !== undefined && !rec.builtin) rec.name = String(b.name || "").trim() || rec.name;
  if (b.base_url !== undefined && !rec.builtin) rec.base_url = String(b.base_url || "").trim();
  if (b.api_key !== undefined) rec.api_key = String(b.api_key || "");
  if (b.models !== undefined) rec.models = normalizeModels(b.models, preset);
  if (b.enabled !== undefined) rec.enabled = !!b.enabled;
  if (b.kind !== undefined) rec.kind = ["embedding", "rerank"].includes(b.kind) ? b.kind : "chat";
  if (b.provider !== undefined && !rec.builtin) rec.provider = b.provider === "anthropic" ? "anthropic" : "openai";
  rec.updated_at = now;

  if (rec.builtin && preset) {
    // 内置服务商地址锁死，模型名保持展示名一致
    rec.base_url = preset.baseUrl;
    rec.name = preset.name;
    rec.vendor = preset.vendor;
    rec.color = preset.color;
    rec.section = preset.section;
  }
  return toPublic(normalizeProvider(rec));
}

function deleteProvider(config, id) {
  const store = ensureStore(config);
  const p = findProvider(config, id);
  if (!p) throw new Error("没有这个服务商");
  if (p.builtin) throw new Error("内置服务商不能删除，关掉开关或清空 Key 即可");
  config.cloud_providers = store.filter((x) => x.id !== p.id);
  return { ok: true };
}

/** 拉远端 /models：给还没落盘的新输入也能测 */
function modelListUrls(base) {
  const b = String(base || "").replace(/\/+$/, "");
  if (/\/v\d/i.test(b)) return [b + "/models"];
  return [b + "/models", b + "/v1/models"];
}

async function readModelList(url, headers, timeoutMs) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs || 15000) });
  if (!r.ok) {
    const txt = (await r.text()).slice(0, 200);
    const hint =
      r.status === 401 || r.status === 403 ? "Key 没通过校验" :
      r.status === 404 ? "这家服务商没有 /models 接口，只能手填模型 id" :
      `上游返回 HTTP ${r.status}`;
    const err = new Error(`${hint}：${txt}`);
    err.status = r.status;
    throw err;
  }
  const text = await r.text();
  const d = JSON.parse(text.replace(/^\uFEFF/, ""));
  const raw = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : Array.isArray(d?.models) ? d.models : [];
  return [...new Set(raw.map((x) => String((x && (x.id || x.name)) || x || "").trim()).filter(Boolean))].sort();
}

async function fetchRemoteModels({ baseUrl, apiKey, provider, timeoutMs }) {
  const anthropic = provider === "anthropic";
  const key = String(apiKey || "").trim();
  const headers = anthropic
    ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
    : { Authorization: `Bearer ${key || "ollama"}` };
  let lastErr = null;
  for (const url of modelListUrls(baseUrl)) {
    try {
      return { ok: true, models: await readModelList(url, headers, timeoutMs) };
    } catch (e) {
      if (e && (e.status === 401 || e.status === 403 || e.status === 429)) return { ok: false, error: e.message };
      lastErr = e;
    }
  }
  return { ok: false, error: String((lastErr && lastErr.message) || lastErr || "拉取失败").slice(0, 200) };
}

/** 检查连接：先看模型列表认不认（比只打一个状态码准），认不认都给出人话原因 */
async function checkConnection({ baseUrl, apiKey, provider }) {
  const r = await fetchRemoteModels({ baseUrl, apiKey, provider, timeoutMs: 8000 });
  if (r.ok) return { ok: true, count: (r.models || []).length };
  return { ok: false, error: r.error };
}

/**
 * 已启用却没配全、因此不会出现在模型渠道里的服务商（迁移/物化时被跳过的就是这些）。
 * 只报「用户动过」的：填过 Key、挑过模型、或者自建的。内置预设没动过的一律 enabled 但空着，
 * 把它们全列出来只是噪音，不是「被丢掉的那批」。
 */
function skippedProviders(config) {
  return ensureStore(config)
    .filter((p) => {
      if (!p.enabled || providerConfigured(p)) return false;
      const touched =
        !!String(p.api_key || "").trim() || (Array.isArray(p.models) && p.models.length > 0) || !p.builtin;
      return touched;
    })
    .map((p) => ({
      id: p.id,
      name: String(p.name || p.id),
      reason: !(isLocalBaseUrl(p.base_url) || String(p.api_key || "").trim())
        ? "缺 API Key"
        : "没有可用模型",
    }));
}

module.exports = {
  SECTIONS,
  SECTION_LABELS,
  CLOUD_PRESETS,
  getPreset,
  isLocalBaseUrl,
  normalizeApiBase,
  classifyModelName,
  normalizeModels,
  providerConfigured,
  skippedProviders,
  listProviders,
  findProvider,
  upsertProvider,
  deleteProvider,
  ensureMigrated,
  materializeChannels,
  fetchRemoteModels,
  checkConnection,
};
