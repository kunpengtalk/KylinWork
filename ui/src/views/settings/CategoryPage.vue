<script setup lang="ts">
import { computed, defineAsyncComponent, type Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import GeneralPane from './GeneralPane.vue'
import AppearancePane from './AppearancePane.vue'
import NotificationsPane from './NotificationsPane.vue'
import CloudModelsPane from './CloudModelsPane.vue'
import SearchPane from './SearchPane.vue'
import SkillsPane from './SkillsPane.vue'
import McpPane from './McpPane.vue'
import ExpertsPane from './ExpertsPane.vue'
import AgentPane from './AgentPane.vue'
import KnowledgePane from './KnowledgePane.vue'
import CloudAccountPane from './CloudAccountPane.vue'
import WorkspacePane from './WorkspacePane.vue'
import DesktopPane from './DesktopPane.vue'
import DataPane from './DataPane.vue'
import ChannelsPane from './ChannelsPane.vue'

/**
 * 设置分类内容页：/client-settings/:section
 * 一个组件承接所有设置分类，按 section 动态渲染对应面板。
 * 功能页（插件/知识库…）有各自的子路由组件，不会走到这里。
 */
const SECTIONS: Record<string, { title: string; desc: string; comp: Component }> = {
  general: { title: '通用', desc: '默认模型、新会话模式以及侧边栏的组织方式。', comp: GeneralPane },
  appearance: { title: '外观', desc: '主题与界面密度，本机即时生效。', comp: AppearancePane },
  notifications: { title: '通知', desc: '任务完成、等待审批、出错时的系统通知行为。', comp: NotificationsPane },
  models: { title: '模型云服务', desc: '内置服务商挑一家填 Key 就能开工；启用且配好的会出现在对话的模型选择里。', comp: CloudModelsPane },
  search: { title: '联网搜索', desc: 'web_search 用哪家搜索服务：Jina / Tavily / Brave，留空走 DuckDuckGo。', comp: SearchPane },
  skills: { title: '技能', desc: '本地技能的安装、编辑与删除。', comp: SkillsPane },
  mcp: { title: '连接器', desc: '本地 MCP 服务管理，注入的工具即插即用。', comp: McpPane },
  experts: { title: '专家', desc: '角色设定与专属技能，可被任务委派。', comp: ExpertsPane },
  agent: { title: 'Agent', desc: '步数、超时、预算、备用渠道与助理身份。', comp: AgentPane },
  knowledge: { title: '知识库', desc: '从「模型」里已配好的向量 / 重排模型中选择，并设置切块、召回参数；库与资料在左侧「知识库」页管理。', comp: KnowledgePane },
  channels: { title: '频道', desc: '微信扫码、飞书、QQ、企业微信接入——在这些 App 里直接对话。', comp: ChannelsPane },
  account: { title: '账号与模型', desc: '登录平台后：有权限的模型、云端技能与密钥入口。', comp: CloudAccountPane },
  workspace: { title: '工作目录', desc: '成果文件的落盘位置。', comp: WorkspacePane },
  desktop: { title: '桌面与快捷键', desc: '桌面宠物与全局快捷键。', comp: DesktopPane },
  data: { title: '备份与缓存', desc: '整包备份、恢复、检查更新与清缓存。', comp: DataPane },
}

const route = useRoute()
const router = useRouter()

const section = computed(() => route.params.section as string)
const conf = computed(() => SECTIONS[section.value] || null)

// 未知分类回通用
if (!conf.value) router.replace('/client-settings/general')

const comp = computed(() => (conf.value ? defineAsyncComponent(() => Promise.resolve(conf.value!.comp)) : null))
</script>

<template>
  <div v-if="conf" class="settings-pane mx-auto w-full max-w-3xl px-10 py-8">
    <h1 class="text-[22px] font-semibold tracking-tight">{{ conf.title }}</h1>
    <p class="mt-1.5 text-[14px] leading-relaxed text-muted-foreground">{{ conf.desc }}</p>
    <div class="mt-6">
      <component :is="comp" />
    </div>
  </div>
</template>
