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

  // 改库：名称 / 描述 / 每库配置（embedding、rerank、切块与召回参数）。
  // embeddings_reset=true 表示换了向量模型、旧向量已清空，界面要提示「重建索引」。
  router.post("/api/knowledge/bases/:id", (req, res) => {
    try {
      const r = knowledge.updateBase(req.params.id, req.body || {});
      res.json({ ok: true, base: r.base, embeddings_reset: !!r.embeddings_reset });
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

  // 库里的文档（文件 / 笔记 / 网页）。/files 是历史路径，和 /docs 等价
  const listDocsHandler = (req, res) => {
    try {
      if (!knowledge.getBase(req.params.id)) return res.status(404).json({ error: "知识库不存在" });
      const docs = knowledge.listDocs(req.params.id);
      res.json({ files: docs, docs, total: docs.length });
    } catch (e) {
      fail(res)(e);
    }
  };
  router.get("/api/knowledge/bases/:id/files", listDocsHandler);
  router.get("/api/knowledge/bases/:id/docs", listDocsHandler);

  // 一个文档的分块明细（界面上「查看分块」）
  router.get("/api/knowledge/bases/:id/chunks", (req, res) => {
    try {
      const docId = String(req.query.doc || "").trim();
      if (!docId) return res.status(400).json({ error: "缺少 doc 参数" });
      res.json({ chunks: knowledge.listChunks(req.params.id, docId) });
    } catch (e) {
      fail(res)(e);
    }
  });

  // 加一条笔记（正文内联，不落磁盘文件）
  router.post("/api/knowledge/bases/:id/note", (req, res) => {
    try {
      res.json({ ok: true, doc: knowledge.addNote(req.params.id, req.body || {}) });
    } catch (e) {
      fail(res)(e);
    }
  });

  // 加一个网页：服务端抓正文后入库
  router.post("/api/knowledge/bases/:id/web", async (req, res) => {
    try {
      res.json({ ok: true, doc: await knowledge.addWeb(req.params.id, req.body || {}) });
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
      const job = knowledge.enqueueIndex(id, saved.id);
      res.json({ ok: true, file: saved.name, id: saved.id, size: saved.size, queued: true, status: job.state });
    } catch (e) {
      fail(res)(e);
    }
  });

  // 删文档：/docs/:docId 是通用路径（文件 / 笔记 / 网页都走它）；/files/:name 保留兼容
  router.delete("/api/knowledge/bases/:id/docs/:docId", (req, res) => {
    try {
      res.json(knowledge.deleteDoc(req.params.id, decodeURIComponent(req.params.docId)));
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

  // 重新入库：给 doc 就重排那一个，不给就重排整库（换了向量模型 / 改了切块参数后重跑）
  router.post("/api/knowledge/bases/:id/reindex", async (req, res) => {
    try {
      const { id } = req.params;
      if (!knowledge.getBase(id)) return res.status(404).json({ error: "知识库不存在" });
      const doc = String((req.body || {}).doc || (req.body || {}).name || "").trim();
      const r = doc ? knowledge.enqueueIndex(id, doc) : knowledge.enqueueReindex(id);
      res.json({ ok: true, queued: doc ? 1 : r.queued, status: knowledge.queueStats() });
    } catch (e) {
      fail(res)(e);
    }
  });

  // 补齐向量：只对「有分块但没向量」的文档重排（换了向量模型把向量清空后，不必重切块）
  router.post("/api/knowledge/bases/:id/embed-missing", (req, res) => {
    try {
      const r = knowledge.enqueueEmbedMissing(req.params.id);
      res.json({ ok: true, queued: r.queued, status: knowledge.queueStats() });
    } catch (e) {
      fail(res)(e);
    }
  });

  // 失败任务重试（队列里失败三次就停了，界面上给个「重试」）
  router.post("/api/knowledge/bases/:id/retry", (req, res) => {
    try {
      const { id } = req.params;
      const doc = String((req.body || {}).doc || (req.body || {}).name || "").trim();
      if (!doc) return res.status(400).json({ error: "缺少文档" });
      res.json({ ok: true, job: knowledge.retryJob(id, doc), status: knowledge.queueStats() });
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
          kb_id: h.kb_id,
          kb: h.kb,
          doc_id: h.doc_id,
          kind: h.kind || "file",
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
