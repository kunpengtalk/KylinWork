"use strict";
/**
 * 模型云服务 HTTP 接口：服务商目录 / Key / 连通性 / 远端模型清单。
 *
 * 从 index.js 拆出来（和 knowledge 那组一个路子）：这一层只改 config.cloud_providers，
 * 改完统一走注入进来的 applyCloudChange 物化成渠道并热重载。
 * config / cloudState / applyCloudChange 都关乎 index.js 里的运行时（llm、runtime、memory），
 * 所以由 index.js 注入，这里不自己 require，免得把热重载逻辑复制第二遍。
 */
const express = require("express");

const fail200 = (res, e) => res.json({ ok: false, error: String((e && e.message) || e).slice(0, 200) });

/**
 * @param {object} deps
 * @param {object} deps.config           引擎配置（就地改）
 * @param {object} deps.cloudProviders   engine/cloud-providers.js
 * @param {object} deps.modelCfg         engine/model-config.js
 * @param {() => void} deps.applyCloudChange  物化渠道 + 热重载
 * @param {() => object} deps.cloudState      当前云服务状态（含被跳过的服务商）
 */
function createCloudRouter({ config, cloudProviders, modelCfg, applyCloudChange, cloudState }) {
  const router = express.Router();

  // 拉取某个渠道在服务商侧真实可用的模型列表（OpenAI 兼容 GET /models，Anthropic 亦然）。
  // 让用户从列表里挑，而不是对着文档手打模型 id 再被 404 打回来。
  router.post("/api/models/list", async (req, res) => {
    try {
      const b = req.body || {};
      const entry = modelCfg.findChannel(config, b.name);
      if (!entry) return res.status(400).json({ ok: false, error: "没有这个渠道：" + b.name });
      const anthropic = entry.provider === "anthropic";
      const key = String(b.api_key || "").trim() || entry.api_key || "";
      const base = String(entry.base_url || (anthropic ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1")).replace(/\/+$/, "");
      const headers = anthropic
        ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
        : { Authorization: `Bearer ${key || "ollama"}` };
      const r = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(20000) });
      if (!r.ok) {
        const txt = (await r.text()).slice(0, 200);
        const hint =
          r.status === 401 || r.status === 403 ? "Key 没通过校验" :
          r.status === 404 ? "这家服务商没有 /models 接口，只能手填模型 id" :
          `上游返回 HTTP ${r.status}`;
        return res.json({ ok: false, error: `${hint}：${txt}` });
      }
      const d = await r.json();
      const raw = Array.isArray(d?.data) ? d.data : Array.isArray(d?.models) ? d.models : [];
      const ids = [...new Set(raw.map((x) => String(x?.id || x?.name || "").trim()).filter(Boolean))].sort();
      res.json({ ok: true, models: ids });
    } catch (e) {
      fail200(res, e);
    }
  });

  router.get("/api/cloud/providers", (_req, res) => {
    try {
      res.json(cloudState());
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // 新建服务商：给 preset_id 就按内置预设建，否则按 name/base_url 建自定义
  router.post("/api/cloud/providers", (req, res) => {
    try {
      const b = req.body || {};
      if (!b.preset_id && !String(b.name || "").trim()) throw new Error("请填服务商名称");
      cloudProviders.upsertProvider(config, b);
      applyCloudChange();
      res.json(cloudState());
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post("/api/cloud/providers/:id", (req, res) => {
    try {
      const id = String(req.params.id || "");
      // 内置预设可能还没落盘（只是列表里的占位），这里允许直接开始配置它
      if (!cloudProviders.findProvider(config, id) && !cloudProviders.getPreset(id)) throw new Error("没有这个服务商");
      cloudProviders.upsertProvider(config, { ...(req.body || {}), id });
      applyCloudChange();
      res.json(cloudState());
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete("/api/cloud/providers/:id", (req, res) => {
    try {
      cloudProviders.deleteProvider(config, req.params.id);
      applyCloudChange();
      res.json(cloudState());
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // 检查连接：拉一次 /models，认不认都给一句人话。可带 id 从已存服务商取地址与 Key
  router.post("/api/cloud/check", async (req, res) => {
    try {
      const b = req.body || {};
      const p = b.id ? cloudProviders.findProvider(config, b.id) : null;
      const baseUrl = String(b.base_url || (p && p.base_url) || "").trim();
      if (!baseUrl) throw new Error("先填 API 地址");
      const r = await cloudProviders.checkConnection({
        baseUrl,
        apiKey: String(b.api_key || "").trim() || (p && p.api_key) || "",
        provider: b.provider || (p && p.provider) || "openai",
      });
      res.json(r.ok ? { ok: true, count: r.count } : { ok: false, error: r.error });
    } catch (e) {
      fail200(res, e);
    }
  });

  // 拉取远端模型清单（可对还没保存的新输入直接测）
  router.post("/api/cloud/models", async (req, res) => {
    try {
      const b = req.body || {};
      const p = b.id ? cloudProviders.findProvider(config, b.id) : null;
      const baseUrl = String(b.base_url || (p && p.base_url) || "").trim();
      if (!baseUrl) throw new Error("先填 API 地址");
      const r = await cloudProviders.fetchRemoteModels({
        baseUrl,
        apiKey: String(b.api_key || "").trim() || (p && p.api_key) || "",
        provider: b.provider || (p && p.provider) || "openai",
      });
      res.json(r);
    } catch (e) {
      fail200(res, e);
    }
  });

  return router;
}

module.exports = { createCloudRouter };
