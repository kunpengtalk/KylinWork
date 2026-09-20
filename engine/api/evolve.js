"use strict";
/**
 * 自进化接口：反馈 → 信号 → 提案 → 人审 → 复盘。
 *
 * 从 index.js 拆出。runReview 要现取当前的 llm（配置热更新后会换实例），所以注入 index.js
 * 那个可热替换的 llm 包装（getter 直通当前实例）；config 需要读自进化开关，就地读不缓存。
 */
const express = require("express");

/**
 * @param {object} deps
 * @param {object} deps.evolve   engine/evolve.js
 * @param {object} deps.config   引擎配置（读 config.evolve）
 * @param {object} deps.llm      可热替换的 LLM 包装（index.js 的 llm）
 */
function createEvolveRouter({ evolve, config, llm }) {
  const router = express.Router();
  const userOf = (req) => (req.user ? req.user.username : "");

  // 👍👎 以前点了只换个高亮色，一个字节都没往外送。反馈得在干活的地方零摩擦地收，
  // 收不到就没有后面这一整条链——这是整套自进化的第一环。
  router.post("/api/feedback", (req, res) => {
    try {
      const b = req.body || {};
      res.json({ ok: true, item: evolve.recordFeedback({ ...b, user: userOf(req) }) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // 体检：这段时间它都败在哪儿、各多少次。不调模型，纯数数，随时能看
  router.get("/api/evolve/signals", (req, res) => {
    try {
      res.json(evolve.mineSignals({ days: Math.min(365, +req.query.days || evolve.CAPS.window) }));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/api/evolve/state", (_req, res) => {
    res.json({
      caps: evolve.CAPS,
      rules: evolve.activeRules(),
      proposals: evolve.listProposals().slice(-50).reverse(),
      scored: evolve.scoreRules(),
      runs: evolve.listRuns(5),
      auto: config.evolve || {},
    });
  });

  // 跑一轮复盘：数信号 → 让模型提最小改动 → 过闸门 → 落盘等人审。**永远不自动生效**
  router.post("/api/evolve/review", async (req, res) => {
    try {
      const r = await evolve.runReview({ llm, days: +((req.body || {}).days) || undefined, promptExcerpt: (req.body || {}).prompt_excerpt || "" });
      res.json({ ok: true, turns: r.mined.turns, signals: r.mined.signals.slice(0, 10), added: r.added, gated: r.gated, notes: r.notes, scored: r.scored });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/api/evolve/proposal/:id", (req, res) => {
    try {
      const b = req.body || {};
      const p = evolve.decideProposal(req.params.id, b.decision, { by: userOf(req), reason: b.reason });
      res.json({ ok: true, proposal: p, rules: evolve.activeRules() });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post("/api/evolve/rule/:id/retire", (req, res) => {
    try {
      res.json({ ok: true, ...evolve.retireRule(req.params.id, (req.body || {}).why || "人工下架"), rules: evolve.activeRules() });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createEvolveRouter };
