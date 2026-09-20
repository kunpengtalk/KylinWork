"use strict";
/**
 * 知识库 HTTP 接口（多库 RAG：建库 / 上传 / 建索引 / 检索）。
 *
 * 从 index.js 里整段搬出来：这一组路由只依赖 knowledge 模块本身，跟主文件里的
 * runtime / llm / 会话状态都不打交道。上传解析用的 rawUpload / uploadName 由调用方注入，
 * 免得再复制一份「文件名放 header」的约定。
 *
 * 与「资料库」是两码事：资料库是跨项目共享的参考文件夹（agent 用 library_* 读），
 * 知识库是按库组织、可被对话选中做检索问答的资料集。设置里配 embedding/rerank，这里管数据。
 */
const express = require("express");

/**
 * @param {object} deps
 * @param {object} deps.knowledge   engine/knowledge.js
 * @param {(limit:string)=>import('express').RequestHandler} deps.rawUpload
 * @param {(req:import('express').Request)=>string} deps.uploadName
 */
function createKnowledgeRouter({ knowledge, rawUpload, uploadName }) {
  const router = express.Router();
  // 统一把模块抛出来的业务错误翻成 400，省得每条路由各写一遍 try/catch
  const fail = (res) => (e) => res.status(400).json({ error: e.message });

  router.get("/api/knowledge/bases", (_req, res) => {
    try {
      const es = knowledge.embeddingSource();
      res.json({
        bases: knowledge.listBases(),
        // model 是「实际在用的那条」，source 说明它是设置里选的还是和长期记忆共用的那条——
        // 以前只回 model，界面上就出现了「设置里选 bge-large-zh、显示 bge-m3」这种事
        embedding: { configured: knowledge.embeddingConfigured(), model: es.model, source: es.source, channel: es.channel },
        rerank: { configured: knowledge.rerankConfigured() },
        selected: knowledge.selectedRefs(),
        queue: knowledge.queueStats(),
      });
    } catch (e) {
      fail(res)(e);
    }
  });

  // 入库队列状态（界面在轮询它）
  router.get("/api/knowledge/queue", (_req, res) => {
    try {
      res.json(knowledge.queueStats());
    } catch (e) {
      fail(res)(e);
    }
  });

  router.post("/api/knowledge/bases", (req, res) => {
    try {
      res.json({ ok: true, base: knowledge.createBase(req.body || {}) });
    } catch (e) {
      fail(res)(e);
    }
  });

  router.post("/api/knowledge/bases/:id", (req, res) => {
    try {
      res.json({ ok: true, base: knowledge.updateBase(req.params.id, req.body || {}) });
    } catch (e) {
      fail(res)(e);
    }
  });

  router.delete("/api/knowledge/bases/:id", (req, res) => {
    try {
      res.json(knowledge.deleteBase(req.params.id));
    } catch (e) {
      fail(res)(e);
    }
  });

  router.get("/api/knowledge/bases/:id/files", (req, res) => {
    try {
      if (!knowledge.getBase(req.params.id)) return res.status(404).json({ error: "知识库不存在" });
      res.json({ files: knowledge.listFiles(req.params.id) });
    } catch (e) {
      fail(res)(e);
    }
  });

  // 上传资料：落盘后把入库（抽正文 → 分块 → 向量化）排进后台队列，立刻返回。
  // 一份大 pdf / xlsx 走完这套要几十秒，同步做完会把上传请求吊着（前端看着像卡死），
  // 中途断开还得整个重来；排队之后前端轮询文件状态即可。
  // 传输上限（MAX_UPLOAD_BYTES）比入库上限（MAX_FILE_BYTES）大：超过入库上限的文件存得下、
  // 但不建索引，免得一次 embedding 把额度烧穿。两个上限都在 knowledge.js 里定义，这里不再写死。
  router.post("/api/knowledge/bases/:id/upload", rawUpload(knowledge.MAX_UPLOAD_BYTES), async (req, res) => {
    try {
      const { id } = req.params;
      const base = knowledge.getBase(id);
      if (!base) return res.status(404).json({ error: "知识库不存在" });
      let name;
      let buf;
      if (Buffer.isBuffer(req.body)) {
        name = uploadName(req);
        buf = req.body;
      } else {
        const { name: n, data_b64 } = req.body || {};
        name = n;
        buf = data_b64 ? Buffer.from(data_b64, "base64") : null;
      }
      if (!name) return res.status(400).json({ error: "缺少文件名" });
      const saved = await knowledge.saveFile(id, name, buf);
      const job = knowledge.enqueueIndex(id, saved.name);
      res.json({ ok: true, file: saved.name, size: saved.size, queued: true, status: job.state });
    } catch (e) {
      fail(res)(e);
    }
  });

  router.delete("/api/knowledge/bases/:id/files/:name", (req, res) => {
    try {
      res.json(knowledge.deleteFile(req.params.id, req.params.name));
    } catch (e) {
      fail(res)(e);
    }
  });

  // 重新入库：给文件就重排那一个，不给就重排整库（换了向量模型后重跑）
  router.post("/api/knowledge/bases/:id/reindex", async (req, res) => {
    try {
      const { id } = req.params;
      if (!knowledge.getBase(id)) return res.status(404).json({ error: "知识库不存在" });
      const name = String((req.body || {}).name || "").trim();
      const r = name ? knowledge.enqueueIndex(id, name) : knowledge.enqueueReindex(id);
      res.json({ ok: true, queued: name ? 1 : r.queued, status: knowledge.queueStats() });
    } catch (e) {
      fail(res)(e);
    }
  });

  // 失败任务重试（队列里失败三次就停了，界面上给个「重试」）
  router.post("/api/knowledge/bases/:id/retry", (req, res) => {
    try {
      const { id } = req.params;
      const name = String((req.body || {}).name || "").trim();
      if (!name) return res.status(400).json({ error: "缺少文件名" });
      res.json({ ok: true, job: knowledge.retryJob(id, name), status: knowledge.queueStats() });
    } catch (e) {
      fail(res)(e);
    }
  });

  // 检索预览：设置页/管理页用它验证「这样问能不能召回到」。
  // 一并回检索模式、用的向量模型和降级说明，省得用户猜「为什么这次没走向量」
  router.post("/api/knowledge/search", async (req, res) => {
    try {
      const { query, ids, top_k } = req.body || {};
      const d = await knowledge.searchDetailed(String(query || ""), Array.isArray(ids) ? ids : []);
      const k = Math.max(1, Math.min(50, Number(top_k) || d.hits.length || 6));
      res.json({
        hits: d.hits.slice(0, k).map((h) => ({
          kb: h.kb,
          file: h.file,
          heading: h.heading || "",
          seq: h.seq,
          seq_end: h.seq_end,
          merged: h.merged || 1,
          matched: h.matched || "",
          reranked: !!h.reranked,
          score: Number(Number(h.score).toFixed(4)),
          text: h.text,
        })),
        mode: d.mode,
        model: d.model,
        notes: d.notes,
      });
    } catch (e) {
      fail(res)(e);
    }
  });

  // 配置自检：表单里填的 embedding / rerank 直接试一发，不保存也能验证
  router.post("/api/knowledge/test", async (req, res) => {
    const { kind } = req.body || {};
    try {
      if (kind === "rerank") res.json(await knowledge.testRerank((req.body || {}).rerank));
      else res.json(await knowledge.testEmbedding((req.body || {}).embedding));
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  return router;
}

module.exports = { createKnowledgeRouter };
