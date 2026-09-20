"use strict";
/** Electron 桌面壳 — 启动内嵌服务并打开桌面窗口。运行：npm run app */

const BOOT_T0 = Date.now(); // 启动分段计时：哪段慢一眼看清，别靠体感猜
const { app, BrowserWindow, Notification, shell, globalShortcut } = require("electron");
const path = require("path");
const fs = require("fs");
/** 仓库根：主进程在 app/ 下，代码资源（build/、engine/…）都在上一级 */
const APP_ROOT = path.resolve(__dirname, "..");
const { dataPath, seedDataDir } = require("../engine/paths");

// 本机系统通知的弹出端：任务完成/等待审批/任务出错由引擎（同进程）发过来，这里弹原生通知。
// 双通道兜底：Electron 原生通知为主；从终端启动等场景下 macOS 会"静默"吞掉未公证 app 的
// 通知（不报错、不弹、通知中心也没注册记录，实测踩过），所以 2.5 秒内没收到 shown 事件
// 就改走 osascript 系统脚本通道——那条路实测必通，代价是横幅署名是"脚本编辑器"。
// 点通知把窗口拽回前台（审批场景点开就能批）。
require("../engine/notify").setDesktopHandler((title, body) => {
  try {
    if (!Notification.isSupported()) return fallbackOsa(title, body);
    let shown = false;
    const n = new Notification({ title, body, silent: false });
    n.on("shown", () => { shown = true; });
    n.on("click", () => {
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });
    n.show();
    setTimeout(() => { if (!shown) fallbackOsa(title, body); }, 2500);
  } catch {
    fallbackOsa(title, body);
  }
});

/** osascript 兜底通道：Electron 通知被系统静默吞掉时用 */
function fallbackOsa(title, body) {
  try {
    const { execFile } = require("child_process");
    execFile("osascript", ["-e", `display notification ${JSON.stringify(String(body || ""))} with title ${JSON.stringify(String(title || "KylinWork"))}`], () => {});
  } catch {}
}

// 装机态：代码在只读的应用包里，配置/数据/工作区落到 ~/KylinWork。
// 首次启动（以及每次升级后）把包里自带的 experts.json 和内置技能补进去，只补缺、不覆盖用户改过的。
seedDataDir();

// Electron 的 userData 目录跟着 package.json 的 name 走。这里显式钉死在 appData/kylinwork，
// 让本地存储的登录态、会话都落在同一个目录里。（会被写的数据/配置/工作区另由 paths.js 落到 ~/KylinWork。）

const PORT = (() => {
  try {
    return require(dataPath("config.json")).server.port || 3800;
  } catch {
    return 3800;
  }
})();

// 应用名与「关于」面板：开发态跑的是 Electron 壳，菜单栏名称由壳的 Info.plist 决定
// （scripts/fix-electron-name.sh 会在 postinstall 时把壳改名），这里补齐其余展示位。
app.setName("KylinWork");
// setName 会连带推导 userData 为 appData/KylinWork（大小写变了），显式钉回原目录，
// 否则用户会「莫名被登出」——本地存储的登录态、会话全在新目录里找不到。
// 用 KYLINWORK_USER_DATA 可以指定独立的 userData：并行跑一个测试实例时不跟正式实例
// 抢单实例锁、也不串 localStorage（单实例锁就是按 userData 目录算的）。
app.setPath("userData", process.env.KYLINWORK_USER_DATA || path.join(app.getPath("appData"), "kylinwork"));
if (process.platform === "darwin") {
  app.setAboutPanelOptions({
    applicationName: "KylinWork",
    applicationVersion: "1.0.0",
    copyright: "© 2026 KylinWork",
  });
}

// ==================== 单实例锁 ====================
// 双击图标第二次只是把已开的窗口拉到前台，不再起第二个实例。
// 不加锁的话，第二个实例会和第一个抢 3800 端口：抢输了要么闪退，
// 要么亮出一个从未 loadURL 的空白窗口——看起来就是「Electron 空壳子」。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

let win;

// ==================== 登录回调（kylinwork:// 自定义协议） ====================
/**
 * 登录不在客户端里做——点「登录」弹系统浏览器到平台登录页，
 * 平台登录成功后跳 kylinwork://auth?token=…，系统把我们的 App 唤起，令牌从这条 URL 带回来。
 *
 * 这么做的原因：平台的登录带图形验证码、企微扫码、可能还有 SSO，
 * 把这套流程做进客户端既做不全又要跟着后端改；而弹浏览器是业界通行做法
 * （VS Code、Cursor、Notion 桌面版都是这个流程）。
 *
 * 协议名改成别的只需动这一处常量 + 后端跳转地址里的 scheme。
 */
const AUTH_SCHEME = "kylinwork";

if (!app.isDefaultProtocolClient(AUTH_SCHEME)) {
  app.setAsDefaultProtocolClient(AUTH_SCHEME);
}

/**
 * 冷启动时（App 完全没在跑，用户点的是浏览器里的回调链接），
 * open-url 可能在窗口建好之前就到了，那时 win 还是 undefined，投递会丢。
 * 先存这儿，等页面加载完再补投。
 */
let pendingAuthUrl = authUrlFromArgv(process.argv) || "";

/**
 * 把回调 URL 里的登录信息交给页面。
 * 用 localStorage + CustomEvent 而不是 cookie：cookie 是 HttpOnly 的（服务端下发），
 * 这边是浏览器跳回来的，前端必须能自己读到，localStorage 最直接。
 */
function deliverAuth(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return;
  }
  if (u.host !== "auth") return;

  // 平台现在走「一次性 code」方案（推荐）：登录成功后只带一个 5 分钟有效、用后即焚的 code，
  // 客户端拿 code 到 /auth-api/oauth/exchange 换正式令牌——令牌不出现在浏览器地址栏。
  // 兜底情况（后端签发 code 失败）会直接带 token/loginName/actualName/employeeId 回来。
  // 因此这里两种都可能出现：有 code 或有 token 都算一次有效回调。
  const payload = {
    code: u.searchParams.get("code") || "",
    token: u.searchParams.get("token") || "",
    loginName: u.searchParams.get("loginName") || "",
    actualName: u.searchParams.get("actualName") || "",
    employeeId: u.searchParams.get("employeeId") || "",
  };
  if (!payload.code && !payload.token) return;
  if (!win) {
    // 窗口还没建好（冷启动），先存着，页面加载完再补投
    pendingAuthUrl = url;
    return;
  }

  const send = () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    // 令牌要不要落 localStorage 由前端决定：code 方案要先交换、校验，不该先落一个占位值。
    // 主进程只负责把回调原样交给页面。
    win.webContents
      .executeJavaScript(
        `(function(){try{window.dispatchEvent(new CustomEvent('kylinwork:authed',{detail:${JSON.stringify(payload)}}));}catch(e){}})();`
      )
      .catch(() => {});
  };

  // 冷启动时页面可能还没加载完，等它就绪再投递，不然事件发出去没人接
  if (win && win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", () => setTimeout(send, 300));
  } else {
    send();
  }
}

/** 从命令行参数里找回调 URL（Windows / Linux 走这条路唤起） */
function authUrlFromArgv(argv) {
  return (argv || []).find((a) => typeof a === "string" && a.startsWith(`${AUTH_SCHEME}://`));
}

// 单实例：双击启动器/重复 npm run app 时，把已开的窗口拉到前台，而不是再叠一个实例
// （第二个实例的服务端会撞端口走"连接已运行实例"分支，结果就是两个窗口两份 Dock 图标）
if (!app.requestSingleInstanceLock()) {
  app.exit(0); // 立即退出：app.quit() 是异步的，慢一步的话 whenReady 还会抢跑建出第二个窗口
} else {
  app.on("second-instance", (_event, argv) => {
    // Windows / Linux 上协议回调是「再启动一个实例 + 把 URL 塞进 argv」，
    // 所以在这里拦一道：带 auth URL 的不当作「第二个窗口」处理
    const url = authUrlFromArgv(argv);
    if (url) {
      deliverAuth(url);
      return;
    }
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  // macOS：系统直接通过 open-url 把协议 URL 递给已运行的实例
  app.on("open-url", (event, url) => {
    event.preventDefault();
    deliverAuth(url);
  });
}

async function waitForServer(url, tries = 200) {
  for (let i = 0; i < tries; i++) {
    try {
      // 只看服务端有没有应答，不看状态码：/api/* 挂在登录守卫后面，没登录时回 401，
      // 那也是「服务端活着」。以前只认 r.ok，导致每次启动都空等满 30 秒超时才加载页面
      await fetch(url);
      return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 150)); // 服务端 1 秒内就绪，粗轮询白等半秒
  }
  return false;
}

app.whenReady().then(async () => {
  console.log(`[启动] Electron 就绪 +${Date.now() - BOOT_T0}ms`);
  // 开发态（未打包）时 Dock 显示品牌 logo；打包后系统自动读 Info.plist 里的图标，不需要这步
  if (process.platform === "darwin" && app.dock && !app.isPackaged) {
    try {
      app.dock.setIcon(path.join(APP_ROOT, "build", "icon.png"));
    } catch {}
  }
  // 窗口先开（秒响应），服务端在同进程内随后启动，就绪即加载页面。
  // 顺序反过来的话，用户要盯着 Dock 图标空等服务端把路由全注册完。
  win = new BrowserWindow({
    width: 1520,
    height: 900,
    minWidth: 680,
    minHeight: 480,
    title: "KylinWork",
    autoHideMenuBar: true,
    backgroundColor: "#ffffff",
    show: false, // 页面渲染好了再亮相（ready-to-show），不给用户看白屏；下面有兜底定时防止永不出现
    webPreferences: {
      backgroundThrottling: false, // 窗口隐藏（快捷键收起）时任务还在流式回报，计时器不许被降频
    },
  });

  // 在 Electron 主进程内直接启动服务端。
  // 初始化失败（如端口被占）绝不能卡住窗口：继续走 loadURL——
  // 大概率已有实例的服务在跑，直接连上它即可。
  try {
    require(path.join(APP_ROOT, "engine", "index.js"));
  } catch (e) {
    console.error("[启动] 服务端初始化失败（将继续尝试加载页面）:", e.message);
  }

  // 首绘打磨：正常流程 ready-to-show 在 ~0.7s 内到，一次干净的整页亮相；
  // 服务端起不来时它可能永远不触发，3 秒兜底强制亮窗，让用户看到报错而不是什么都没有
  const showOnce = () => { if (win && !win.isVisible()) { win.show(); } };
  win.once("ready-to-show", () => { console.log(`[启动] 窗口亮相 +${Date.now() - BOOT_T0}ms`); showOnce(); });
  setTimeout(showOnce, 3000);

  await waitForServer(`http://localhost:${PORT}/api/info`);
  console.log(`[启动] 服务端就绪 +${Date.now() - BOOT_T0}ms`);
  win.webContents.once("did-finish-load", () => console.log(`[启动] 页面加载完成 +${Date.now() - BOOT_T0}ms`));
  win.loadURL(`http://localhost:${PORT}`);

  // 服务端起慢了/端口切换时页面会加载失败，这里兜底重试，不给用户看死白屏
  win.webContents.on("did-fail-load", (_e, code, desc, url, isMain) => {
    if (!isMain) return;
    console.warn(`[启动] 页面加载失败(${code} ${desc})，3 秒后重试`);
    setTimeout(() => {
      win.loadURL(`http://localhost:${PORT}`).catch(() => {});
    }, 3000);
  });

  // 冷启动被 kylinwork:// 唤起时，令牌在页面加载完成前就到了，这里补投一次
  if (pendingAuthUrl) {
    const u = pendingAuthUrl;
    pendingAuthUrl = "";
    win.webContents.once("did-finish-load", () => setTimeout(() => deliverAuth(u), 600));
  }

  // 外链用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // 供 engine/index.js（同进程内运行）访问窗口：全屏切换 / 快捷键热更新
  global.__wbWin = win;
  global.__wbRegisterShortcuts = registerShortcuts;

  // 桌面宠物：常驻角落显示 agent 在干什么，agent 要提问时跳给你看。
  // 放在窗口之后创建，这样它一出生 global.__wbWin 就是齐的（点它要唤起主窗口）。
  const pet = require(path.join(APP_ROOT, "engine", "pet"));
  global.__wbPet = pet;
  try {
    const petCfg = require(dataPath("config.json")).pet || {};
    pet.applyConfig({ enabled: petCfg.enabled === true, scale: petCfg.scale || 1, opacity: petCfg.opacity || 1, notify: petCfg.notify !== false, character: petCfg.character || "cat" });
  } catch {
    pet.applyConfig({ enabled: false }); // 读不到配置就当没配过：默认不该有宠物
  }
  try {
    const shortcuts = require(dataPath("config.json")).shortcuts || {};
    registerShortcuts(shortcuts);
  } catch {
    registerShortcuts({});
  }
});

/** 全局快捷键（系统级，仅「唤起/隐藏主窗口」需要）；设置页改绑后由 engine/index.js 调用热更新 */
function registerShortcuts(shortcuts) {
  try {
    globalShortcut.unregisterAll();
    const accel = String((shortcuts || {})["toggle-window"] || "Shift+Alt+W")
      .replace(/\bMeta\b/g, "Command")
      .replace(/\bCtrl\b/g, "Control");
    globalShortcut.register(accel, () => {
      if (!win) return;
      if (win.isVisible() && win.isFocused()) win.hide();
      else {
        win.show();
        win.focus();
      }
    });
  } catch (e) {
    console.warn("[快捷键] 全局快捷键注册失败:", e.message);
  }
}

app.on("will-quit", () => {
  try {
    globalShortcut.unregisterAll();
  } catch {}
  try {
    if (global.__wbPet) global.__wbPet.destroy();
  } catch {}
});

// 主窗口关掉就退出。宠物是个挂件不是窗口，不能让它把进程吊在那儿——
// 所以这里盯的是主窗口的 closed，而不是 window-all-closed（宠物还开着时它永远不触发）。
app.on("window-all-closed", () => app.quit());
