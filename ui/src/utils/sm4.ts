import { sm4 } from 'sm-crypto'

/**
 * 登录口令加密（与平台网关的解密实现严格对称）。
 * <p>
 * 网关侧逆流程：Base64 解码 → hex 字符串 → SM4 解密 → 明文。
 * 因此前端流程为：明文 → SM4 加密 → hex 字符串 → UTF-8 编码 → Base64。
 * <p>
 * 算法参数必须与网关侧一致：SM4/ECB/PKCS5Padding，密钥是与网关约定好的固定值
 * （下面这个值是网关侧的默认约定；换过密钥的部署要同步改这里）。
 * （SM4 块大小为 16 字节，PKCS#5 与 PKCS#7 在此等价。）
 */
const SM4_KEY = '1024lab__1024lab'

/** 字符串 → hex（sm-crypto 的 key 参数要求 hex 形式） */
function toHex(str: string): string {
  return Array.from(new TextEncoder().encode(str))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** UTF-8 字符串 → Base64（不能用 btoa 直接处理，需先按 UTF-8 编码） */
function toBase64(str: string): string {
  const bytes = new TextEncoder().encode(str)
  let binary = ''
  for (const b of bytes) {
    binary += String.fromCharCode(b)
  }
  return btoa(binary)
}

/** 加密登录密码 */
export function encryptPassword(plain: string): string {
  const keyHex = toHex(SM4_KEY)
  const hex = sm4.encrypt(plain, keyHex, { mode: 'ecb', output: 'string' }) as string
  return toBase64(hex)
}
