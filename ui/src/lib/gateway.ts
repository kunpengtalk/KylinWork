/**
 * 大模型网关对外地址（API Key 接入说明里展示的地址）。
 * <p>
 * 外部客户端（OpenAI SDK / Cherry Studio 等）用 OpenAI 兼容协议调用 `/v1/**`，
 * 由 ai-relay 用自建 API Key（`Authorization: Bearer sk-...`）鉴权、计费、限流。
 * 有两条可达路径，环境不同可用性不同，故都在接入说明里给出、可切换：
 * <ol>
 *   <li>经 API 网关：`{网关地址}/v1`，统一入口，生产/测试环境推荐</li>
 *   <li>直连 ai-relay：`{中继地址}/v1`，本地调试或网关未接入服务发现（Nacos 未启用）时使用</li>
 * </ol>
 *
 * 取值优先级（均可用环境变量覆盖，未配置时用下面注释里的默认值）：
 * 1. `VITE_LLM_BASE_URL`：完整基地址，配置后直接作为默认接入地址
 * 2. `VITE_GATEWAY_BASE_URL` + `/v1`；未配置则取 `window.location.origin`（同源部署）
 * 3. `VITE_RELAY_BASE_URL` + `/v1`；未配置则取本地中继默认端口 8000
 */
const trimSlash = (value: string) => value.replace(/\/+$/, '')

const fromEnv = (import.meta.env.VITE_GATEWAY_BASE_URL as string | undefined)?.trim()

/** 网关根地址（不带结尾斜杠） */
export const gatewayBaseUrl = trimSlash(fromEnv || window.location.origin)

/** 经 API 网关的接入基地址（跟随当前登录环境的域名动态生成），例如 https://xxx.example.com/v1 */
export const llmBaseUrl = trimSlash(
  (import.meta.env.VITE_LLM_BASE_URL as string | undefined)?.trim() || `${gatewayBaseUrl}/v1`,
)

/**
 * 直连 ai-relay 的接入基地址。
 * 仅当显式配置 VITE_RELAY_BASE_URL 时提供（本地调试场景）；
 * 未配置时为 null——接入说明里不再展示写死的 localhost 地址，
 * 避免用户拿到当前环境下根本连不上的地址。
 */
export const relayLlmBaseUrl: string | null = (() => {
  const value = (import.meta.env.VITE_RELAY_BASE_URL as string | undefined)?.trim()
  return value ? `${trimSlash(value)}/v1` : null
})()
