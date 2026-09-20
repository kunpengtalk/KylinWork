// P3b：用真实 config.json 验证 KylinWork 渠道 → pi Provider 映射（一次极廉价调用）
// 运行：node scripts/pi-real-model-check.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createModelRuntime, resolveModel } = require("../engine/pi-adapter.js");
const config = require("../config.json");

const mr = await createModelRuntime(config);
const providers = mr.getRegisteredProviderIds();
console.log("已注册渠道:", providers.join(", "));

const name = config.active_model || providers[0];
const model = resolveModel(mr, config, name);
if (!model) throw new Error(`找不到模型渠道: ${name}`);
console.log("选中渠道:", name, "→ model:", model.id, "| baseUrl:", model.baseUrl);

const auth = await mr.getAuth(model);
console.log("认证状态:", JSON.stringify(auth && { source: auth.source, label: auth.label }, null, 0));

const t0 = Date.now();
const res = await mr.complete(model, {
  systemPrompt: "你是 KylinWork 测试助手，只回答两个字。",
  messages: [{ role: "user", content: "你好" }],
  // 别给 16：带思考的模型（deepseek-reasoner、qwen3 等）会把额度耗在思考上，正文一个字都吐不出来，
  // 看起来就像"渠道不通"，其实是自检脚本自己把回复掐了
}, { maxTokens: 256 });
const secs = ((Date.now() - t0) / 1000).toFixed(1);
const text = (res.content || []).map((c) => (c.type === "text" ? c.text : "")).join("").trim();
if (!text) console.log("原始返回:", JSON.stringify(res).slice(0, 500));
console.log(`真实调用 OK（${secs}s）→ 回复: "${text}"`);
console.log("usage:", JSON.stringify(res.usage && { input: res.usage.input, output: res.usage.output, cacheRead: res.usage.cacheRead }));
if (!text) throw new Error("模型没回复");
console.log("\n✅ REAL MODEL CHECK PASSED");
