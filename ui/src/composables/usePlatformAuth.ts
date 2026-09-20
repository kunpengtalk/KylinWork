import { computed, ref } from 'vue'
import { getInfo } from '@/api/client'
import { syncPlatformSession } from '@/api/client'
import { exchangeCode } from '@/api/platform'

/**
 * 平台登录态（弹浏览器登录 → 回调带回令牌）。
 * <p>
 * 与本地会话（wb_token）是两回事：
 * - 平台令牌：从 kylinwork://auth 回调拿回，用来访问平台的应用/模型/密钥/用量
 * - 本地会话：服务端用平台令牌回平台验一次后签发，用来访问本机的成果文件/定时任务/记忆
 *
 * 客户端在没有平台令牌时**照常可用**——本地引擎不需要登录，
 * 配好模型就能跑任务。登录只是把平台那部分能力接进来。
 */
const TOKEN_KEY = 'kylinwork.platformToken'
const USER_KEY = 'kylinwork.platformUser'

/** 登录回调的协议地址，后端登录成功后要跳到这儿 */
export const AUTH_CALLBACK = 'kylinwork://auth'

const token = ref(localStorage.getItem(TOKEN_KEY) || '')
const userName = ref(localStorage.getItem(USER_KEY) || '')
const loggingIn = ref(false)

/** 平台登录页地址（按当前环境走 UAT 还是生产） */
async function loginUrl(): Promise<string> {
  let base = ''
  try {
    const info = await getInfo()
    base = String(info.platform || '')
  } catch {
    /* 拿不到就用下面兜底 */
  }
  if (!base) base = ''
  // 平台是 hash 路由，所以路径写作 /#/login
  return `${base}/#/login?callback=${encodeURIComponent(AUTH_CALLBACK)}`
}

export function usePlatformAuth() {
  /** 点登录：弹系统浏览器，登录完由后端跳 kylinwork://auth 把 App 唤起 */
  async function login() {
    loggingIn.value = true
    try {
      const url = await loginUrl()
      window.open(url, '_blank', 'noopener')
    } finally {
      // 立刻置回：真正的登录完成由回调事件驱动，这里只是把浏览器打开了
      setTimeout(() => (loggingIn.value = false), 1500)
    }
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
    token.value = ''
    userName.value = ''
    window.dispatchEvent(new CustomEvent('kylinwork:platform-changed'))
  }

  /**
   * 是否已登录（有平台令牌）。consumer 侧（侧边栏 / 聊天输入卡）用布尔态
   * 决定「平台模型」模型组、账号条显示与登录引导，不要自己去读 token 判空。
   */
  const loggedIn = computed(() => Boolean(token.value))
  /** 平台账号显示名（回调带回的 actualName/loginName）；未登录为空串 */
  const platformName = computed(() => userName.value || '')

  return { token, userName, loggingIn, loggedIn, platformName, login, logout }
}

/**
 * 装回调监听：Electron 主进程收到 kylinwork://auth 后往页面里派发事件，
 * 这里接住并落库，同时用平台令牌换一个本地会话。
 */
export function installAuthCallback(): () => void {
  const onChange = () => {
    token.value = localStorage.getItem(TOKEN_KEY) || ''
    userName.value = localStorage.getItem(USER_KEY) || ''
  }

  /**
   * 收到 kylinwork://auth 回调。
   * 优先走安全方案：payload.code → /auth-api/oauth/exchange 换正式令牌（用后即焚）。
   * 后端 code 签发失败时的兜底：payload.token 已随回调带回，直接用。
   * 拿到令牌后：落 localStorage（供 /client-api 鉴权）→ 换本地会话（供 /engine-api 鉴权）。
   */
  const onAuthed = async (e: Event) => {
    const d = ((e as CustomEvent).detail || {}) as {
      code?: string
      token?: string
      loginName?: string
      actualName?: string
      employeeId?: number | string
    }

    let platToken = String(d.token || '')
    let platUser = String(d.actualName || d.loginName || '')

    try {
      if (!platToken && d.code) {
        const res = await exchangeCode(d.code) // 匿名接口，不需要平台令牌
        platToken = res?.token || ''
        platUser = res?.actualName || res?.loginName || ''
      }

      if (platToken) {
        localStorage.setItem(TOKEN_KEY, platToken)
        if (platUser) localStorage.setItem(USER_KEY, platUser)
        token.value = platToken
        userName.value = platUser
        // 换本地会话：不换的话成果文件 / 定时任务这些客户端页面会 401
        try {
          await syncPlatformSession(platToken)
        } catch {
          // 换不到不拦人，平台那部分功能照样能用
        }
      }
    } catch (err) {
      console.warn('[登录] 回调处理失败:', err)
    }
    window.dispatchEvent(new CustomEvent('kylinwork:platform-changed'))
  }

  window.addEventListener('kylinwork:authed', onAuthed as EventListener)
  window.addEventListener('kylinwork:platform-changed', onChange)
  window.addEventListener('storage', onChange) // 多窗口之间同步

  return () => {
    window.removeEventListener('kylinwork:authed', onAuthed as EventListener)
    window.removeEventListener('kylinwork:platform-changed', onChange)
    window.removeEventListener('storage', onChange)
  }
}

export function isPlatformLoggedIn() {
  return Boolean(token.value)
}
