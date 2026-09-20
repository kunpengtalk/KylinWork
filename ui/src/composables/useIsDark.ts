/**
 * 深色模式是否为当前状态。
 * <p>
 * 主题是「设置 → 外观」直接往 <html> 上加/去 `dark` class 实现的，没有全局状态可读。
 * markdown 渲染器（vue-stream-markdown）需要显式知道深浅色才能切代码高亮与配色，
 * 所以这里起一个模块级单例观察 documentElement 的 class，全应用共用一份，不用每个组件各建一个。
 */
import { ref } from 'vue'

const isDark = ref(false)
let installed = false

function sync() {
  isDark.value = document.documentElement.classList.contains('dark')
}
function install() {
  if (installed || typeof document === 'undefined') return
  installed = true
  sync()
  new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  // 跟随系统主题时，系统切换不会改 <html> 的 class，得自己听
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', sync)
}
install()

export function useIsDark() {
  return isDark
}
