"use strict";
/**
 * 模型渠道配置的统一口径。
 * <p>
 * 一个渠道 = 一个服务商（name / provider / base_url / api_key），名下可以挂多个模型 id
 * （ch.models[]）。用户真正选中跑任务的是「渠道 + 模型 id」这一对：
 * 全局是 config.active_model + config.active_model_id，单个对话是 sess.model + sess.model_id，
 * 助理是 config.assist_model + config.assist_model_id。
 * <p>
 * pi / llm / agent / index 四处都要解这同一件事，散着写迟早跑偏，所以集中在这里。
 */

/** 渠道下所有模型 id（去重；老配置只有 model 字段时用它顶上）。默认模型（model）排最前 */
function modelIds(ch) {
  const ids = [];
  const add = (raw) => {
    const s = String(raw || "").trim();
    if (s && !ids.includes(s)) ids.push(s);
  };
  add(ch && ch.model); // 默认模型是渠道的首选项，展示与调用都以它为第一顺位
  if (ch && Array.isArray(ch.models)) for (const m of ch.models) add(m);
  return ids;
}

/** 按渠道名找渠道（名字是渠道的身份，active_model / sess.model 存的都是它） */
function findChannel(config, name) {
  const list = (config && config.models) || [];
  const want = String(name || "").trim();
  if (!want) return null;
  return list.find((m) => String(m.name || "").trim() === want) || null;
}

/** 渠道 + 想要的模型 id → 真正可用的模型 id；不在册就退回渠道默认，再退回第一个 */
function pickModelId(ch, want) {
  const ids = modelIds(ch);
  const w = String(want || "").trim();
  if (w && ids.includes(w)) return w;
  const def = String((ch && ch.model) || "").trim();
  if (def && ids.includes(def)) return def;
  return ids[0] || w || "";
}

/** 全局当前选中的渠道 + 模型 id */
function activeSelection(config) {
  const list = (config && config.models) || [];
  const ch = findChannel(config, config && config.active_model) || list[0] || null;
  if (!ch) return null;
  return { channel: ch, name: String(ch.name || ""), modelId: pickModelId(ch, config && config.active_model_id) };
}

/** 选中项的唯一键：健康账本和前端下拉的值都用它（同名多模型不会互相串账） */
function selectionKey(name, modelId) {
  const n = String(name || "").trim();
  const id = String(modelId || "").trim();
  if (!n) return id;
  return id ? `${n}::${id}` : n;
}

/** 把 selectionKey 还原成 { name, modelId }（前端传回来的复合值在这里拆） */
function parseSelectionKey(key) {
  const s = String(key || "");
  const i = s.indexOf("::");
  if (i < 0) return { name: s, modelId: "" };
  return { name: s.slice(0, i), modelId: s.slice(i + 2) };
}

/** 渠道用途：对话 / 向量(embedding) / 重排(rerank)。老配置没有这个字段，一律当对话渠道 */
function kindOf(ch) {
  const k = ch && ch.kind;
  return k === "embedding" || k === "rerank" ? k : "chat";
}

/** 某类用途的渠道列表（对话渠道给模型选择器用，向量/重排给知识库设置用） */
function channelsByKind(config, kind) {
  return ((config && config.models) || []).filter((m) => kindOf(m) === kind);
}

/** 两个字符串数组是否逐项相同（用来判断规范化有没有真的改动，不必整配置序列化比对） */
function sameIds(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/** 就地补齐老配置，并让 active_model / active_model_id 落到合法值上。返回是否改动过 */
function normalizeChannels(config) {
  if (!config || !Array.isArray(config.models)) return false;
  let changed = false;
  for (const ch of config.models) {
    const ids = modelIds(ch);
    if (!sameIds(ch.models, ids)) changed = true;
    ch.models = ids;
    if (!String(ch.model || "").trim() && ch.models.length) {
      ch.model = ch.models[0];
      changed = true;
    }
    const k = kindOf(ch); // 规范化：不认识的值退回 chat
    if (ch.kind !== k) {
      ch.kind = k;
      changed = true;
    }
  }
  const prevName = String(config.active_model || "");
  const prevId = String(config.active_model_id || "");
  // 默认模型只能落在对话渠道上——向量/重排渠道不该被当成聊天模型选中
  const current = findChannel(config, config.active_model);
  const currentOk = !!current && kindOf(current) === "chat";
  const sel = (currentOk && current) || config.models.find((m) => kindOf(m) === "chat") || config.models[0] || null;
  if (sel) {
    if (!currentOk) config.active_model = String(sel.name || "");
    config.active_model_id = pickModelId(sel, currentOk ? config.active_model_id : "");
  } else {
    config.active_model = "";
    config.active_model_id = "";
  }
  if (String(config.active_model || "") !== prevName || String(config.active_model_id || "") !== prevId) changed = true;
  return changed;
}

module.exports = { modelIds, findChannel, pickModelId, activeSelection, selectionKey, parseSelectionKey, normalizeChannels, kindOf, channelsByKind };
