"use strict";
/**
 * 打安装包的配置。跑 npm run dist:mac / npm run dist:win。
 *
 * 四个不能改的决定，改之前先看理由：
 *
 * 1) asar: false —— 必须关。tools.js 的 run_node 会把 node_modules 软链进
 *    workspace/.tmp 好让生成的脚本 require 到依赖；asar 是个压缩包不是真目录，
 *    软链过去指向一个文件系统上不存在的路径，run_node 会直接失效。
 *    代价是应用包体积大、文件多，换的是「装完就能跑代码」这个核心能力。
 *
 * 2) 技能按「git 跟踪的目录」逐个收。skills/ 下既有自研技能，也有第三方技能——
 *    想只分发其中一部分，把不要的从 git 里移出去即可（git rm --cached + .gitignore），
 *    打包会自动跟上。这里直接问 git 要清单，而不是手写一份——手写的那份迟早跟仓库实际状态对不上。
 *
 * 3) 不签名、不公证（identity: null）。没有 Apple 开发者证书，硬签不了。
 *    后果是用户第一次打开会被 Gatekeeper 拦，README 里写了怎么放行。
 *    真要消掉这一步，得买证书 + 配 APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD 走 notarize。
 *
 * 4) 只构建、不发布（npm scripts 里带 --publish never）。package.json 里有 repository，
 *    electron-builder 会据此推断出「发布到 GitHub Release」，在 CI 里（检测到 CI 环境 +
 *    tag）就真去发，然后因为没配 GH_TOKEN 报错——包已经打好了却整步失败，报错信息也
 *    完全看不出是「发布」这一步在闹。CI 的发布交给 .github/workflows/release.yml 的
 *    release job（先收 artifact，再统一发 Release），本地跑 dist:* 也绝不该顺手往外发东西。
 */
// identity: null 拦不住签名——electron-builder 会自动去钥匙串里翻可用证书，
// 本机有一张个人的 Apple Development 证书，它就直接拿来签了。公开发的包不该带上任何人的
// 开发者身份（证书里有真实 Apple ID），而且 Development 证书在别人机器上照样过不了 Gatekeeper。
// 只有这个环境变量能真正关掉自动查找，关掉之后走 ad-hoc 签名（签名标识为 "-"），
// 这也是 Apple Silicon 上应用能启动的最低要求。放在配置文件里是为了 mac/Windows 都生效。
process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

/** 只收 git 跟踪的内置技能；拿不到 git（比如下的是源码 zip）就退回全带上 */
function skillPatterns() {
  let names = [];
  try {
    const out = execSync("git ls-files skills", { cwd: __dirname, encoding: "utf8" });
    names = [...new Set(out.split("\n").filter(Boolean).map((p) => p.split("/")[1]).filter(Boolean))];
  } catch {}
  if (!names.length) {
    console.warn("[打包] 拿不到 git 清单，skills/ 全量打包——发布前确认里面没有不该分发的第三方技能");
    return ["skills/**/*"];
  }  console.log(`[打包] 内置技能 ${names.length} 个：${names.join(", ")}`);
  return names.map((n) => `skills/${n}/**/*`);
}

/**
 * 打完包重新做一次 ad-hoc 签名。
 * 不做的话 codesign --verify 报「code has no resources but signature indicates they must be present」：
 * Electron 的二进制本身带一个 linker-signed 的 ad-hoc 签名，我们往包里塞了 app/ 之后那个签名就对不上了。
 * 本机双击可能还能开，但用户从网上下下来的包带 quarantine 标记，Gatekeeper 会直接判「已损坏」。
 * 签名标识用 "-" 就是 ad-hoc：不需要任何证书，只是让包内容自洽。
 * 它替代不了 Developer ID + 公证——用户首次打开仍要手动放行，README 里写了步骤。
 */
async function adhocSign(ctx) {
  if (ctx.electronPlatformName !== "darwin") return;
  const app = require("path").join(ctx.appOutDir, ctx.packager.appInfo.productFilename + ".app");
  execSync(`codesign --force --deep --sign - ${JSON.stringify(app)}`, { stdio: "inherit" });
  execSync(`codesign --verify --deep --strict ${JSON.stringify(app)}`, { stdio: "inherit" });
  console.log("[打包] ad-hoc 签名通过：" + app);
}

module.exports = {
  afterPack: adhocSign,
  appId: "com.johnwong.kylinwork",
  productName: "KylinWork",
  copyright: "Copyright © 2026 john Wong",
  asar: false, // 见文件头 (1)
  directories: { output: "dist", buildResources: "build" },

  // 白名单：只有列出来的才进包。用户数据（data/ workspace/ config.json backups/ .tmp/
  // plugins/ eval/runs/）一个都不能进——那是本机的账号和聊天记录，装机态它们在 ~/KylinWork
  files: [
    "app/**/*",
    "engine/**/*",
    "!engine/**/*.md",
    "public/**/*",
    "eval/run.js",
    "experts.json",
    "config.example.json",
    "package.json",
    "LICENSE",
    "README.md",
    ...skillPatterns(),

    // ---- 体积治理：pi 整棵依赖树会跟着进包，下面两类东西装完用不上 ----
    // 实测：整机 927M → 534M（node_modules 640M → 248M），裁剪后打包产物内 pi 加载、
    // 渠道注册、应用启动、真实模型跑任务全部复验通过。
    // 1) sourcemap（-130M）：只影响崩溃堆栈可读性
    "!node_modules/**/*.map",
    // 2) esbuild 平台二进制（-262M）：pi 自家 CLI 打包用的，走进程内 SDK 不碰这条路径。
    //    实测把整棵 @esbuild 从 node_modules 移走后，pi 建会话/工具调用/压缩全路径照跑。
    //    注意它被打成扁平的顶层 node_modules/@esbuild，不在 pi 的嵌套目录里，两条都留着保险。
    "!node_modules/@earendil-works/pi-coding-agent/node_modules/@esbuild/**",
    "!node_modules/@esbuild/**",
    // 没裁的两项（收益小、风险大，别为了几十兆赌上"装完即用"）：
    //   · esbuild 包本体（11M）—— 在依赖树里被引用，加排除规则会让 electron-builder 打包失败
    //   · 异平台原生模块（clipboard / pi-tui 的 win32、linux prebuilds）—— 平台段 files 规则同样会触发上面那个失败
  ],

  mac: {
    category: "public.app-category.productivity",
    icon: "build/icon.icns",
    identity: null, // 见文件头 (3)
    // 登录回调协议：平台登录页成功后跳 kylinwork://auth，系统据此把本应用唤起。
    // ⚠️ 必须写进 Info.plist——electron-main.js 里的 setAsDefaultProtocolClient 只在
    // 应用自己运行时登记，而「浏览器点链接 → 唤起 App」这一步是由系统按 Info.plist 判定的，
    // 少了这段声明，装机态点回调链接毫无反应。
    protocols: [{ name: "KylinWork 登录回调", schemes: ["kylinwork"] }],
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ],
    artifactName: "${productName}-${version}-mac-${arch}.${ext}",
    extendInfo: {
      // 这些是 macOS 的权限说明弹窗文案。截图/录屏能力和「打开所在位置」会摸到这些
      NSDesktopFolderUsageDescription: "KylinWork 需要访问桌面来读写你交给它的文件",
      NSDocumentsFolderUsageDescription: "KylinWork 需要访问文稿来读写你交给它的文件",
      NSDownloadsFolderUsageDescription: "KylinWork 需要访问下载文件夹来读写你交给它的文件",
    },
  },
  dmg: {
    title: "${productName} ${version}",
    contents: [
      { x: 140, y: 200, type: "file" },
      { x: 400, y: 200, type: "link", path: "/Applications" },
    ],
  },

  win: {
    icon: "build/icon.ico",
    target: [
      { target: "nsis", arch: ["x64"] },
      { target: "portable", arch: ["x64"] },
    ],
    artifactName: "${productName}-${version}-win-${arch}.${ext}",
  },
  nsis: {
    // ⚠️ nsis 和 portable 都是 .exe：只靠上面 win.artifactName 的话两个目标算出来
    // 同名（`KylinWork-0.1.0-win-x64.exe`），后打的直接把先打的覆盖掉，最后只剩一个。
    // 分级命名才分得开——portable 目标读的是 portable 段（不是 nsis 段）。
    artifactName: "${productName}-${version}-win-${arch}-setup.${ext}",
    // 真·一键：不问装哪、不要管理员权限（装进用户目录），装完直接启动
    oneClick: true,
    perMachine: false,
    runAfterFinish: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "KylinWork",
    // 卸载时不碰 ~/KylinWork：那里面是用户的工作区和成果文件，卸个应用不该把人家的
    // PPT 一起删了。要彻底清干净得手动删那个目录，README 里写了
    deleteAppDataOnUninstall: false,
  },
  // 免安装单文件版：和 nsis 同一个应用，只是不写注册表、不建快捷方式，
  // 拷到哪都能双击跑。名字必须和 setup 那份分开（见上面 nsis.artifactName 的说明）。
  portable: {
    artifactName: "${productName}-${version}-win-${arch}-portable.${ext}",
  },

  linux: {
    icon: "build/icon.png",
    category: "Office",
    target: ["AppImage"],
    artifactName: "${productName}-${version}-linux-${arch}.${ext}",
  },
};
