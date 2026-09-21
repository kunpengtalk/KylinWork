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
    // 不 await 整跑：日报那种任务要跑几分钟，前端 HTTP 超时只有 60 秒，一路挂着等它就必然
    // 报「超时」——任务其实在跑，用户却看到一条失败提示。这里只等到这次运行开了会话
    // （有了 session_id）就回话，之后的过程由左侧任务列表（转圈）和通知中心负责汇报。
    // 先记下已有的运行记录 id：串行队列里可能还排着别的任务，等下只认「新多出来的这条」。
    // 用 id 而不是时间戳比较——两台机器的时钟差、时区格式都能让它算错，而 id 是唯一的。
    const before = new Set(s.runs(50).map((r) => r.id));
    const running = s.runOne(item.id, "手动");
    running.catch(() => {}); // 收场另有回报，这里只是别让 rejection 变成 unhandledRejection
    const thisRun = () => s.runs(50).find((r) => r.task_id === item.id && !before.has(r.id));
    let run = null;
    for (let i = 0; i < 60; i++) {
      run = thisRun();
      // 运行记录是「先登记、后开会话」的：等 session_id 落上（或这次已经收场）再回话
      if (run && (run.session_id || run.ended_at)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    // 本次运行已经收场（多数是启动就失败：模型不可用、工作空间没了）——如实报出来，
    // 别让用户对着一个「已开始执行」的提示等一个永远不会完成的会话
    if (run && run.ok === false && run.ended_at) {
      return res.status(500).json({ error: run.result || "执行失败", session_id: run.session_id || "" });
    }
    res.json({ ok: true, session_id: (run && run.session_id) || "" });
  });

  return router;
}

module.exports = { createSchedulesRouter };
