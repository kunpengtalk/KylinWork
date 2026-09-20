"use strict";
/**
 * 把云端平台网关的请求转发出去。
 *
 * 为什么需要这一层：前端是同源部署的（Electron 里由本地 Express 托管），
 * 直接让浏览器跨到网关端口会撞 CORS，而平台的 Cookie/凭证体系也默认同源。
 * 由本地服务代转，浏览器看到的就是同源请求，前端代码不用区分「开发态 Vite 代理 /
 * 装机态 Express 代理」——两边都是相对路径 /auth-api、/client-api。
 *
 * 走 Node 原生 fetch 而不是引 http-proxy-middleware：转发逻辑就几十行，
 * 而流式响应（SSE 是大模型对话的主链路）用 fetch 的 ReadableStream 直接泵过去最干净。
 */

const fs = require("fs");
const { dataPath } = require("./paths");

/**
 * 云端平台是**可选**能力（登录 / 模型广场 / 技能市场 / 用量）：地址因部署而异，
 * 所以仓库里不带任何内置域名，只从 config.json 的 environment.targets 读。
 * 没配就是没开——代理明确回 503，而不是悄悄连到某个陌生地址上。
 * <p>
 * 取值优先级：环境变量 KYLINWORK_ENV（临时切环境，不用改文件）
 *            → config.json 的 environment.active。
 */
function readEnvConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(dataPath("config.json"), "utf8"));
    return c.environment || {};
  } catch {
    return {}; // 配置还没生成或读不出来：当作没配平台，别让整个服务起不来
  }
}

const envCfg = readEnvConfig();
const TARGETS = { ...(envCfg.targets || {}) };

/** 当前环境名（部署方自己起的名，如 uat / prod）；空串 = 没配平台，前端据此显示「未连接」 */
const ENV_NAME = String(process.env.KYLINWORK_ENV || envCfg.active || "").trim();

/** 当前环境的网关根地址；空串 = 没配置，平台相关请求直接回 503 */
const TARGET = String(TARGETS[ENV_NAME] || "").replace(/\/+$/, "");

/** 没配平台时的统一答复：说清「这是可选项」和「去哪配」，别让用户对着一句 502 猜 */
const NOT_CONFIGURED =
  "没有配置云端平台网关：这是可选能力（登录 / 模型广场 / 技能市场）。" +
  "要启用的话，在 config.json 的 environment.targets 里填你们的网关根地址，" +
  "并把 environment.active 指到那个键上。";

/** 逐跳首部：不能透传，否则会破坏本地这次连接的语义 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

function copyRequestHeaders(req) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  out["x-forwarded-host"] = req.headers.host || "";
  out["x-forwarded-proto"] = req.protocol || "http";
  return out;
}

function copyResponseHeaders(res, upstream) {
  for (const [k, v] of upstream.headers.entries()) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    // content-encoding/content-length 由我们重新写入：fetch 已经解过压缩了，
    // 原样透传会让浏览器拿着 gzip 的声明去解一段明文，直接报错
    if (k.toLowerCase() === "content-encoding" || k.toLowerCase() === "content-length") continue;
    res.setHeader(k, v);
  }
}

/**
 * 从原始流里读出请求体。
 * <p>
 * 代理挂在 express.json() **之前**（为了 multipart 上传不被 json 解析器吃掉），
 * 因此 req.body 此刻还没被解析，是 undefined。直接拿它当 body 转发，POST 出去就是空的，
 * 平台只会回一句「请求体不可读或缺失」——这类故障从报错上完全看不出是代理丢的。
 * 所以要自己把流读成 Buffer，二进制安全，JSON 和 multipart 都能原样带过去。
 */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function forward(req, res) {
  if (!TARGET) {
    res.status(503).json({ error: NOT_CONFIGURED });
    return;
  }
  const url = TARGET + req.originalUrl;
  const hasBody = !["GET", "HEAD"].includes(req.method);
  const body = hasBody ? await readRawBody(req) : undefined;

  let upstream;
  try {
    upstream = await fetch(url, {
      method: req.method,
      headers: copyRequestHeaders(req),
      body: body && body.length ? body : undefined,
      redirect: "manual", // 302 交给浏览器自己跳（登录跳转要落到前端路由上）
      // 上传大模型附件、下载长文档都可能很慢，这里不设超时，由前端的超时兜底
    });
  } catch (e) {
    // 连不上是最常见的故障（网络不通 / 环境地址写错），给一句能直接照做的话，别只报 ECONNREFUSED
    const up = String(e && e.cause && e.cause.code ? e.cause.code : e.message);
    res.status(502).json({
      error: `连不上云端平台（${TARGET}）：${up}。确认网络可达，或改 config.json 的 environment.targets。`,
    });
    return;
  }

  copyResponseHeaders(res, upstream);
  res.status(upstream.status);

  if (!upstream.body) {
    res.end();
    return;
  }
  // SSE / 大文件：边收边转发，不落地内存
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch {
    // 客户端提前断开（用户点了停止生成），上游也就没必要继续读了
    try { await reader.cancel(); } catch {}
  }
  res.end();
}

/**
 * 挂载平台代理。只在 /auth-api、/client-api 两个前缀上生效——
 * 其余路径仍归本地 Express（Agent 引擎、文件预览、IM 回调等）。
 * 没配平台地址时这两个前缀会回 503（见 NOT_CONFIGURED），本地功能完全不受影响。
 */
function mount(app) {
  for (const prefix of ["/auth-api", "/client-api"]) {
    app.use(prefix, (req, res, next) => {
      // 注意用的是 req.originalUrl（完整原始路径），app.use 挂在子路径上也不会被剥掉前缀
      forward(req, res).catch((e) => {
        console.warn(`[平台代理] ${req.method} ${req.originalUrl} 失败:`, e.message);
        if (!res.headersSent) res.status(502).json({ error: `平台请求失败：${e.message}` });
      });
    });
  }
}

module.exports = { mount, TARGET, ENV_NAME, TARGETS, NOT_CONFIGURED };
