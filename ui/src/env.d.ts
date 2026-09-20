/// <reference types="vite/client" />

/** 应用版本：构建时由 vite.config.ts 从仓库根 package.json 注入，别在界面里手写版本号 */
declare const __APP_VERSION__: string

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

/**
 * sm-crypto 未提供 TS 类型声明，这里补上实际用到的 sm4 部分。
 * 参数语义与后端 hutool 的 SmUtil.sm4(key) 对齐（SM4/ECB/PKCS5Padding）。
 */
declare module 'sm-crypto' {
  export interface Sm4Options {
    /** 分组模式，默认 ecb */
    mode?: 'ecb' | 'cbc'
    /** 填充方式，默认 pkcs#7（SM4 块 16 字节，与 pkcs#5 等价） */
    padding?: 'pkcs#5' | 'pkcs#7' | 'none'
    /** 输出格式，string 为 hex 字符串 */
    output?: 'string' | 'array'
    /** CBC 模式初始向量 */
    iv?: string | number[]
  }

  export const sm4: {
    /**
     * SM4 加密。
     * @param data 明文（字符串或字节数组）
     * @param key 密钥，字符串形式时按 hex 解析
     * @returns output='string' 时返回 hex 字符串
     */
    encrypt(data: string | number[], key: string | number[], options?: Sm4Options): string | number[]
    decrypt(data: string | number[], key: string | number[], options?: Sm4Options): string | number[]
  }
}
