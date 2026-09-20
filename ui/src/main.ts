import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import './styles/main.css'
// sonner 弹窗的样式表：少了它，toaster 就是 position:static 的普通 <ol>，
// 会跟着文档流落到窗口左下角（未样式化），还会把页面撑高、逼出第二条窗口滚动条。
import 'vue-sonner/style.css'

const app = createApp(App)

app.use(createPinia())
app.use(router)
app.mount('#app')
