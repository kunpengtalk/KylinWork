import { httpAuth } from './request'

/**
 * 企业微信扫码登录。
 * <p>
 * 扫码登录后端能力在平台服务端（组织架构-企微同步）中，经 API 网关以
 * /admin-api/wechatWork/login/** 暴露。本前端经 nginx 的 /api 前缀访问：
 *   /api/admin-api/wechatWork/login/... → nginx 剥 /api → 网关 → 平台服务端
 * <p>
 * 注意：平台服务端返回的是 ResponseDTO（成功 code=0 / ok=true），
 * 与平台 ApiResponse（code=200）不同，这里做一次兼容解包。
 */

/** 扫码登录二维码信息 */
export interface WechatQrConnect {
  qrConnectUrl: string
  state: string
}

export type WechatLoginStatus = 'waiting' | 'success' | 'fail' | 'expired'

/** 扫码登录轮询结果（成功时附带用户信息，可直接构建登录态） */
export interface WechatLoginCheck {
  status: WechatLoginStatus
  token?: string
  message?: string
  employeeId?: number
  loginName?: string
  actualName?: string
  avatar?: string | null
  phone?: string | null
  departmentId?: number | null
  administratorFlag?: boolean
}

/** 平台服务端 ResponseDTO 解包：成功 code=0 / ok=true */
async function unwrapSmartAdmin<T>(promise: Promise<{ data: any }>): Promise<T> {
  const resp = await promise
  const body = resp.data
  if (body && (body.ok === true || body.code === 0)) {
    return body.data as T
  }
  throw new Error(body?.msg || '企业微信登录请求失败')
}

export const wechatWorkLoginApi = {
  /** 扫码登录是否启用 */
  enabled: () => unwrapSmartAdmin<boolean>(httpAuth.get('/api/admin-api/wechatWork/login/enabled')),

  /** 获取二维码嵌入地址与 state */
  qrConnectUrl: () =>
    unwrapSmartAdmin<WechatQrConnect>(httpAuth.get('/api/admin-api/wechatWork/login/qrConnectUrl')),

  /** 轮询扫码登录结果 */
  check: (state: string) =>
    unwrapSmartAdmin<WechatLoginCheck>(
      httpAuth.get('/api/admin-api/wechatWork/login/check', { params: { state } }),
    ),
}
