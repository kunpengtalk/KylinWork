"use strict";
/**
 * 知识库（多库 RAG）。
 *
 * 一个知识库 = 一批资料文件 + 一份索引（分块文本，可能带向量）。用户在对话里
 * 勾选要用哪个库，引擎拿当前这句话去库里检索，把最相关的几段拼进任务上下文——
 * 模型据此问答，而不是靠自己记忆答。
 *
 * 检索分三层，逐层降级，任何一层没配都能用：
 *   1. 向量召回 + 关键词召回：两路各自排名，再用 RRF 融合。以前是「有向量就不看关键词」，
 *      结果模型号、专有名词、SKU 这类字面命中被余弦分挤掉；融合后字面和语义各出各的力。
 *   2. 没有可用嵌入渠道时只剩关键词一路（本地零依赖兜底），融合逻辑照走，不会报错。
 *   3. 重排：配了 rerank 渠道（kind=rerank）就对候选段重排，精度更高。
 * embedding / rerank 都只是对渠道模型的引用（复合键「渠道::模型」），不重复存 key。
 * 向量模型以「设置 → 知识库」选的那条为准；那条是索引和查询共用的同一个模型，
 * 索引里记了向量是哪条模型算的，换了模型旧向量自动视为失效（退回关键词并提示重建）。
 *
 * 存储：data/knowledge/ 下每个库一个目录，bases.json 记库列表，index.json 记索引。
 * 索引落盘是刻意的——重启后不用重新 embedding（那是花钱的事）。
 *
 * 与 memory 一样，embedder 由 server 注入（llm.createEmbedder）：配置热更新后要重注入。
 */
const fs = require("fs");
const path = require("path");
const { dataPath } = require("./paths");
const store = require("./store");
const modelCfg = require("./model-config"); // 渠道/模型的统一口径：embedding/rerank 都按复合键解析

const ROOT = dataPath("data", "knowledge");
const BASES_FILE = path.join(ROOT, "bases.json");

/** 能抽正文的纯文本后缀（其余格式只存不建索引，界面上会说明） */
const TEXT_EXT = new Set([
  ".txt", ".md", ".markdown", ".mdx", ".csv", ".tsv", ".json", ".jsonl", ".ndjson",
  ".html", ".htm", ".xml", ".yaml", ".yml", ".log", ".ini", ".conf", ".toml", ".rtf",
  ".py", ".js", ".ts", ".jsx", ".tsx", ".vue", ".java", ".go", ".rs", ".c", ".h",
  ".cpp", ".hpp", ".cs", ".rb", ".php", ".sh", ".sql", ".css", ".scss",
]);

/** 单文件入库上限：超过这个大小只存不索引（不 embed，免得一次把额度烧穿） */
const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** 上传传输上限：比入库上限大，留出「存得下但索引不了」的余量。原始字节流，不 base64 膨胀 */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const MAX_CHUNKS_PER_FILE = 600; // 超大文件切块上限，避免一次 embedding 把额度烧穿
const VEC_ROUND = 6; // 向量保留 6 位小数：检索精度够，索引体积小一大截

/** 尽力而为的清理：失败不影响主流程，但必须留一条日志——静默吞错时「文件凭空丢了」无从查起 */
function tryIgnore(what, fn) {
  try {
    fn();
  } catch (e) {
    console.warn(`[知识库] ${what} 失败：`, e.message);
  }
}

// ==================== 注入的运行时依赖 ====================

let CONFIG = {};
let embedder = null; // llm.createEmbedder 的产物：(texts)=>Promise<number[][]|null>，失败返回 null 不抛

/** 让检索/建索引读到最新的 config（embedding / rerank / knowledge 都在里面） */
function setConfig(config) {
  if (config && typeof config === "object") CONFIG = config;
}
/** 注入嵌入函数（配置变更后由 server 重新注入，换了模型旧向量会在重建时作废） */
function setEmbedder(fn) {
  embedder = typeof fn === "function" ? fn : null;
}
function tuning() {
  const k = CONFIG.knowledge || {};
  return {
    chunk_size: Number(k.chunk_size) || 800,
    chunk_overlap: Number(k.chunk_overlap) || 120,
    top_k: Number(k.top_k) || 6,
    score_threshold: Number(k.score_threshold) || 0,
    inject_chars: Number(k.inject_chars) || 6000,
  };
}
function rerankCfg() {
  return resolveChannelModel((CONFIG.knowledge || {}).rerank) || {};
}
/**
 * 知识库自己选的那条向量渠道（设置 → 知识库 的下拉框）。
 * <p>
 * 以前这里直接用的注入 embedder（llm.createEmbedder），而它按「标了向量的渠道的第一个模型」
 * 挑，压根不读 config.knowledge——于是设置页选 BAAI/bge-large-zh-v1.5、实际检索用的是
 * BAAI/bge-m3，测试按钮还测的是选中的那个，界面上说的和跑的不是一回事。这里改成就按选的来。
 */
function embedCfg() {
  return resolveChannelModel((CONFIG.knowledge || {}).embedding) || null;
}
/** 实际在用的向量模型 + 它的来路（接口如实展示给前端，别再出现「显示的和用的不是一个」） */
function embeddingSource() {
  const sel = embedCfg();
  if (sel) return { model: sel.model, source: "selected", channel: sel.channel };
  return { model: (embedder && embedder.model) || null, source: embedder ? "shared" : "none", channel: "" };
}
function embeddingConfigured() {
  return !!(embedCfg() || embedder);
}
function embeddingModel() {
  return embeddingSource().model;
}
function rerankConfigured() {
  return !!rerankCfg().base_url;
}
/** 当前选中的 embedding / rerank 复合键（设置页回显用） */
function selectedRefs() {
  const k = CONFIG.knowledge || {};
  return { embedding: String(k.embedding || ""), rerank: String(k.rerank || "") };
}

/**
 * 把「渠道::模型」复合键解析成一个可调用的端点配置。
 * 渠道在「设置 → 模型」里，key/base_url 都在那儿；这里只做解析，不再要求用户重复填。
 */
function resolveChannelModel(ref) {
  const key = String(ref || "").trim();
  if (!key) return null;
  const { name, modelId } = modelCfg.parseSelectionKey(key);
  const ch = modelCfg.findChannel(CONFIG, name);
  if (!ch) return null;
  const model = modelCfg.pickModelId(ch, modelId);
  if (!ch.base_url || !model) return null;
  return { base_url: ch.base_url, api_key: ch.api_key || "", model, channel: ch.name };
}

// ==================== 每个库各配一套（缺省回落全局「设置 → 知识库」） ====================
//
// 以前 embedding / rerank / 切块参数是全局一份，所有库共用。现在改成库上存一份，
// 没有的字段才回落到全局——所以老库（bases.json 里没这些字段）行为完全不变。

/** 库上可覆盖的数值/布尔参数；给了就用库上的，没给用全局的，再兜一层默认值 */
const BASE_TUNING_FIELDS = {
  chunk_size: { def: 800, min: 200, max: 4000, round: true },
  chunk_overlap: { def: 120, min: 0, max: 2000, round: true },
  top_k: { def: 6, min: 1, max: 50, round: true },
  score_threshold: { def: 0, min: 0, max: 1, round: false },
  inject_chars: { def: 6000, min: 1000, max: 40000, round: true },
};

/** 把一个参数值夹到合法区间；空值返回 undefined（表示「没配，走回落」） */
function clampField(name, v) {
  const spec = BASE_TUNING_FIELDS[name];
  if (!spec) return undefined;
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  const clamped = Math.max(spec.min, Math.min(spec.max, n));
  return spec.round ? Math.round(clamped) : clamped;
}

/** 抽出一份「库里显式配置了」的参数（未配置的字段不出现，回落到全局） */
function baseOverrides(b) {
  const out = {};
  if (!b) return out;
  for (const k of Object.keys(BASE_TUNING_FIELDS)) {
    const v = clampField(k, b[k]);
    if (v !== undefined) out[k] = v;
  }
  if (b.expand_neighbors !== undefined) out.expand_neighbors = !!b.expand_neighbors;
  return out;
}

/** 这个库实际生效的切块 / 召回参数：库配置 > 全局设置 > 默认值 */
function tuningFor(b) {
  const g = tuning();
  const o = baseOverrides(b);
  const pick = (k) => (o[k] !== undefined ? o[k] : g[k]);
  return {
    chunk_size: pick("chunk_size"),
    chunk_overlap: pick("chunk_overlap"),
    top_k: pick("top_k"),
    score_threshold: pick("score_threshold"),
    inject_chars: pick("inject_chars"),
    expand_neighbors: o.expand_neighbors !== undefined ? o.expand_neighbors : true,
  };
}

/** 这个库用的向量渠道：库上选的 > 全局选的 > 注入的共用 embedder */
function embedCfgFor(b) {
  return resolveChannelModel((b && b.embedding) || "") || embedCfg();
}
/** 这个库用的重排渠道：库上选的 > 全局选的 */
function rerankCfgFor(b) {
  return resolveChannelModel((b && b.rerank) || "") || rerankCfg();
}
/** 这个库「按当前配置」实际在用的向量模型名（判向量失效、界面展示都用它） */
function embeddingModelFor(b) {
  const sel = resolveChannelModel((b && b.embedding) || "");
  if (sel) return sel.model;
  if (b && b.embedding) return ""; // 库里选了但渠道解析不出来 → 视为没有可用向量
  return embeddingModel();
}

// ==================== 目录与库表 ====================

function ensureRoot() {
  fs.mkdirSync(ROOT, { recursive: true });
}

function safeId(id) {
  const s = String(id || "").trim();
  if (!s || !/^[A-Za-z0-9_-]+$/.test(s)) throw new Error("知识库不存在或名称不合法");
  return s;
}

function baseDir(id) {
  return path.join(ROOT, safeId(id));
}
function filesDir(id) {
  return path.join(baseDir(id), "files");
}
/** index.json 的路径。名字必须与下面「建索引的 indexFile」区分开——同名会互相覆盖 */
function indexPath(id) {
  return path.join(baseDir(id), "index.json");
}
function readBases() {
  const d = store.readJson(BASES_FILE, { bases: [] });
  const list = d && Array.isArray(d.bases) ? d.bases : [];
  return list.filter((b) => b && b.id);
}
function writeBases(bases) {
  ensureRoot();
  store.writeJsonAtomic(BASES_FILE, { bases }, { pretty: true });
}

/**
 * 这条文件记录的向量还算不算数：向量是「这个库当前用的这条模型」算的才算。
 * 换了模型旧向量就不是同一个空间里的东西了——检索时会跳过它，界面据此提示重建索引。
 */
function vecStale(rec, curModel) {
  const recModel = String(rec.embed_model || rec.embedding || "");
  return !!(recModel && curModel && recModel !== curModel);
}

function listBases() {
  return readBases().map((b) => {
    let file_count = 0;
    let chunk_count = 0;
    let vectorized = 0;
    let embedded_chunks = 0;
    let stale_files = 0;
    const model = embeddingModelFor(b);
    try {
      const docs = Object.values(readIndex(b.id).docs || {});
      file_count = docs.length;
      for (const f of docs) {
        const chunks = f.chunks || [];
        chunk_count += chunks.length;
        const vecCount = chunks.filter((c) => c.vec && c.vec.length).length;
        embedded_chunks += vecCount;
        if (vecCount) {
          vectorized += 1;
          if (vecStale(f, model)) stale_files += 1;
        }
      }
    } catch (e) {
      console.warn(`[知识库] 统计 ${b.id} 的索引失败：`, e.message);
    }
    return {
      ...b,
      file_count,
      chunk_count,
      embedded_chunks,
      indexed_files: vectorized,
      stale_files,
      // 界面直接照着显示，不用再自己拼「渠道::模型」
      embedding_model: model,
      embedding_source: resolveChannelModel(b.embedding || "") ? "selected" : embeddingConfigured() ? "shared" : "none",
      rerank_configured: !!rerankCfgFor(b),
      tuning: tuningFor(b),
    };
  });
}

function getBase(id) {
  return readBases().find((b) => b.id === id) || null;
}

function createBase({ name, description, embedding, rerank, ...rest } = {}) {
  const n = String(name || "").replace(/\s+/g, " ").trim();
  if (!n) throw new Error("知识库名称不能为空");
  if (n.length > 40) throw new Error("知识库名称最多 40 个字");
  const bases = readBases();
  if (bases.some((b) => b.name === n)) throw new Error(`已存在同名知识库「${n}」`);
  const now = new Date().toISOString();
  const base = {
    id: "kb_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6),
    name: n,
    description: String(description || "").slice(0, 200),
    created_at: now,
    updated_at: now,
    // 每库配置：给空就回落全局；只有显式填了的才记进库
    embedding: String(embedding || "").trim(),
    rerank: String(rerank || "").trim(),
  };
  applyBaseConfig(base, rest);
  bases.unshift(base);
  writeBases(bases);
  ensureBaseDirs(base.id);
  return base;
}

/**
 * 把请求里的配置字段落到库记录上。数值字段按区间夹取、非法值忽略（保持原值），
 * 这样前端传 {} 或半截表单都不会把已配好的参数清成脏数据。
 */
function applyBaseConfig(base, patch = {}) {
  for (const k of Object.keys(BASE_TUNING_FIELDS)) {
    if (!(k in patch)) continue;
    if (patch[k] === null || patch[k] === "") { delete base[k]; continue; } // 显式清空 = 回落全局
    const v = clampField(k, patch[k]);
    if (v !== undefined) base[k] = v;
  }
  if ("expand_neighbors" in patch) {
    if (patch.expand_neighbors === null) delete base.expand_neighbors;
    else base.expand_neighbors = !!patch.expand_neighbors;
  }
  if ("embedding" in patch) base.embedding = String(patch.embedding || "").trim();
  if ("rerank" in patch) base.rerank = String(patch.rerank || "").trim();
  return base;
}

/** 换 embedding 模型的判定：只有真变了才算（避免每次保存设置都清空向量重算） */
function embeddingRefOf(b) {
  return String((b && b.embedding) || "").trim();
}

function updateBase(id, patch = {}) {
  const bases = readBases();
  const b = bases.find((x) => x.id === id);
  if (!b) throw new Error("知识库不存在");
  if (patch.name !== undefined) {
    const n = String(patch.name || "").replace(/\s+/g, " ").trim();
    if (!n) throw new Error("知识库名称不能为空");
    if (n.length > 40) throw new Error("知识库名称最多 40 个字");
    if (bases.some((x) => x.id !== id && x.name === n)) throw new Error(`已存在同名知识库「${n}」`);
    b.name = n;
  }
  if (patch.description !== undefined) b.description = String(patch.description || "").slice(0, 200);
  // 向量渠道变了 → 旧向量不再同源，清掉并标记（界面提示「已重置，需重建索引」）
  const beforeRef = embeddingRefOf(b);
  applyBaseConfig(b, patch);
  const embeddingsReset = "embedding" in patch && embeddingRefOf(b) !== beforeRef;
  if (embeddingsReset) clearVectors(id);
  b.updated_at = new Date().toISOString();
  writeBases(bases);
  return { base: b, embeddings_reset: embeddingsReset };
}

/** 清掉整库的向量（换 embedding 模型后调用）。文本分块保留，只需重建向量 */
function clearVectors(id) {
  const idx = readIndex(id);
  for (const d of Object.values(idx.docs || {})) {
    for (const c of d.chunks || []) delete c.vec;
    d.embed_model = "";
    d.embedding = "";
  }
  writeIndex(id, idx);
}

function deleteBase(id) {
  const bases = readBases();
  const b = bases.find((x) => x.id === id);
  if (!b) throw new Error("知识库不存在");
  writeBases(bases.filter((x) => x.id !== id));
  tryIgnore(`删除库目录 ${id}`, () => fs.rmSync(baseDir(id), { recursive: true, force: true }));
  return { ok: true };
}

// ==================== 文档与索引 ====================
//
// index.json 里一个库的全部文档都在 docs 下，键是文档 id：
//   文件类（kind=file）id 就是文件名（和磁盘 files/ 里的文件同名，也和 jobs.json 对得上），
//   笔记 / 网页（kind=note|web）没有磁盘文件，正文直接内联在 content 里。

/** 建库时把库目录和 files/ 都建出来 */
function ensureBaseDirs(id) {
  fs.mkdirSync(filesDir(id), { recursive: true });
}

/** 读索引，并把老结构（只有 files、没有 docs 的版本）就地升级 */
function readIndex(id) {
  const d = store.readJson(indexPath(id), { docs: {} });
  if (d && typeof d === "object" && !d.docs && d.files) {
    const docs = {};
    for (const [name, rec] of Object.entries(d.files || {})) {
      docs[name] = { id: name, name, kind: "file", ...rec };
    }
    return { docs };
  }
  return d && typeof d === "object" && d.docs ? d : { docs: {} };
}
function writeIndex(id, idx) {
  fs.mkdirSync(baseDir(id), { recursive: true });
  store.writeJsonAtomic(indexPath(id), idx, { pretty: false });
}

/** 取一个文档记录（找不到返回 null） */
function getDoc(id, docId) {
  const d = readIndex(id).docs || {};
  return d[docId] || null;
}
/** 补一个文档记录 */
function putDoc(id, doc) {
  const idx = readIndex(id);
  idx.docs[doc.id] = doc;
  writeIndex(id, idx);
  return doc;
}
/** 删一个文档记录 */
function dropDoc(id, docId) {
  const idx = readIndex(id);
  delete idx.docs[docId];
  writeIndex(id, idx);
}

function safeName(name) {
  const base = path.basename(String(name || ""));
  if (!base || base.startsWith(".")) throw new Error("文件名不合法");
  return base;
}

/**
 * 列出库里的全部文档（文件 / 笔记 / 网页）。
 * 状态取后台队列：queued / running / ready / error；没有任务记录时按「有没有分块」推断。
 */
function listDocs(id) {
  let out = [];
  try {
    const idx = readIndex(id);
    const docs = Object.values(idx.docs || {});
    const jobs = readJobs();
    const model = embeddingModelFor(getBase(id));
    out = docs
      .map((d) => {
        const chunks = d.chunks || [];
        const embedded = chunks.filter((c) => c.vec && c.vec.length).length;
        const job = jobs.find((j) => j.kb_id === id && (j.doc_id || j.name) === d.id);
        return {
          id: d.id,
          name: d.name,
          kind: d.kind || "file",
          url: d.url || "",
          size: d.size || 0,
          mtime: d.mtime || d.updated_at || "",
          chunks: chunks.length,
          embedded,
          indexed: chunks.length > 0,
          vectorized: embedded > 0,
          stale: vecStale(d, model),
          error: d.error || "",
          status: job ? job.state : chunks.length ? "ready" : "idle",
          attempts: job ? job.attempts || 0 : 0,
        };
      })
      .sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
  } catch (e) {
    // 目录读不出来时界面会显示「这个库是空的」——安静吞掉会让人以为文件丢了，留一条日志
    console.warn(`[知识库] 列出 ${id} 的文档失败：`, e.message);
  }
  return out;
}

/** 兼容老调用方：文件视角就是全部文档（笔记 / 网页也在里面，带 kind 区分） */
function listFiles(id) {
  return listDocs(id);
}

/** 一个文档的分块明细（查看分块用）。文本不截断，展示交给前端 */
function listChunks(id, docId) {
  const d = getDoc(id, docId);
  if (!d) throw new Error("文档不存在");
  return (d.chunks || []).map((c) => ({
    seq: c.seq,
    text: c.text,
    heading: c.heading || "",
    char_count: (c.text || "").length,
    embedded: !!(c.vec && c.vec.length),
  }));
}

/** 删除一个文档：文件类删磁盘文件，记录删索引，任务从队列里摘掉 */
function deleteDoc(id, docId) {
  const d = getDoc(id, docId);
  if (!d) throw new Error("文档不存在");
  if ((d.kind || "file") === "file") {
    tryIgnore(`删除文件 ${d.name}`, () => fs.rmSync(path.join(filesDir(id), d.name), { force: true }));
  }
  dropDoc(id, docId);
  tryIgnore(`清理任务 ${docId}`, () => {
    const jobs = readJobs().filter((j) => !(j.kb_id === id && (j.doc_id || j.name) === docId));
    writeJobs(jobs);
  });
  return { ok: true };
}

/** 兼容老接口：按文件名删（文件类文档 id 就是文件名） */
function deleteFile(id, name) {
  return deleteDoc(id, safeName(name));
}

// ---------- 正文抽取：纯文本直接读，xlsx 借 exceljs，docx/pptx 解 zip，pdf 走 pdfjs ----------

function extOf(name) {
  return path.extname(String(name || "")).toLowerCase();
}

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** docx 正文 XML → 带 markdown 标题的纯文本（标题映射成 #，好让标题感知切块用上） */
function docxXmlToText(xml) {
  const runsToText = (inner) =>
    unescapeXml(
      (inner
        .replace(/<w:tab\b[^>]*\/>/g, "<w:t>\t</w:t>")
        .replace(/<w:br\b[^>]*\/>/g, "<w:t>\n</w:t>")
        .match(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>/g) || [])
        .map((t) => t.replace(/^<w:t(?:\s[^>]*)?>/, "").replace(/<\/w:t>$/, ""))
        .join(""),
    ).trim();

  // 一次扫描同时认表格和段落，保住原文顺序（表格：行一条、单元格用制表符隔开，和 xlsx 一个口径）
  const re = /<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
  const out = [];
  for (const m of xml.matchAll(re)) {
    const raw = m[0];
    if (raw.startsWith("<w:tbl")) {
      const rows = [];
      for (const row of raw.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) || []) {
        const cells = (row.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) || []).map((tc) =>
          (tc.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) || []).map(runsToText).filter(Boolean).join(" "),
        );
        if (cells.some(Boolean)) rows.push(cells.join("\t"));
      }
      if (rows.length) out.push(rows.join("\n"));
      continue;
    }
    const text = runsToText(raw);
    if (!text) continue;
    // Word 的标题样式（英文 Heading1 / 中文「标题 1」）转成 #，切块时就能按章节走
    const style = (raw.match(/<w:pStyle\b[^>]*w:val="([^"]+)"/) || [])[1] || "";
    const lvl = /(?:heading|标题)\s*([1-6])/i.exec(style);
    out.push(lvl ? `${"#".repeat(Number(lvl[1]))} ${text}` : text);
  }
  return out.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** 读 zip 里的若干成员（docx/pptx 都是 zip + xml，不引额外的解析库） */
async function readZip(buf) {
  const JSZip = require("jszip");
  return JSZip.loadAsync(buf);
}

async function extractDocx(buf) {
  const zip = await readZip(buf);
  const doc = zip.file("word/document.xml");
  if (!doc) return { text: "", note: "这个 docx 里没有 word/document.xml（可能是 .doc 或文件损坏）" };
  return { text: docxXmlToText(await doc.async("string")) };
}

async function extractPptx(buf) {
  const zip = await readZip(buf);
  const slides = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => Number(/(\d+)/.exec(a)[1]) - Number(/(\d+)/.exec(b)[1]));
  if (!slides.length) return { text: "", note: "这个 pptx 里没找到幻灯片" };
  const out = [];
  for (let i = 0; i < slides.length; i++) {
    const xml = await zip.file(slides[i]).async("string");
    const texts = (xml.match(/<a:t>[\s\S]*?<\/a:t>/g) || [])
      .map((t) => unescapeXml(t.replace(/^<a:t>/, "").replace(/<\/a:t>$/, "")).trim())
      .filter(Boolean);
    if (texts.length) out.push(`# 第 ${i + 1} 张幻灯片\n${texts.join("\n")}`);
  }
  return { text: out.join("\n\n") };
}

/**
 * PDF 抽正文。pdfjs 是 ESM，CJS 这边只能动态 import；它的 worker 在 Node 下不走，
 * 显式关掉避免它去加载 worker 脚本。
 */
async function extractPdf(buf) {
  const mod = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = mod.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: false,
    isEvalSupported: false,
    disableFontFace: true,
  });
  const doc = await task.promise;
  const out = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      // item.hasEOL 是 pdfjs 标的换行；不认它就整页挤成一行，标题和列表全糊在一起
      let line = "";
      const lines = [];
      for (const it of content.items || []) {
        if (typeof it.str !== "string") continue;
        line += it.str;
        if (it.hasEOL) {
          lines.push(line);
          line = "";
        }
      }
      if (line) lines.push(line);
      const text = lines.map((l) => l.trimEnd()).join("\n").trim();
      if (text) out.push(text);
      page.cleanup();
    }
  } finally {
    // 释放句柄在 loadingTask 上（doc 上没有 destroy）。这里的失败绝不能冒泡出去——
    // finally 里抛错会把上面已经抽到的正文整个换掉，表现为「明明解析出来了却是空的」。
    try {
      await task.destroy();
    } catch {}
  }
  return { text: out.join("\n\n") };
}

/** @returns {Promise<{text:string, note?:string}>} */
async function extractText(name, buf) {
  const ext = extOf(name);
  if (ext === ".xlsx" || ext === ".xlsm") {
    try {
      const ExcelJS = require("exceljs");
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf);
      const lines = [];
      wb.eachSheet((ws) => {
        lines.push(`# 工作表：${ws.name}`);
        ws.eachRow((row) => {
          const cells = [];
          row.eachCell((c) => {
            let v = c.value;
            if (v && typeof v === "object") v = v.result !== undefined ? v.result : v.text !== undefined ? v.text : JSON.stringify(v);
            cells.push(v === null || v === undefined ? "" : String(v));
          });
          lines.push(cells.join("\t"));
        });
      });
      return { text: lines.join("\n") };
    } catch (e) {
      return { text: "", note: "xlsx 解析失败：" + e.message };
    }
  }
  if (ext === ".docx") {
    try {
      const r = await extractDocx(buf);
      if (!r.text) return { text: "", note: r.note || "docx 里没有可索引的文字" };
      return r;
    } catch (e) {
      return { text: "", note: "docx 解析失败：" + e.message };
    }
  }
  if (ext === ".pptx") {
    try {
      const r = await extractPptx(buf);
      if (!r.text) return { text: "", note: r.note || "pptx 里没有可索引的文字" };
      return r;
    } catch (e) {
      return { text: "", note: "pptx 解析失败：" + e.message };
    }
  }
  if (ext === ".pdf") {
    try {
      const r = await extractPdf(buf);
      // 扫描件没有文字层：抽出来是空的，这里说清楚，免得用户以为是自己传坏了
      if (!r.text) return { text: "", note: "PDF 里没有文字层（可能是扫描件/纯图片），需要 OCR 才能索引" };
      return r;
    } catch (e) {
      return { text: "", note: "pdf 解析失败：" + e.message };
    }
  }
  if (TEXT_EXT.has(ext)) {
    let text = buf.toString("utf8");
    if (ext === ".html" || ext === ".htm" || ext === ".xml") {
      text = text.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
      text = text
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">");
    }
    return { text };
  }
  return { text: "", note: `暂不支持解析 ${ext || "该"} 格式的内容（文件已保存，但未建索引）` };
}

// ---------- 分块：按标题/段落切，再拼到目标大小，尽量不切在句子中间 ----------

/**
 * 切块并带上溯源信息。
 * <p>
 * 比之前那版多了两样：标题层级（`## 第三章` 会被记成 heading path，检索时拼进向量化文本，
 * 让「这一块讲的是什么」进入语义；也让人看得懂命中来自哪一节）和 seq / 字符区间
 * （命中后把相邻块合并成一段、回复里标「第 k 段」都要靠它）。
 * @returns {{text:string, heading:string, seq:number, char_start:number, char_end:number}[]}
 */
function chunkWithMeta(text, size, overlap) {
  const clean = String(text || "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  if (!clean) return [];
  const sz = Math.max(200, Math.min(4000, Number(size) || 800));
  const ov = Math.max(0, Math.min(Math.floor(sz / 2), Number(overlap) || 0));

  // ① 切段：空行分段，markdown 标题另起一段并把层级记下来（标题本身不进正文，只作上下文前缀）
  const headingStack = []; // [{level, title}]，靠 level 回退维护「第几章 › 第几节」
  const headingPath = () => headingStack.map((h) => h.title).join(" › ");
  const segs = [];
  let buf = [];
  let bufStart = 0;
  let pos = 0;
  const flushPara = () => {
    const body = buf.join("\n").trim();
    buf = [];
    if (body) segs.push({ body, heading: headingPath(), start: bufStart, end: pos });
  };
  for (const line of clean.split("\n")) {
    const lineStart = pos;
    pos += line.length + 1;
    const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (m) {
      flushPara();
      const level = m[1].length;
      while (headingStack.length && headingStack[headingStack.length - 1].level >= level) headingStack.pop();
      headingStack.push({ level, title: m[2].trim() });
      continue;
    }
    if (!line.trim()) {
      flushPara();
      continue;
    }
    if (!buf.length) bufStart = lineStart;
    buf.push(line);
  }
  flushPara();

  // ② 拼块：段落往当前块里塞，塞不下就收口；收口后按 chunk_overlap 带上一段的尾巴
  const chunks = [];
  let cur = null;
  const push = () => {
    if (cur && cur.body.trim()) {
      chunks.push({ text: cur.body.trim(), heading: cur.heading, char_start: cur.start, char_end: cur.end });
    }
    cur = null;
  };
  for (const s of segs) {
    if (chunks.length >= MAX_CHUNKS_PER_FILE) break;
    // 单段就超长：按窗口硬切（重叠只在同一个超长段内部生效，跨段重叠由下面的 seed 处理）
    if (s.body.length > sz) {
      push();
      for (let i = 0; i < s.body.length && chunks.length < MAX_CHUNKS_PER_FILE; i += Math.max(1, sz - ov)) {
        chunks.push({ text: s.body.slice(i, i + sz), heading: s.heading, char_start: s.start + i, char_end: Math.min(s.start + i + sz, s.end) });
      }
      continue;
    }
    if (cur && cur.body.length + s.body.length + 2 > sz) {
      push();
      const tail = ov && chunks.length ? chunks[chunks.length - 1].text.slice(-ov) : "";
      cur = tail ? { body: tail + "\n" + s.body, heading: s.heading, start: Math.max(0, s.start - tail.length), end: s.end } : { body: s.body, heading: s.heading, start: s.start, end: s.end };
      continue;
    }
    if (cur) {
      cur.body += "\n" + s.body;
      cur.end = s.end;
      if (!cur.heading) cur.heading = s.heading;
    } else {
      cur = { body: s.body, heading: s.heading, start: s.start, end: s.end };
    }
  }
  push();
  return chunks.slice(0, MAX_CHUNKS_PER_FILE).map((c, i) => ({ ...c, seq: i }));
}

/** 只要文本的旧接口（重建索引、外部调用都还在用） */
function chunkText(text, size, overlap) {
  return chunkWithMeta(text, size, overlap).map((c) => c.text);
}

// ==================== 向量 / 重排 ====================

function roundVec(v) {
  return Array.isArray(v) ? v.map((x) => Math.round(Number(x) * 10 ** VEC_ROUND) / 10 ** VEC_ROUND) : [];
}

/** DashScope 的原生 /api/v1 不认 /embeddings，它的 OpenAI 兼容层在 /compatible-mode/v1 */
function normalizeEmbedBase(url) {
  const b = String(url || "").trim().replace(/\/+$/, "");
  return /dashscope\.aliyuncs\.com/i.test(b) ? b.replace(/\/api\/v\d+$/i, "/compatible-mode/v1") : b;
}

/**
 * 按 OpenAI 兼容协议打一批文本，返回与输入顺序对齐的向量。
 * 条数/形状不对就抛——宁可这次降级到关键词，也不能让长度错位的向量混进索引。
 */
async function callEmbeddings(cfg, texts) {
  const resp = await fetch(joinUrl(normalizeEmbedBase(cfg.base_url), "/embeddings"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.api_key || "ollama"}` },
    body: JSON.stringify({ model: cfg.model, input: texts }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}：${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  const out = (Array.isArray(data && data.data) ? data.data : [])
    .slice()
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .map((d) => d.embedding);
  if (out.length !== texts.length || out.some((v) => !Array.isArray(v))) throw new Error("返回的向量条数或形状不对");
  return out;
}

/**
 * 送向量前的长度约束。
 * <p>
 * bge 这类中文模型的上限是 512 token，而中文大致「一字一 token」——默认切块 800 字一次发过去
 * 会被服务端直接判 400（硅基流动 code 20015），表现为「整份文件向量化失败」，切块参数越标准越必现。
 * 所以送向量前按上限截断：保留头部（这一段在讲什么）和尾部（结论/参数常在这），中间省略。
 * 注意只影响送去算向量的那份文本，正文、关键词索引、界面展示都还是完整的。
 */
const EMBED_MAX_CHARS = 480;
/** 一批的总字符上限：条数不多但每条都长时，总量仍可能顶到服务端的请求上限 */
const EMBED_BATCH_CHARS = 6000;
const EMBED_BATCH_MAX = 32;

function clampForEmbed(text) {
  const s = String(text || "");
  if (s.length <= EMBED_MAX_CHARS) return s;
  const head = Math.ceil(EMBED_MAX_CHARS * 0.75);
  const tail = EMBED_MAX_CHARS - head;
  return `${s.slice(0, head)}\n…\n${s.slice(-tail)}`;
}

/**
 * 一批失败就对半切开重试，切到单条还失败就放弃这一条。
 * 一条超限/坏掉不该让整份文件都没有向量——能算的算出来，算不了的那段退回关键词。
 */
async function embedSliceResilient(cfg, texts) {
  try {
    return await callEmbeddings(cfg, texts);
  } catch (e) {
    if (texts.length <= 1) {
      console.warn(`[知识库] 有 1 段文本向量化失败（${String(e.message).slice(0, 120)}），该段只有关键词，无向量`);
      return [null];
    }
    const mid = Math.floor(texts.length / 2);
    const a = await embedSliceResilient(cfg, texts.slice(0, mid));
    const b = await embedSliceResilient(cfg, texts.slice(mid));
    return a.concat(b);
  }
}

/** 按总字符与条数上限切批，逐批算；个别段失败不影响其它段（返回数组里对应位置为 null） */
async function callEmbeddingsBatched(cfg, texts) {
  const out = new Array(texts.length).fill(null);
  let i = 0;
  while (i < texts.length) {
    let j = i;
    let chars = 0;
    while (j < texts.length && j - i < EMBED_BATCH_MAX && (j === i || chars + texts[j].length <= EMBED_BATCH_CHARS)) {
      chars += texts[j].length;
      j += 1;
    }
    const slice = texts.slice(i, j);
    const got = await embedSliceResilient(cfg, slice);
    for (let k = 0; k < slice.length; k++) out[i + k] = got[k] || null;
    i = j;
  }
  return out;
}

/**
 * 向量化一批文本。返回 {vecs, model}；拿不到就 vecs=null（调用方退回关键词），绝不抛。
 * cfg 是调用方按「这个库」解析出来的渠道（每库配置）；不传才回落到全局选的、再回落共用的 embedder。
 * 选了渠道就用选的这条（失败也只降级，不去偷偷换别的模型——换了向量就不在一个空间里了）。
 * 个别段失败时，对应位置返回 null（那段没有向量，其它段照常）——只要有一条成功就不算整批降级。
 */
async function embedFor(texts, cfg) {
  if (!texts.length) return { vecs: null, model: "" };
  const prepared = texts.map(clampForEmbed);
  const sel = cfg || embedCfg();
  if (sel) {
    let got;
    try {
      got = await callEmbeddingsBatched(sel, prepared);
    } catch (e) {
      console.warn(`[知识库] 向量渠道「${sel.channel} · ${sel.model}」调用失败（${String(e.message).slice(0, 160)}），本次按关键词检索兜底`);
      return { vecs: null, model: "" };
    }
    if (!got.some((v) => v && v.length)) {
      console.warn(`[知识库] 向量渠道「${sel.channel} · ${sel.model}」没返回可用向量，本次按关键词检索兜底`);
      return { vecs: null, model: "" };
    }
    const missing = got.filter((v) => !v || !v.length).length;
    if (missing) console.warn(`[知识库] 有 ${missing}/${texts.length} 段没算出向量（多半是单段超长），这些段只有关键词`);
    return { vecs: got.map((v) => (v && v.length ? roundVec(v) : null)), model: sel.model };
  }
  if (!embedder) return { vecs: null, model: "" };
  const vecs = await embedTexts(prepared);
  // embedder 连挂三次会自己换道，此时 model 已变——必须以换完之后的为准，否则记的模型和向量对不上
  return { vecs, model: vecs ? embeddingModel() : "" };
}

/** 经注入的 embedder 批量向量化；失败返回 null（embedder 自己会降级/换道，不抛） */
async function embedTexts(texts) {
  if (!embedder || !texts.length) return null;
  const out = await embedder(texts);
  if (!out) return null;
  return out.map(roundVec);
}

function joinUrl(base, suffix) {
  return String(base || "").trim().replace(/\/+$/, "") + suffix;
}

/** 对候选段重排（Jina / Cohere 风格 /rerank）。返回 [{index, score}]；未配或失败返回 null */
async function rerankDocs(query, docs, topN, cfg) {
  const r = cfg || rerankCfg();
  if (!r.base_url || !r.model || docs.length < 2) return null;
  const resp = await fetch(joinUrl(r.base_url, "/rerank"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(r.api_key ? { Authorization: "Bearer " + r.api_key } : {}) },
    body: JSON.stringify({ model: r.model, query, documents: docs, top_n: Math.min(topN || docs.length, docs.length) }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`rerank 接口返回 HTTP ${resp.status}：${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  const list = (data && (data.results || data.data)) || [];
  const out = list
    .map((it) => ({ index: it.index ?? it.document_index ?? 0, score: Number(it.relevance_score ?? it.score ?? it.relevance ?? 0) }))
    .filter((it) => Number.isFinite(it.index));
  return out.length ? out : null;
}

// ==================== 召回打分 ====================

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 中文按 2-gram、英文数字按词切查询项（本地零依赖的关键词打分用） */
function queryTerms(q) {
  const s = String(q || "").toLowerCase();
  const terms = new Set();
  for (const w of s.match(/[a-z0-9_]{2,}/g) || []) terms.add(w);
  for (const seg of s.match(/[\u4e00-\u9fff]+/g) || []) {
    if (seg.length === 1) terms.add(seg);
    for (let i = 0; i < seg.length - 1; i++) terms.add(seg.slice(i, i + 2));
  }
  return [...terms];
}

function keywordScore(terms, text) {
  if (!terms.length) return 0;
  const t = text.toLowerCase();
  let hit = 0;
  let weight = 0;
  for (const term of terms) {
    if (t.indexOf(term) >= 0) {
      hit += 1;
      weight += term.length; // 命中越长的词越说明相关
    }
  }
  if (!hit) return 0;
  return (hit + weight / (terms[0].length + 4)) / Math.sqrt(text.length / 100 + 1);
}

// ==================== 检索 ====================

const RRF_K = 60; // RRF 平滑常数：第 1 名贡献 1/61，名次靠后衰减很慢，靠后的好结果还有机会
const DEDUPE_JACCARD = 0.95; // 段落级重复阈值。定得高是故意的：模板/FAQ 这类本来就长得像的条目别被误删
const CANDIDATES_PER_PATH = 50; // 每路各取前多少条进融合池

/** 词元集合（2-gram / 词），去重用 */
function tokenSet(s) {
  return new Set(queryTerms(s));
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** RRF 融合 + 展示打分（在同一个候选集内做排名） */
function fuseRank(cands, t) {
  // 取每路前 N 名而不是全量：排名几百名开外的 1/(60+rank) 贡献可以忽略
  const byVec = cands.filter((c) => c.vscore > 0).sort((a, b) => b.vscore - a.vscore).slice(0, CANDIDATES_PER_PATH);
  const byKw = cands.filter((c) => c.kscore > 0).sort((a, b) => b.kscore - a.kscore).slice(0, CANDIDATES_PER_PATH);
  const fused = new Map();
  byVec.forEach((c, i) => fused.set(c, (fused.get(c) || 0) + 1 / (RRF_K + i + 1)));
  byKw.forEach((c, i) => fused.set(c, (fused.get(c) || 0) + 1 / (RRF_K + i + 1)));
  return [...fused.entries()]
    .map(([c, rrf]) => ({
      ...c,
      rrf,
      matched: c.vscore > 0 && c.kscore > 0 ? "both" : c.vscore > 0 ? "vector" : "keyword",
      score: c.vscore > 0 ? c.vscore : c.kscore, // 展示口径：语义分优先
    }))
    .filter((c) => c.score >= t.score_threshold)
    .sort((a, b) => b.rrf - a.rrf);
}

/**
 * 相邻块合并：命中常常落在同一段被切开的两块上，拼回一段模型才读得连贯；
 * 只在「相邻的块这次也被召回」时才拼，避免把整篇都灌进去。
 */
function mergeNeighbors(ranked, t) {
  const MERGE_BUDGET = Math.max(400, t.chunk_size * 2);
  const byFile = new Map();
  for (const c of ranked) {
    const k = c.kb_id + "\u0000" + c.doc_id;
    if (!byFile.has(k)) byFile.set(k, new Map());
    byFile.get(k).set(c.seq, c);
  }
  const used = new Set();
  const merged = [];
  for (const hit of ranked) {
    if (used.has(hit)) continue;
    const neigh = byFile.get(hit.kb_id + "\u0000" + hit.doc_id);
    const group = [hit];
    used.add(hit);
    let lo = hit.seq;
    let hi = hit.seq;
    let budget = MERGE_BUDGET - hit.text.length;
    for (;;) {
      const next = neigh.get(hi + 1);
      if (!next || used.has(next) || next.text.length > budget) break;
      group.push(next);
      used.add(next);
      hi += 1;
      budget -= next.text.length;
    }
    for (;;) {
      const prev = neigh.get(lo - 1);
      if (!prev || used.has(prev) || prev.text.length > budget) break;
      group.unshift(prev);
      used.add(prev);
      lo -= 1;
      budget -= prev.text.length;
    }
    group.sort((a, b) => a.seq - b.seq);
    // 跨章节合并时把两段的标题都留着，用「；」隔开——标题路径本身就用「›」，
    // 再用「›」拼会读成一条越来越长的路径，看不出这是两节
    const heads = [...new Set(group.map((g) => g.heading).filter(Boolean))];
    merged.push({
      ...hit,
      text: group.map((g) => g.text).join("\n"),
      heading: heads.join("；").slice(0, 200),
      seq: lo,
      seq_end: hi,
      merged: group.length,
      score: Math.max(...group.map((g) => g.score)),
      matched: group.some((g) => g.matched === "both") ? "both" : hit.matched,
    });
  }
  return merged;
}

/** 去重：同一段被切成多块命中、或文件里本来就有重复段落时，只留一条 */
function dedupeHits(merged) {
  const kept = [];
  const seenTokens = [];
  for (const h of merged) {
    const tk = tokenSet(h.text);
    if (seenTokens.some((s) => jaccard(s, tk) >= DEDUPE_JACCARD)) continue;
    kept.push(h);
    seenTokens.push(tk);
  }
  return kept;
}

/** 重排 + 截断 topK（这个库配了重排渠道才走真实重排，否则原序截断） */
async function applyRerank(q, kept, t, cfg, notes) {
  const topK = Math.max(1, Math.min(50, t.top_k));
  let final = kept;
  const poolSize = Math.min(final.length, Math.max(topK * 4, 20));
  if (cfg && cfg.base_url && cfg.model && poolSize > 1) {
    const head = final.slice(0, poolSize);
    try {
      // 送重排时把标题一起带上：标题是这一块「讲什么」的最短描述，缺了它重排容易判错
      const rr = await rerankDocs(q, head.map((c) => (c.heading ? `${c.heading}\n${c.text}` : c.text)), topK, cfg);
      if (rr) {
        const reordered = rr
          .map((it) => ({ ...head[it.index], score: it.score, reranked: true }))
          .filter((c) => c && c.text)
          .sort((a, b) => b.score - a.score);
        final = reordered.concat(final.slice(poolSize));
      } else {
        notes.push("重排没有返回结果，已用融合排序");
      }
    } catch (e) {
      notes.push("重排接口调用失败，已用融合排序");
    }
  }
  return final.slice(0, topK);
}

/**
 * 检索主流程：**逐库**做「两路召回 → RRF 融合 → 相邻块合并 → 去重 → 重排」，再合并总排名。
 * 之所以一个库一个库地跑：每个库可以有自己的向量模型、重排渠道和 topK，
 * 用一套全局参数硬套所有库会让「这个库配了重排、那个库没配」这种组合失效。
 * @returns {Promise<{hits:object[], mode:string, model:string, notes:string[]}>}
 */
async function searchDetailed(query, ids) {
  const q = String(query || "").trim();
  const baseIds = (Array.isArray(ids) ? ids : []).filter(Boolean);
  const notes = [];
  if (!q || !baseIds.length) return { hits: [], mode: "none", model: "", notes };

  const terms = queryTerms(q);
  const all = [];
  const models = new Set();
  let stale = 0;
  let vectorUsed = false;
  let vectorTried = false;
  let topK = 1;

  for (const id of baseIds) {
    const base = getBase(id);
    if (!base) continue;
    const t = tuningFor(base);
    topK = Math.max(topK, Math.max(1, Math.min(50, t.top_k)));
    const cfg = embedCfgFor(base);
    const canVec = !!(cfg || embedder);

    // 查询向量必须和索引里的向量同源，而每个库可能用不同的模型——所以逐库算
    let qvec = null;
    let model = "";
    if (canVec) {
      vectorTried = true;
      const r = await embedFor([q], cfg);
      qvec = r.vecs && r.vecs[0] && r.vecs[0].length ? r.vecs[0] : null;
      model = r.model || "";
      if (!qvec) notes.push(`「${base.name}」向量召回本次不可用，已按关键词检索`);
    }
    if (model) models.add(model);

    const idx = readIndex(id);
    const cands = [];
    for (const doc of Object.values(idx.docs || {})) {
      // 向量只在与查询同模型时才算：不同模型的向量不在一个空间里，硬算余弦得到的是貌似相关的噪声。
      // 旧索引没有 embed_model，退回读 embedding 字段（它记的就是当年算向量的那条模型）。
      const recModel = String(doc.embed_model || doc.embedding || "");
      const vecUsable = !!(qvec && recModel && recModel === model);
      for (const ch of doc.chunks || []) {
        const hasVec = !!(ch.vec && ch.vec.length);
        const vscore = vecUsable && hasVec ? cosine(qvec, ch.vec) : 0;
        const kscore = keywordScore(terms, ch.text);
        if (qvec && hasVec && !vecUsable) stale += 1;
        if (vscore <= 0 && kscore <= 0) continue;
        cands.push({
          kb_id: id,
          kb: base.name,
          doc_id: doc.id,
          kind: doc.kind || "file",
          file: doc.name,
          text: ch.text,
          seq: Number.isFinite(ch.seq) ? ch.seq : 0,
          heading: String(ch.heading || ""),
          vscore,
          kscore,
        });
      }
    }
    if (qvec) vectorUsed = true;

    const ranked = fuseRank(cands, t);
    const merged = mergeNeighbors(ranked, t);
    const kept = dedupeHits(merged);
    const final = await applyRerank(q, kept, t, rerankCfgFor(base), notes);
    all.push(...final);
  }

  if (stale) notes.push(`有 ${stale} 段向量是别的模型算的，本次已跳过；在知识库页「重建索引」可恢复语义召回`);
  if (!vectorTried) notes.push("未配向量模型，按关键词检索");
  all.sort((a, b) => b.score - a.score);
  const mode = [vectorUsed ? "向量" : "", terms.length ? "关键词" : ""].filter(Boolean).join(" + ") || "无";
  return { hits: all.slice(0, topK), mode, model: [...models].join("、"), notes };
}

/**
 * 在指定知识库里检索。
 * @param {string} query
 * @param {string[]} ids 选中的知识库 id；为空则返回空
 */
async function search(query, ids) {
  return (await searchDetailed(query, ids)).hits;
}

/**
 * 拼给模型的上下文块，带 [n] 编号与可引用的来源。没有命中返回空串。
 * 同时回一份 citations（引用元数据），对话末尾的「来源」就靠它渲染，不用再让前端去猜编号。
 */
async function buildContext(query, ids) {
  const baseIds = (Array.isArray(ids) ? ids : []).filter(Boolean);
  const { hits } = await searchDetailed(query, baseIds);
  if (!hits.length) return { text: "", hits: [], citations: [] };
  // 注入上限按这几个库里最宽的那档，避免选了个大库却被全局小值卡住
  const limit = baseIds.reduce((m, id) => {
    const b = getBase(id);
    return b ? Math.max(m, tuningFor(b).inject_chars) : m;
  }, tuning().inject_chars);
  const cap = Math.max(1000, Math.min(40000, limit));
  const picked = [];
  let used = 0;
  for (const h of hits) {
    const block = `[${picked.length + 1}] ${h.kb} · ${h.file}\n${h.text}`;
    if (used + block.length > cap && picked.length) break;
    picked.push(h);
    used += block.length;
  }
  const parts = picked.map((h, i) => {
    const span = h.seq_end > h.seq ? `第 ${h.seq + 1}-${h.seq_end + 1} 段` : `第 ${h.seq + 1} 段`;
    return `[${i + 1}] 来源：${h.kb} · ${h.file}${h.heading ? ` › ${h.heading}` : ""}（${span}）\n${h.text}`;
  });
  const text =
    `\n\n## 知识库检索结果（来自用户所选知识库，按相关度排序）\n` +
    `回答时优先依据以下资料；若资料不足以回答，明确说明并再向用户确认，不要编造。\n` +
    `引用资料时在句末标出它的编号（如 [1]），只引用下面有的编号。\n` +
    `下面是按用户这句话召回的前几段，不是全部——要找别的配置项、参数或章节细节时，用 knowledge_search 工具继续检索这几个库。\n\n` +
    parts.join("\n\n---\n\n");
  const citations = picked.map((h, i) => ({
    n: i + 1,
    kb_id: h.kb_id,
    kb_name: h.kb,
    doc_id: h.doc_id,
    doc_name: h.file,
    kind: h.kind || "file",
    seq: h.seq,
    heading: h.heading || "",
    score: h.score,
    matched: h.matched || "",
    reranked: !!h.reranked,
    snippet: String(h.text || "").replace(/\s+/g, " ").slice(0, 160),
  }));
  return { text, hits, citations, used };
}

// ==================== 建索引 ====================

/** 送去做向量的文本：前缀带上文件名与标题路径，让「这一块讲的是什么」进入语义；展示仍用原始正文 */
function embedContext(name, c) {
  const head = [name, c.heading].filter(Boolean).join(" › ");
  return head ? `${head}\n${c.text}` : c.text;
}

/**
 * 给一个文档建索引：取正文 → 分块 → 有向量渠道就批量向量化。
 * 文件类从磁盘抽正文（docx/pptx/xlsx/pdf/文本），笔记 / 网页直接用内联的 content。
 * 任何环节失败都退化为「只有文本分块」，只记 error 不抛，避免一份坏资料拖垮整库。
 * @param {object} [opts] onProgress 供后台队列回报进度
 */
async function ingestDoc(id, docId, opts = {}) {
  const d = getDoc(id, docId);
  if (!d) return { id: docId, name: docId, chunks: 0, indexed: false, error: "文档不存在" };
  const base = getBase(id);
  const t = tuningFor(base);

  let text = "";
  let note = "";
  let size = d.size || 0;
  let mtime = d.mtime || "";
  if ((d.kind || "file") === "file") {
    const full = path.join(filesDir(id), d.name);
    if (!fs.existsSync(full)) {
      dropDoc(id, docId);
      return { id: docId, name: d.name, chunks: 0, indexed: false, error: "文件不存在" };
    }
    const st = fs.statSync(full);
    size = st.size;
    mtime = st.mtime.toISOString();
    if (st.size > MAX_FILE_BYTES) {
      Object.assign(d, { size, mtime, chunks: [], error: "文件过大，未建索引" });
      putDoc(id, d);
      return { id: docId, name: d.name, chunks: 0, indexed: false, error: d.error };
    }
    const buf = await fs.promises.readFile(full);
    const r = await extractText(d.name, buf);
    text = r.text;
    note = r.note || "";
  } else {
    text = String(d.content || "");
  }

  const chunks = chunkWithMeta(text, t.chunk_size, t.chunk_overlap);
  if (!chunks.length) {
    Object.assign(d, { size, mtime, chunks: [], error: note || "没有可索引的文本内容" });
    putDoc(id, d);
    return { id: docId, name: d.name, chunks: 0, indexed: false, error: d.error };
  }

  // 向量化：embedFor 内部已降级（拿不到就 vecs=null），这里只在失败时记一笔
  const cfg = embedCfgFor(base);
  let vecs = null;
  let embedModel = "";
  let embedError = "";
  if (cfg || embedder) {
    if (typeof opts.onProgress === "function") opts.onProgress({ phase: "embedding", chunks: chunks.length });
    const r = await embedFor(chunks.map((c) => embedContext(d.name, c)), cfg);
    vecs = r.vecs;
    embedModel = r.model;
    if (!vecs) {
      embedError = "向量化没成功（已按关键词检索兜底）";
    } else {
      const miss = vecs.filter((v) => !v || !v.length).length;
      if (miss) embedError = `有 ${miss} 段没算出向量（多半是单段超长），这几段按关键词检索`;
    }
  }
  const records = chunks.map((c, i) => {
    const rec = { text: c.text, heading: c.heading, seq: c.seq, char_start: c.char_start, char_end: c.char_end };
    if (vecs && vecs[i] && vecs[i].length) rec.vec = vecs[i];
    return rec;
  });
  // embed_model 是「这批向量是谁算的」——换了向量模型后它会跟当前模型对不上，
  // 检索据此跳过这些向量（不同模型的向量没法比），而不是拿噪声当相似度。
  Object.assign(d, {
    size,
    mtime,
    chunks: records,
    embed_model: vecs ? embedModel : "",
    embedding: vecs ? embedModel : "",
    error: embedError,
  });
  putDoc(id, d);
  return { id: docId, name: d.name, chunks: records.length, indexed: true, error: embedError };
}

/** 兼容老名字（历史上只处理文件类文档） */
async function indexFile(id, name, opts = {}) {
  return ingestDoc(id, safeName(name), opts);
}

/** 重建整个库的索引（换了 embedding 模型、或改了切块参数后要重跑一遍） */
async function reindexBase(id, opts = {}) {
  if (!getBase(id)) throw new Error("知识库不存在");
  const docs = listDocs(id);
  const results = [];
  for (let i = 0; i < docs.length; i++) {
    if (typeof opts.onProgress === "function") opts.onProgress({ phase: "reindex", done: i, total: docs.length, current: docs[i].name });
    results.push(await ingestDoc(id, docs[i].id));
  }
  return results;
}

// ==================== 笔记 / 网页数据源 ====================

/** 没有磁盘文件的文档（笔记 / 网页）用的 id */
function syntheticDocId(kind) {
  return kind + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
}

/** HTML → 纯文本：去脚本/样式/标签。和 extractText 处理 .html 用的是同一口径 */
function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 抓一个网页，返回标题与正文（正文入库，标题当文档名） */
async function fetchWebText(url) {
  const u = String(url || "").trim();
  if (!/^https?:\/\//i.test(u)) throw new Error("网址要以 http:// 或 https:// 开头");
  const resp = await fetch(u, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; KylinWork/1.0)", Accept: "text/html,application/xhtml+xml" },
    signal: AbortSignal.timeout(20000),
    redirect: "follow",
  });
  if (!resp.ok) throw new Error(`抓取失败：HTTP ${resp.status}`);
  const html = await resp.text();
  const rawTitle = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
  const title = String(rawTitle).trim().slice(0, 120) || u;
  return { title, text: htmlToText(html) };
}

/** 加一条笔记：正文内联，不需要磁盘文件 */
function addNote(id, { title, content } = {}) {
  if (!getBase(id)) throw new Error("知识库不存在");
  const text = String(content || "");
  if (!text.trim()) throw new Error("笔记内容不能为空");
  const name = String(title || "").trim().slice(0, 80) || "笔记 " + new Date().toLocaleString("zh-CN");
  const now = new Date().toISOString();
  const doc = { id: syntheticDocId("note"), name, kind: "note", content: text, size: Buffer.byteLength(text), mtime: now, created_at: now, chunks: [], error: "" };
  putDoc(id, doc);
  enqueueIndex(id, doc.id);
  return doc;
}

/** 加一个网页：服务端抓正文后入库 */
async function addWeb(id, { url } = {}) {
  if (!getBase(id)) throw new Error("知识库不存在");
  const { title, text } = await fetchWebText(url);
  if (!text) throw new Error("这个网页没抓到正文（可能是纯 JS 渲染的页面）");
  const now = new Date().toISOString();
  const doc = { id: syntheticDocId("web"), name: title, kind: "web", url: String(url), content: text, size: Buffer.byteLength(text), mtime: now, created_at: now, chunks: [], error: "" };
  putDoc(id, doc);
  enqueueIndex(id, doc.id);
  return doc;
}

// ==================== 后台入库队列 ====================
//
// 上传即返回，抽正文 / 分块 / 向量化在后台排队跑：一份大 xlsx 或长 pdf 走完这套要几十秒，
// 同步做完会把上传请求吊着（前端看着像卡死），中途一断还得整个重来。
// 队列落盘在 jobs.json：进程重启后把 running 的捞回队列接着跑，失败按次数退避重试。
// 并发固定 1：向量化是花钱且限速的外部调用，堆并发只会换来 429。

const JOBS_FILE = path.join(ROOT, "jobs.json");
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [2000, 8000, 20000];
const MAX_JOB_RECORDS = 500; // 仅作历史查询用，太多就裁掉最老的

let pumpRunning = false;
let pumpTimer = null;

function readJobs() {
  const d = store.readJson(JOBS_FILE, { jobs: [] });
  return d && Array.isArray(d.jobs) ? d.jobs : [];
}
function writeJobs(jobs) {
  ensureRoot();
  // 只保留还在跑的 + 最近的若干条，免得 jobs.json 无限长大
  const live = jobs.filter((j) => j.state === "queued" || j.state === "running");
  const done = jobs.filter((j) => j.state !== "queued" && j.state !== "running").slice(-MAX_JOB_RECORDS);
  store.writeJsonAtomic(JOBS_FILE, { jobs: live.concat(done) }, { pretty: true });
}
function nowIso() {
  return new Date().toISOString();
}

/** 某个文档当前的入库状态：queued / running / ready / error（没记录返回空串） */
function statusOf(kbId, docId) {
  const j = readJobs().find((x) => x.kb_id === kbId && (x.doc_id || x.name) === docId);
  return j ? j.state : "";
}

/** 同一个文档的任务只留一条：重新上传 / 重试都是把旧记录顶掉重排到队尾 */
function enqueueIndex(kbId, docId) {
  const d = getDoc(kbId, docId);
  const label = d ? d.name : String(docId);
  const jobs = readJobs().filter((j) => !(j.kb_id === kbId && (j.doc_id || j.name) === docId));
  jobs.push({
    id: "job_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6),
    kb_id: kbId,
    doc_id: docId,
    name: label,
    state: "queued",
    attempts: 0,
    error: "",
    chunks: 0,
    enqueued_at: nowIso(),
    started_at: "",
    finished_at: "",
    next_run_at: Date.now(),
  });
  writeJobs(jobs);
  kick();
  return { doc_id: docId, name: label, state: "queued" };
}

/** 整库重排：每个文档各排一条（换了向量模型 / 改了切块参数后重跑） */
function enqueueReindex(kbId) {
  if (!getBase(kbId)) throw new Error("知识库不存在");
  const docs = listDocs(kbId);
  for (const d of docs) enqueueIndex(kbId, d.id);
  return { queued: docs.length };
}

/** 只给「有分块但没向量」的文档补向量（换了模型把向量清掉时用，不重切块） */
function enqueueEmbedMissing(kbId) {
  if (!getBase(kbId)) throw new Error("知识库不存在");
  const docs = listDocs(kbId).filter((d) => d.chunks > 0 && d.embedded < d.chunks);
  for (const d of docs) enqueueIndex(kbId, d.id);
  return { queued: docs.length };
}

/** 失败重试用：把一条任务重新排进队列 */
function retryJob(kbId, docId) {
  return enqueueIndex(kbId, docId);
}

function queueStats() {
  const jobs = readJobs();
  const by = (s) => jobs.filter((j) => j.state === s).length;
  return { queued: by("queued"), running: by("running"), ready: by("ready"), failed: by("error") };
}

function kick() {
  pump().catch((e) => console.warn("[知识库] 入库队列异常：", e.message));
}

function schedulePump(at) {
  if (pumpTimer) clearTimeout(pumpTimer);
  const wait = Math.max(200, at - Date.now());
  pumpTimer = setTimeout(() => {
    pumpTimer = null;
    kick();
  }, wait);
}

/** 队列泵：一次取一条，跑完再取下一条。退避中的任务到点了由定时器叫醒 */
async function pump() {
  if (pumpRunning) return;
  pumpRunning = true;
  try {
    for (;;) {
      const jobs = readJobs();
      const idx = jobs.findIndex((j) => j.state === "queued" && (j.next_run_at || 0) <= Date.now());
      if (idx < 0) {
        const pending = jobs.filter((j) => j.state === "queued").map((j) => j.next_run_at || 0);
        if (pending.length) schedulePump(Math.min(...pending));
        break;
      }
      const job = jobs[idx];
      job.state = "running";
      job.attempts = (job.attempts || 0) + 1;
      job.started_at = nowIso();
      job.error = "";
      writeJobs(jobs);
      try {
        const r = await ingestDoc(job.kb_id, job.doc_id || job.name);
        const after = readJobs();
        const cur = after.find((j) => j.id === job.id);
        if (cur) {
          // 分块建出来了就算成功——向量没算上只是少了语义召回，关键词还能用，
          // 标成「入库失败」会让人以为这份资料完全没进去（error 文案仍留着说明原因）
          cur.state = r.chunks > 0 ? "ready" : "error";
          cur.error = r.error || "";
          cur.chunks = r.chunks || 0;
          cur.finished_at = nowIso();
          writeJobs(after);
        }
      } catch (e) {
        const after = readJobs();
        const cur = after.find((j) => j.id === job.id);
        if (!cur) continue;
        const giveUp = cur.attempts >= MAX_ATTEMPTS;
        cur.error = String((e && e.message) || e).slice(0, 300);
        if (giveUp) {
          cur.state = "error";
          cur.finished_at = nowIso();
          console.warn(`[知识库] 「${job.name}」入库失败 ${cur.attempts} 次，放弃：${cur.error}`);
        } else {
          const wait = RETRY_BACKOFF_MS[Math.min(cur.attempts - 1, RETRY_BACKOFF_MS.length - 1)];
          cur.state = "queued";
          cur.next_run_at = Date.now() + wait;
          console.warn(`[知识库] 「${job.name}」入库失败（第 ${cur.attempts}/${MAX_ATTEMPTS} 次）：${cur.error}，${Math.round(wait / 1000)}s 后重试`);
        }
        writeJobs(after);
      }
    }
  } finally {
    pumpRunning = false;
  }
}

/**
 * 启动时把「上次跑到一半就断电/退出」的任务捞回队列继续。
 * 不做的话这些任务会永远卡在 running，界面上看着像一直在建索引。
 */
function resumeQueue() {
  const jobs = readJobs();
  let adopted = 0;
  for (const j of jobs) {
    if (j.state === "running") {
      j.state = "queued";
      j.next_run_at = Date.now();
      adopted += 1;
    }
  }
  // 顺手清掉已经不存在（库或文档被删）的任务，免得每次启动都在捞僵尸
  const alive = jobs.filter((j) => {
    if (!getBase(j.kb_id)) return false;
    if (j.state === "ready") return true;
    const docId = j.doc_id || j.name;
    if (getDoc(j.kb_id, docId)) return true;
    // 老任务只有 name，且文档记录可能还没建出来——退回看磁盘文件在不在
    return fs.existsSync(path.join(filesDir(j.kb_id), j.name));
  });
  writeJobs(alive);
  if (adopted) console.log(`[知识库] 上次有 ${adopted} 个入库任务没跑完，已放回队列继续`);
  const queued = readJobs().filter((j) => j.state === "queued").length;
  if (queued) kick();
  return { adopted, queued };
}

// ==================== 配置自检（设置页的「测试」按钮） ====================
// 传的是「渠道::模型」复合键（来自设置→模型里标为向量/重排的模型）；不传就用当前选中的。

/** 直连测一条向量模型（走它所属渠道的 base_url / key） */
async function testEmbedding(ref) {
  const e = resolveChannelModel(ref || selectedRefs().embedding);
  if (!e) throw new Error("请先在 设置 → 模型 里添加一个「向量(Embedding)」类型的模型并选中");
  let base = String(e.base_url).trim().replace(/\/+$/, "");
  if (/dashscope\.aliyuncs\.com/i.test(base)) base = base.replace(/\/api\/v\d+$/i, "/compatible-mode/v1");
  const resp = await fetch(joinUrl(base, "/embeddings"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${e.api_key || "ollama"}` },
    body: JSON.stringify({ model: e.model, input: ["连接测试"] }),
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}：${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  const v = data && data.data && data.data[0] && data.data[0].embedding;
  if (!Array.isArray(v)) throw new Error("接口没有返回向量");
  return { ok: true, dim: v.length, model: e.model };
}

/** 直连测 rerank 模型 */
async function testRerank(ref) {
  const r = resolveChannelModel(ref || selectedRefs().rerank);
  if (!r) throw new Error("请先在 设置 → 模型 里添加一个「重排(Reranker)」类型的模型并选中");
  const rr = await rerankDocsWith("知识库怎么用", ["知识库用于检索问答", "今天天气不错"], r);
  if (!rr) throw new Error("接口没有返回重排结果");
  return { ok: true, top: rr[0] };
}

async function rerankDocsWith(query, docs, r) {
  const resp = await fetch(joinUrl(r.base_url, "/rerank"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(r.api_key ? { Authorization: "Bearer " + r.api_key } : {}) },
    body: JSON.stringify({ model: r.model, query, documents: docs, top_n: docs.length }),
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}：${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  const list = (data && (data.results || data.data)) || [];
  const out = list
    .map((it) => ({ index: it.index ?? it.document_index ?? 0, score: Number(it.relevance_score ?? it.score ?? it.relevance ?? 0) }))
    .filter((it) => Number.isFinite(it.index));
  return out.length ? out : null;
}

module.exports = {
  ROOT,
  MAX_FILE_BYTES,
  MAX_UPLOAD_BYTES,
  setConfig,
  setEmbedder,
  embeddingConfigured,
  embeddingModel,
  embeddingSource,
  rerankConfigured,
  selectedRefs,
  listBases,
  getBase,
  createBase,
  updateBase,
  deleteBase,
  listDocs,
  listFiles,
  listChunks,
  getDoc,
  async saveFile(id, name, buffer) {
    const n = safeName(name);
    if (!buffer || !buffer.length) throw new Error("文件是空的");
    fs.mkdirSync(filesDir(id), { recursive: true });
    // 异步写：知识库单文件可到 50mb，同步写会把整个事件循环按住
    await fs.promises.writeFile(path.join(filesDir(id), n), buffer);
    // 文件刚落盘、还没入库时也要在列表里看得见，所以立刻建一条文档记录（chunks 为空 = 待处理）
    const st = fs.statSync(path.join(filesDir(id), n));
    const prev = getDoc(id, n);
    putDoc(id, {
      ...(prev || {}),
      id: n,
      name: n,
      kind: "file",
      size: st.size,
      mtime: st.mtime.toISOString(),
      chunks: prev && prev.chunks ? prev.chunks : [],
      error: prev ? prev.error || "" : "",
    });
    return { name: n, id: n, size: buffer.length };
  },
  deleteDoc,
  deleteFile,
  addNote,
  addWeb,
  ingestDoc,
  indexFile,
  reindexBase,
  enqueueIndex,
  enqueueReindex,
  enqueueEmbedMissing,
  retryJob,
  statusOf,
  queueStats,
  resumeQueue,
  search,
  searchDetailed,
  buildContext,
  testEmbedding,
  testRerank,
  chunkText,
  chunkWithMeta,
  extractText,
  tuningFor,
};
