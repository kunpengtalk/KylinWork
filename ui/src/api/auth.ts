import { httpAuth, unwrap } from './request'
import { encryptPassword } from '@/utils/sm4'

/** 验证码 */
export interface Captcha {
  captchaUuid: string
  captchaBase64Image: string
  expireSeconds: number
}

/**
 * 登录结果（与后端 auth-service 的 LoginResultVO 字段对齐）。
 * <p>
 * 注意：LoginResultVO 没有 email 字段，电话只有 phone。
 */
export interface LoginResult {
  token: string
  employeeId: number
  loginName: string
  actualName: string
  avatar: string | null
  phone: string | null
  departmentId: number | null
  departmentName: string | null
  needUpdatePwdFlag: boolean | null
  administratorFlag: boolean
  roleIds: number[] | null
  roleCodes: string[] | null
  lastLoginIp: string | null
  lastLoginIpRegion: string | null
  lastLoginUserAgent: string | null
  lastLoginTime: string | null
}

/**
 * 获取图形验证码。
 * 注意：登录接口在网关白名单内，无需 token。
 */
export function getCaptcha() {
  return unwrap<Captcha>(httpAuth.get('/auth-api/login/getCaptcha'))
}

/** 登录（密码经 SM4 加密后传输） */
export function login(params: {
  loginName: string
  password: string
  captchaCode: string
  captchaUuid: string
}) {
  return unwrap<LoginResult>(httpAuth.post('/auth-api/login', {
    loginName: params.loginName,
    password: encryptPassword(params.password),
    captchaCode: params.captchaCode,
    captchaUuid: params.captchaUuid,
    loginDevice: 'PC',
  }))
}

/** 退出登录 */
export function logout() {
  return unwrap<null>(httpAuth.get('/auth-api/login/logout'))
}

/** 修改密码（密码与登录一致：SM4 加密后传输） */
export function updatePassword(params: { oldPassword: string; newPassword: string }) {
  return unwrap<null>(httpAuth.post('/auth-api/login/updatePassword', {
    oldPassword: encryptPassword(params.oldPassword),
    newPassword: encryptPassword(params.newPassword),
  }))
}

/** 获取当前登录信息（用于刷新后恢复会话）。
 * silent=true：401 不强制跳登录，让用户看到错误即可——个人信息页失败不该让用户被踢出 */
export function getLoginInfo() {
  return unwrap<LoginResult>(httpAuth.get('/auth-api/login/getLoginInfo'), { silent: true })
}
