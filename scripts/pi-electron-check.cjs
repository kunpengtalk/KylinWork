// Phase 0 闸门：在 Electron 主进程里加载 pi 完整 SDK 根入口（静态引入树含原生 pi-tui）
const { app } = require("electron");
app.whenReady().then(async () => {
  const t0 = Date.now();
  try {
    const pi = await import("@earendil-works/pi-coding-agent");
    console.log("[PI-ELECTRON] LOADED OK in", Date.now() - t0, "ms; exports:", Object.keys(pi).length);
    console.log("[PI-ELECTRON] node:", process.versions.node, "| electron:", process.versions.electron, "| NODE_MODULE_VERSION:", process.versions.modules);
    console.log("[PI-ELECTRON] createAgentSession:", !!pi.createAgentSession, "| ModelRuntime:", !!pi.ModelRuntime, "| defineTool:", !!pi.defineTool);
  } catch (e) {
    console.error("[PI-ELECTRON] LOAD FAILED:", e.message);
    console.error((e.stack || "").split("\n").slice(0, 8).join("\n"));
    process.exitCode = 1;
  }
  app.quit();
});
