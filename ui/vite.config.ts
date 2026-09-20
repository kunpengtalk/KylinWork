import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

/**
 * KylinWork 是客户端（Electron + 本地 Express），请求要分三路走：
 *
 * - /auth-api、/client-api  → 云端平台网关（可选的账号与技能市场能力：登录 / 应用 /
 *   专家 / 模型 / 用量…）。没配置网关地址时这三条代理不注册，平台相关请求会由本地
 *   Express 直接回 503，本地功能不受影响。
 * - /engine-api             → 本地 KylinWork Express 服务（Agent 引擎：工具调用、技能、
 *   MCP、专家委派、成果文件、IM 等）。
 *
 * 生产构建产物输出到 public/dist，由 Express 静态托管；此时前缀同样由 Express 反向代理，
 * 前端代码无需感知环境差异（同源相对路径）。
 */
/**
 * 平台网关地址：与 engine/proxy.js 用同一套解析规则，保证开发态和装机态连的是同一个环境。
 * 只从仓库根 config.json 的 environment 段读（targets 里写各环境的网关根地址，active 决定用哪个），
 * 可用 KYLINWORK_ENV 临时切环境，不用改文件。读不到就是空串 —— 见上面关于 503 的说明。
 */
function resolveGateway(): string {
  let targets: Record<string, string> = {}
  let active = process.env.KYLINWORK_ENV || ''
  try {
    const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../config.json'), 'utf8'))
    const e = cfg.environment || {}
    if (!process.env.KYLINWORK_ENV && e.active) active = e.active
    if (e.targets) targets = { ...e.targets }
  } catch {
    // 配置读不到就当没配平台：dev server 照常起来，只是平台那几条代理不注册
  }
  return String(targets[active] || '').replace(/\/+$/, '')
}

const GATEWAY = process.env.VITE_JAVA_GATEWAY || resolveGateway()
const ENGINE = process.env.VITE_ENGINE_TARGET || 'http://127.0.0.1:3800'

/** 平台代理只在配了网关地址时才挂；否则 dev server 一启动就报代理目标为空，比 503 更难懂 */
const gatewayProxy: Record<string, unknown> = GATEWAY
  ? {
      '/auth-api': { target: GATEWAY, changeOrigin: true },
      '/client-api': { target: GATEWAY, changeOrigin: true },
      '/v1': { target: GATEWAY, changeOrigin: true },
    }
  : {}

/** 应用版本取自仓库根 package.json——界面上那行 v0.1.0 不再手写，跟着发版走 */
const APP_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')).version
  } catch {
    return '0.0.0'
  }
})()

console.log(
  GATEWAY
    ? `[vite] 云端平台网关: ${process.env.KYLINWORK_ENV || '（按 config.json 的 environment.active）'} → ${GATEWAY}`
    : '[vite] 云端平台网关: 未配置（平台相关请求不代理；本地引擎照常，见 config.example.json 的 environment 段）'
)

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: Number(process.env.VITE_APP_PORT) || 3801,
    proxy: {
      ...gatewayProxy,
      '/engine-api': {
        target: ENGINE,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/engine-api/, '/api'),
      },
    },
  },
  build: {
    outDir: path.resolve(__dirname, '../public/dist'),
    emptyOutDir: true,
    sourcemap: false,
  },
})
