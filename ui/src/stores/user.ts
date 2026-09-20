import { defineStore } from 'pinia'
import { getToken, readCookie } from '@/api/request'
import type { LoginResult } from '@/api/auth'

/**
 * 登录态。
 * <p>
 * token 存 Cookie 而非 localStorage，是为了与平台服务端保持同一套
 * 会话载体——在平台登录后，本前端可直接复用其 Cookie，不再需要二次登录。
 * <p>
 * 注意：Cookie 不设 httpOnly（前端需读写），这与平台既有做法一致；
 * 传输层安全由全站 HTTPS 保证。
 */
export const useUserStore = defineStore('user', {
  state: () => ({
    token: '' as string,
    userName: '' as string,
    employeeId: null as number | null,
    administratorFlag: false as boolean,
  }),
  getters: {
    isLogin: (state) => Boolean(state.token),
  },
  actions: {
    /** 从 Cookie 恢复登录态（刷新页面、或从后台跳转过来时） */
    loadFromCookie() {
      this.token = getToken()
      this.userName = decodeURIComponent(readCookie('user') ?? '')
    },

    /** 登录成功后写入 Cookie */
    applyLogin(result: LoginResult) {
      this.token = result.token
      this.userName = result.actualName || result.loginName
      this.employeeId = result.employeeId
      this.administratorFlag = Boolean(result.administratorFlag)
      setCookie('token', result.token)
      setCookie('user', encodeURIComponent(this.userName))
    },

    logout() {
      this.token = ''
      this.userName = ''
      this.employeeId = null
      this.administratorFlag = false
      document.cookie = 'token=; path=/; max-age=0'
      document.cookie = 'user=; path=/; max-age=0'
    },
  },
})

/** 写入 Cookie（有效期 30 天，与 Sa-Token 的 30 天超时对齐） */
function setCookie(name: string, value: string) {
  document.cookie = `${name}=${value}; path=/; max-age=2592000; SameSite=Lax`
}
