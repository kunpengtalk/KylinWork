"use strict";
/**
 * 定时任务管理接口。
 *
 * 从 index.js 拆出。scheduler 实例是 main() 里才建好、晚绑定的，所以这里注入一个
 * getScheduler()，而不是在模块顶层 require —— 否则会拿到 undefined。
 */
const express = require("express");

/**
 * @param {object} deps
 * @param {() => object} deps.getScheduler  取当前 scheduler 实例（main() 之后才有值）
 */
function createSchedulesRouter({ getScheduler }) {
  const router = express.Router();

  router.get("/api/schedules", (_req, res) => res.json(getScheduler().list()));
  // 运行记录。只看 last_result 的话，昨天跑挂今天跑好就查无此事
  router.get("/api/schedules/runs", (req, res) => res.json(getScheduler().runs(Math.min(+req.query.limit || 100, 300))));

  router.post("/api/schedules", (req, res) => {
    try {
      res.json(getScheduler().add(req.body || {}));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.patch("/api/schedules/:id", (req, res) => {
    try {
      const t = getScheduler().update(req.params.id, req.body || {});
      if (!t) return res.status(404).json({ error: "任务不存在" });
      res.json(t);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete("/api/schedules/:id", (req, res) => res.json({ ok: getScheduler().remove(req.params.id) }));

  // 批量：一条条点太慢，但批量删是不可逆的，所以要求前端明确传 action
  router.post("/api/schedules/bulk", (req, res) => {
    const { ids, action } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "没选中任何任务" });
    if (!["enable", "disable", "delete"].includes(action)) return res.status(400).json({ error: "未知操作" });
    const s = getScheduler();
    let n = 0;
    for (const id of ids) {
      if (action === "delete") n += s.remove(id) ? 1 : 0;
      else n += s.toggle(id, action === "enable") ? 1 : 0;
    }
    res.json({ ok: true, count: n });
  });

  router.post("/api/schedules/:id/toggle", (req, res) =>
    res.json({ ok: getScheduler().toggle(req.params.id, !!(req.body || {}).enabled) })
  );

  router.post("/api/schedules/:id/catchup", (req, res) =>
    res.json({ ok: getScheduler().setCatchUp(req.params.id, !!(req.body || {}).catch_up) })
  );

  router.post("/api/schedules/:id/run", async (req, res) => {
    const s = getScheduler();
    const item = s.list().find((t) => t.id === req.params.id);
    if (!item) return res.status(404).json({ error: "任务不存在" });
    if (item.running) return res.status(409).json({ error: "这个任务正在跑，等它跑完再点" });
    try {
      // 传 id 不传对象：list() 给出去的是副本，拿副本去跑的话执行结果写在副本上，存不下来
      const reply = await s.runOne(item.id, "手动");
      res.json({ ok: true, reply });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createSchedulesRouter };
