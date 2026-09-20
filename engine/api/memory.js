"use strict";
/**
 * 长期记忆接口：手写区 + 条目区 + 记忆搬家（导出 / 从其它 agent 导入）。
 *
 * 从 index.js 拆出。memory / security 都是无状态的模块单例，直接 require 就是同一份
 * （Node 模块缓存），不必像 cloud 那样注入。
 */
const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const memory = require("../memory");
const security = require("../security");

/** 本机其它 agent 的记忆文件白名单扫描（找得到才列出来，路径不存在就静默跳过） */
function memoryImportSources() {
  const home = os.homedir();
  const out = [];
  const push = (label, p, mode) => {
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.size > 0 && st.size < 2 * 1024 * 1024) out.push({ label, path: p, size: st.size, mode });
    } catch {}
  };
  push("其它 Agent 全局记忆（~/.claude/CLAUDE.md）", path.join(home, ".claude", "CLAUDE.md"), "manual");
  try {
    for (const d of fs.readdirSync(path.join(home, ".claude", "projects"))) {
      push(`其它 Agent 项目记忆（${d.replace(/^-/, "").slice(0, 48)}）`, path.join(home, ".claude", "projects", d, "memory", "MEMORY.md"), "items");
    }
  } catch {}
  push("Codex 全局记忆（~/.codex/AGENTS.md）", path.join(home, ".codex", "AGENTS.md"), "manual");
  push("其它 Agent 全局记忆（~/.cowork/CLAUDE.md）", path.join(home, ".cowork", "CLAUDE.md"), "manual");
  push("其它 Agent 全局记忆（应用目录）", path.join(home, "Library", "Application Support", "Claude Cowork", "CLAUDE.md"), "manual");
  if (process.env.APPDATA) push("其它 Agent 全局记忆（应用目录）", path.join(process.env.APPDATA, "Claude Cowork", "CLAUDE.md"), "manual");
  return out;
}

function createMemoryRouter() {
  const router = express.Router();
  const userOf = (req) => (req.user ? req.user.username : undefined);

  // ---------- 长期记忆 ----------
  // 手写区（memory.md，全局共享）+ 条目区（agent 用 remember 自己记的，按账号隔离）
  router.get("/api/memory", (req, res) => {
    res.json({ content: memory.manual(), items: memory.list(userOf(req)), shared_tag: memory.SHARED, limits: { max_text: memory.MAX_TEXT, max_items: memory.MAX_PER_SCOPE } });
  });
  router.post("/api/memory", (req, res) => {
    memory.saveManual((req.body || {}).content || "");
    res.json({ ok: true });
  });
  router.post("/api/memory/item", (req, res) => {
    const b = req.body || {};
    const r = memory.add({ text: b.text, user: userOf(req), shared: !!b.shared, source: "user" });
    res.status(r.ok ? 200 : 400).json(r);
  });
  router.delete("/api/memory/item/:id", (req, res) => {
    res.json({ ok: true, removed: memory.remove(req.params.id) });
  });

  // ---------- 记忆搬家：导出 / 从其它 agent 导入 ----------
  // 导出成一份人能读的 Markdown（手写区 + 条目区），到哪都能用。
  // 导入支持两路：① 扫描本机已知的其它 agent 记忆文件，
  // 只读扫描白名单里的路径，绝不接受任意路径；② 粘贴任意文本（有些 Agent 产品没有固定
  // 路径的，从它界面里复制出来贴进来就行）。解析是确定性的，不烧 token。
  router.get("/api/memory/export", (req, res) => {
    const items = memory.list(userOf(req));
    const lines = [
      "# KylinWork 记忆导出",
      "",
      `导出时间：${new Date().toLocaleString("zh-CN")}${req.user ? ` · 账号：${req.user.username}` : ""}`,
      "",
      "## 背景说明（手写区，全局共享）",
      "",
      memory.manual() || "（空）",
      "",
      "## 记忆条目",
      "",
      ...(items.length
        ? items.map((it) => `- [${it.scope === memory.SHARED ? "共享" : it.scope}] ${it.text}`)
        : ["（还没有条目）"]),
      "",
    ];
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="kylinwork-memory-${new Date().toISOString().slice(0, 10)}.md"`);
    res.send(lines.join("\n"));
  });

  router.get("/api/memory/import/scan", (_req, res) => res.json({ sources: memoryImportSources() }));

  router.post("/api/memory/import", (req, res) => {
    const b = req.body || {};
    let content = "", label = "粘贴的内容";
    if (b.path) {
      const hit = memoryImportSources().find((s) => s.path === String(b.path));
      if (!hit) return res.status(400).json({ error: "只能导入扫描列表里的文件（防任意路径读取）" });
      try { content = fs.readFileSync(hit.path, "utf8"); } catch (e) { return res.status(500).json({ error: "读取失败：" + e.message }); }
      label = hit.label;
    } else {
      content = String(b.text || "");
    }
    content = content.trim();
    if (!content) return res.status(400).json({ error: "没有可导入的内容" });
    const mode = b.mode === "manual" ? "manual" : "items";
    if (mode === "manual") {
      // 成段的背景/规范：整段并入手写区，加来源标头，去重靠人眼（手写区本来就是人编辑的）
      const cur = memory.manual();
      if (cur.includes(content.slice(0, 200))) return res.json({ ok: true, added: 0, skipped: 1, note: "内容已在背景说明里，跳过" });
      memory.saveManual((cur ? cur + "\n\n" : "") + `## 导入自 ${label}（${new Date().toISOString().slice(0, 10)}）\n\n` + content);
      return res.json({ ok: true, added: 1, mode });
    }
    // 条目模式：逐行解析 markdown 列表（- / * / 数字.），[标题](链接) 压成 标题，跳过标题行和短行
    const user = userOf(req);
    let added = 0, skipped = 0;
    const lines = content.split(/\r?\n/).slice(0, 500);
    for (const raw of lines) {
      let t = raw.trim();
      if (!t || /^#{1,6}\s/.test(t) || /^[-*_]{3,}$/.test(t)) continue; // 标题、分隔线
      t = t.replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "");
      t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"); // markdown 链接压成文字
      t = t.replace(/\*\*/g, "").trim();
      if (t.length < 4) continue;
      const r = memory.add({ text: t, user, shared: !!b.shared, source: "user" });
      if (r.ok) added++; else skipped++;
    }
    security.audit("记忆导入", `${label}：导入 ${added} 条，跳过 ${skipped} 条`, "放行");
    res.json({ ok: true, added, skipped, mode });
  });

  return router;
}

module.exports = { createMemoryRouter, memoryImportSources };
