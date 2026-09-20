import { httpEngine } from './request'

/**
 * 本地引擎（KylinWork）接口层。
 * <p>
 * 这一层是 KylinWork 作为**桌面客户端**独有的能力：
 * 本地文件系统、工作目录、定时任务、桌面宠物、备份恢复、安全审批、自进化……
 * 纯 Web 版没有本地运行环境，也就没有这些接口。
 *
 * 请求走 /engine-api（Vite 开发态代理 / Express 装机态托管时同源转发到 /api）。
 * 登录态是本地 cookie（wb_token），同源请求由 axios 自动携带。
 */

// ==================== 类型 ====================

/** 工作区里的一个成果文件 */
export interface OutputFile {
  name: string
  size: number
  mtime: string
  /** 根目录里跟这个（子目录中的）原件逐字节相同的副本才标；原件为 undefined */
  dup_of?: string
}

/** 定时任务的重复规则（后端归一化成 cron 存，这里保留原样好回填表单） */
export interface ScheduleRepeat {
  type: 'minutes' | 'hours' | 'daily' | 'weekly' | 'monthly' | 'once'
  every?: number
  hour?: number
  minute?: number
  days?: number[]
  day?: number
  /** once 专用：ISO 时间 */
  at?: string
}

/** 定时任务 */
export interface Schedule {
  id: string
  name: string
  /** 归一化出来的 cron；once 类型为空串 */
  cron: string
  repeat?: ScheduleRepeat | null
  task: string
  /** 到点在哪个工作空间里跑；空 = 跟随当前工作空间 */
  workspace_dir?: string
  enabled: boolean
  /** 关机期间错过的那次要不要补跑 */
  catch_up?: boolean
  last_run_at?: string | null
  next_run_at?: string | null
  last_result?: string | null
  running?: boolean
  [key: string]: unknown
}

/** 待审批的危险动作 */
export interface Approval {
  id: string
  kind: string
  source?: string
  text?: string
  detail?: string
  createdAt?: string
  [key: string]: unknown
}

/** 定时任务的一次运行记录 */
export interface ScheduleRun {
  id: string
  task_id: string
  name?: string
  trigger?: string
  /** null = 还在跑 */
  ok: boolean | null
  started_at?: string
  ended_at?: string | null
  ms?: number
  result?: string
  [key: string]: unknown
}

/** 备份记录（后端字段是 at，不是 createdAt） */
export interface Backup {
  name: string
  size: number
  at?: string
  createdAt?: string
  [key: string]: unknown
}

/** 桌面宠物配置 */
export interface PetConfig {
  enabled: boolean
  scale: number
  opacity: number
  notify: boolean
  character: string
}

/** 缓存统计（后端给的是 UI 缓存 / 临时目录 / 合计三个字节数） */
export interface CacheStats {
  ui?: number
  tmp?: number
  total?: number
  [key: string]: unknown
}

/**
 * 用平台身份换取本地会话。
 * <p>
 * 登录走的是平台（Java），可本地引擎认的是自己的账本。不换这一步的话，
 * 成果文件 / 定时任务 / 记忆 / 宠物这些客户端页面会全部 401——用户明明登进来了，
 * 却一个客户端功能都用不了。服务端会拿这个平台令牌回平台再验一次才放行。
 */
export function syncPlatformSession(platformToken: string) {
  return httpEngine
    .post('/auth/sync-platform', {}, { headers: { 'x-platform-token': platformToken } })
    .then((r) => r.data)
}

// ==================== 成果文件（桌面客户端核心） ====================

/** 工作区成果文件列表（按修改时间倒序） */
export function listFiles() {
  return httpEngine.get<OutputFile[]>('/files').then((r) => r.data)
}

/** 用系统默认程序打开文件（桌面端直接调起本地应用） */
export function openFile(name: string) {
  return httpEngine.post(`/files/open/${encodeURIComponent(name)}`).then((r) => r.data)
}

/** 在访达 / 资源管理器中显示该文件——找得到产出还要找得到它在哪 */
export function revealFile(name: string) {
  return httpEngine.post('/files/reveal', { name }).then((r) => r.data)
}

/** 打包下载（浏览器原生下载） */
export function fileDownloadUrl(name: string) {
  return `/engine-api/files/download/${encodeURIComponent(name)}`
}

/** 应用内预览（文本/图片/PDF 走内核渲染） */
export function fileViewUrl(name: string) {
  return `/engine-api/files/view/${encodeURIComponent(name)}`
}

/** 网页类产物的独立预览地址 */
export function filePreviewUrl(name: string) {
  return `/engine-api/files/preview/${encodeURIComponent(name)}`
}

/** 把编辑后的内容写回工作区 */
export function saveFile(name: string, content: string) {
  return httpEngine.post('/files/save', { name, content }).then((r) => r.data)
}

/** 清理工作区里的空目录与残留 */
export function tidyFiles() {
  return httpEngine.post('/files/tidy').then((r) => r.data)
}

/** 服务信息：模型、技能数量，以及当前对接的平台环境 */
export interface EngineInfo {
  provider?: string
  model?: string
  environment?: string
  platform?: string
  skills?: string[]
  experts?: string[]
  mcp_tools?: number
}

/** 读取引擎信息（含当前平台环境 uat/prod） */
export function getInfo() {
  return httpEngine.get<EngineInfo>('/info').then((r) => r.data)
}

// ==================== 工作区 / 桌面集成 ====================

/** 在访达 / 资源管理器中打开工作目录 */
export function openWorkspace() {
  return httpEngine.post('/open-workspace').then((r) => r.data)
}

/** 弹出系统文件夹选择框，换一个工作目录 */
export function pickFolder() {
  return httpEngine.post<{ dir?: string; path?: string; canceled?: boolean }>('/pick-folder').then((r) => r.data)
}

/** 清空工作区 */
export function resetWorkspace() {
  return httpEngine.post('/workspace/reset').then((r) => r.data)
}

/** 切换全屏 */
export function toggleFullscreen() {
  return httpEngine.post('/app/fullscreen').then((r) => r.data)
}

/** 检查客户端更新 */
export function checkUpdate() {
  return httpEngine.post('/app/update-check').then((r) => r.data)
}

// ==================== 设置 ====================

/** 读取完整设置（工作目录、模型、IM、宠物、快捷键…） */
export function getSettings() {
  return httpEngine.get<Record<string, unknown>>('/settings').then((r) => r.data)
}

/** 局部保存设置并热生效 */
export function saveSettings(patch: Record<string, unknown>) {
  return httpEngine.post('/settings', patch).then((r) => r.data)
}

// ==================== 联网搜索 ====================

/** 测试搜索 provider：真发一次查询，返回结果样例或错误。
 *  带 provider/key 时直接测这对「还没保存」的输入，不带就测已保存的配置。 */
export function testSearch(opts?: { provider?: string; key?: string }) {
  const params: Record<string, string> = {}
  if (opts?.provider) params.provider = opts.provider
  if (opts?.key) params.key = opts.key
  return httpEngine
    .get<{ ok?: boolean; provider?: string; sample?: string; error?: string }>('/search/test', { params })
    .then((r) => r.data)
}

// ==================== 定时任务 ====================

export function listSchedules() {
  return httpEngine.get<Schedule[]>('/schedules').then((r) => r.data)
}

export function createSchedule(data: Partial<Schedule>) {
  return httpEngine.post('/schedules', data).then((r) => r.data)
}

export function updateSchedule(id: string, data: Partial<Schedule>) {
  // 引擎侧是 PATCH（局部改），之前这里写 PUT 直接 404，改个时间点就静默失败
  return httpEngine.patch(`/schedules/${id}`, data).then((r) => r.data)
}

export function deleteSchedule(id: string) {
  return httpEngine.delete(`/schedules/${id}`).then((r) => r.data)
}

/** 启用 / 停用。之前不带参数，后端永远收到 undefined 当「停用」，点了只会关不会开 */
export function toggleSchedule(id: string, enabled: boolean) {
  return httpEngine.post(`/schedules/${id}/toggle`, { enabled }).then((r) => r.data)
}

/** 关机期间错过的那次要不要补跑 */
export function setScheduleCatchUp(id: string, catchUp: boolean) {
  return httpEngine.post(`/schedules/${id}/catchup`, { catch_up: catchUp }).then((r) => r.data)
}

/** 立刻跑一次（不等时间到） */
export function runSchedule(id: string) {
  return httpEngine.post(`/schedules/${id}/run`).then((r) => r.data)
}

export function listScheduleRuns() {
  return httpEngine.get<ScheduleRun[]>('/schedules/runs').then((r) => r.data)
}

// ==================== 安全审批（本地权限闸门） ====================

export function listApprovals() {
  return httpEngine
    .get<{ items?: Approval[]; mode?: string; session_allow?: unknown[] }>('/security/approvals')
    .then((r) => r.data)
}

/** 批准或拒绝一条待审批动作 */
export function resolveApproval(id: string, action: 'allow' | 'deny' | string) {
  return httpEngine.post(`/security/approvals/${id}`, { action }).then((r) => r.data)
}

export function listSecurityModes() {
  return httpEngine.get<unknown>('/security/modes').then((r) => r.data)
}

export function setSecurityMode(mode: string) {
  return httpEngine.post('/security/mode', { mode }).then((r) => r.data)
}

export function listAudit(limit = 100) {
  return httpEngine.get<unknown[]>(`/security/audit?limit=${limit}`).then((r) => r.data)
}

// ==================== 桌面宠物 ====================

/** 上传宠物形象 */
export function uploadPetAvatar(file: File) {
  // 直接发图片字节。以前套 FormData 变成 multipart，后端根本解析不到，一律 400
  return httpEngine
    .post('/pet/avatar', file, { headers: { 'Content-Type': file.type || 'application/octet-stream' } })
    .then((r) => r.data)
}

export function deletePetAvatar() {
  return httpEngine.delete('/pet/avatar').then((r) => r.data)
}

// ==================== 备份与恢复 ====================

export function listBackups() {
  return httpEngine
    .get<{ list?: Backup[]; covers?: string[] }>('/backup')
    .then((r) => r.data)
}

export function createBackup() {
  return httpEngine.post('/backup').then((r) => r.data)
}

export function restoreBackup(name: string) {
  return httpEngine.post('/backup/restore', { name }).then((r) => r.data)
}

export function deleteBackup(name: string) {
  return httpEngine.delete(`/backup/${name}`).then((r) => r.data)
}

export function backupDownloadUrl(name: string) {
  return `/engine-api/backup/download/${encodeURIComponent(name)}`
}

/** 恢复完重启客户端 */
export function restartApp() {
  return httpEngine.post('/backup/restart').then((r) => r.data)
}

// ==================== 本地预览（起本机服务，手机/内嵌 iframe 实时预览） ====================

export interface PreviewState {
  running?: boolean
  url?: string
  lan_url?: string
  dir?: string
  [k: string]: unknown
}

/** 起本机静态服务（lan=true 才对局域网开放，手机可扫） */
export function startPreview(opts: { lan?: boolean; open?: string } = {}) {
  return httpEngine.post<PreviewState>('/preview/start', opts).then((r) => r.data)
}

export function previewStatus() {
  return httpEngine.get<PreviewState>('/preview/status').then((r) => r.data)
}

export function stopPreview() {
  return httpEngine.post('/preview/stop').then((r) => r.data)
}

// ==================== 插件：安装 / 更新 / 卸载 ====================

/** 粘 GitHub 地址安装（Agent Plugins 1.0.0 包：技能 + MCP 一起带进来） */
export function installPlugin(url: string) {
  return httpEngine.post('/plugins/install', { url }).then((r) => r.data)
}

export function updatePlugin(name: string) {
  return httpEngine.post(`/plugins/${name}/update`).then((r) => r.data)
}

export function removePlugin(name: string) {
  return httpEngine.delete(`/plugins/${name}`).then((r) => r.data)
}

// ==================== 缓存 ====================

export function getCacheStats() {
  return httpEngine.get<CacheStats>('/cache').then((r) => r.data)
}

export function clearCache() {
  return httpEngine.post('/cache/clear').then((r) => r.data)
}

// ==================== 引擎能力：技能 / MCP / 专家 / 记忆 / 资料库 / 插件 ====================

/** 本地技能（skills/ 目录 + 用户自建） */
export function listLocalSkills() {
  return httpEngine.get<unknown[]>('/skills').then((r) => r.data)
}

export function saveLocalSkill(data: unknown) {
  return httpEngine.post('/skills', data).then((r) => r.data)
}

/** MCP 连接器（本地 MCP 服务与其工具） */
export function listMcp() {
  return httpEngine.get<unknown>('/mcp').then((r) => r.data)
}

export function saveMcp(data: unknown) {
  return httpEngine.post('/mcp', data).then((r) => r.data)
}

/** 专家与专家团（本地引擎的委派目标） */
export function listLocalExperts() {
  return httpEngine.get<unknown[]>('/experts').then((r) => r.data)
}

export function saveLocalExpert(data: unknown) {
  return httpEngine.post('/experts', data).then((r) => r.data)
}

/** 一条长期记忆 */
export interface MemoryItem {
  id: string
  text: string
  scope?: string
  source?: string
  created_at?: string
  [key: string]: unknown
}

/** 记忆页返回：manual 是用户手写的那一段，items 是逐条记忆 */
export interface MemoryData {
  content: string
  items: MemoryItem[]
  shared_tag?: string
  limits?: { max_text?: number; max_items?: number }
}

/** 长期记忆 */
export function listMemory() {
  return httpEngine.get<MemoryData>('/memory').then((r) => r.data)
}

/** 新增一条记忆 */
export function addMemory(text: string, shared = false) {
  return httpEngine.post('/memory/item', { text, shared }).then((r) => r.data)
}

export function removeMemory(id: string) {
  return httpEngine.delete(`/memory/item/${id}`).then((r) => r.data)
}

/** 保存用户手写的那段记忆正文 */
export function saveMemoryManual(content: string) {
  return httpEngine.post('/memory', { content }).then((r) => r.data)
}

/** 资料库里的一个文件 */
export interface LibraryFile {
  name: string
  size: number
  mtime: string
}

export interface LibraryNote {
  id?: string | number
  text?: string
  content?: string
  created_at?: string
  [key: string]: unknown
}

/** 资料库（跨项目共享的参考资料与灵感笔记） */
export function listLibrary() {
  return httpEngine.get<{ files: LibraryFile[]; notes: LibraryNote[] }>('/library').then((r) => r.data)
}

export function addLibraryNote(text: string) {
  return httpEngine.post('/library/note', { text }).then((r) => r.data)
}

export function deleteLibraryNote(id: string | number) {
  return httpEngine.delete(`/library/note/${id}`).then((r) => r.data)
}

export function uploadLibraryFile(file: File) {
  // 同上：字节流 + 文件名走 header（中文名要编码，后端会解码）
  return httpEngine
    .post('/library/upload', file, {
      headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
    })
    .then((r) => r.data)
}

export function deleteLibraryFile(name: string) {
  return httpEngine.delete(`/library/file/${encodeURIComponent(name)}`).then((r) => r.data)
}

// ==================== 知识库（多库 RAG） ====================
// 与「资料库」区分：资料库是跨项目共享的参考文件夹；知识库是按库组织、
// 可在对话里选中做检索问答的资料集。embedding / rerank 在设置→知识库里配。

/** 一个知识库 */
export interface KnowledgeBase {
  id: string
  name: string
  description?: string
  created_at?: string
  updated_at?: string
  file_count?: number
  chunk_count?: number
  indexed_files?: number
  /** 向量是换模型之前算的文件数（>0 说明该重建索引了） */
  stale_files?: number
}

/** 知识库里的一个文件（status 是后台入库队列的状态；stale 说明向量是别的模型算的，要重建） */
export interface KnowledgeFile {
  name: string
  size: number
  mtime: string
  chunks: number
  indexed: boolean
  vectorized?: boolean
  stale?: boolean
  error?: string
  status?: '' | 'queued' | 'running' | 'ready' | 'error'
}

export interface KnowledgeQueue {
  queued: number
  running: number
  ready: number
  failed: number
}

export interface KnowledgeList {
  bases: KnowledgeBase[]
  /** model 是实际在用的那条；source=selected 表示它是「设置 → 知识库」里选的，shared 表示和长期记忆共用 */
  embedding: { configured: boolean; model?: string | null; source?: 'selected' | 'shared' | 'none'; channel?: string }
  rerank: { configured: boolean }
  selected?: { embedding: string; rerank: string }
  queue?: KnowledgeQueue
}

/** 知识库列表 + 检索能力状态（有没有可用的 embedding / rerank） */
export function listKnowledgeBases() {
  return httpEngine.get<KnowledgeList>('/knowledge/bases').then((r) => r.data)
}

/** 入库队列状态（上传后界面靠轮询它知道建完了没有） */
export function knowledgeQueue() {
  return httpEngine.get<KnowledgeQueue>('/knowledge/queue').then((r) => r.data)
}

export function createKnowledgeBase(data: { name: string; description?: string }) {
  return httpEngine.post<{ ok: boolean; base: KnowledgeBase }>('/knowledge/bases', data).then((r) => r.data)
}

export function updateKnowledgeBase(id: string, patch: { name?: string; description?: string }) {
  return httpEngine.post<{ ok: boolean; base: KnowledgeBase }>(`/knowledge/bases/${encodeURIComponent(id)}`, patch).then((r) => r.data)
}

export function deleteKnowledgeBase(id: string) {
  return httpEngine.delete(`/knowledge/bases/${encodeURIComponent(id)}`).then((r) => r.data)
}

export function listKnowledgeFiles(id: string) {
  return httpEngine.get<{ files: KnowledgeFile[] }>(`/knowledge/bases/${encodeURIComponent(id)}/files`).then((r) => r.data)
}

/** 上传资料：落盘后入库任务排进后台队列，立刻返回；进度看文件列表的 status */
export function uploadKnowledgeFile(id: string, file: File) {
  return httpEngine
    .post<{ ok: boolean; file: string; size: number; queued: boolean; status: string }>(
      `/knowledge/bases/${encodeURIComponent(id)}/upload`,
      file,
      { headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) } },
    )
    .then((r) => r.data)
}

export function deleteKnowledgeFile(id: string, name: string) {
  return httpEngine.delete(`/knowledge/bases/${encodeURIComponent(id)}/files/${encodeURIComponent(name)}`).then((r) => r.data)
}

/** 重新入库：不传 name 则整库排进队列（换了 embedding 模型后用） */
export function reindexKnowledge(id: string, name?: string) {
  return httpEngine.post<{ ok: boolean; queued: number; status: KnowledgeQueue }>(
    `/knowledge/bases/${encodeURIComponent(id)}/reindex`,
    name ? { name } : {},
  ).then((r) => r.data)
}

/** 入库失败三次后停下的任务，手动重试 */
export function retryKnowledgeFile(id: string, name: string) {
  return httpEngine.post<{ ok: boolean; status: KnowledgeQueue }>(
    `/knowledge/bases/${encodeURIComponent(id)}/retry`,
    { name },
  ).then((r) => r.data)
}

export interface KnowledgeHit {
  kb: string
  file: string
  heading?: string
  seq?: number
  seq_end?: number
  merged?: number
  /** both=两路都召回，vector=只有向量，keyword=只有关键词 */
  matched?: 'both' | 'vector' | 'keyword' | ''
  reranked?: boolean
  score: number
  text: string
}

/** 检索预览：验证「这样问能不能召回」。mode/model/notes 让用户看清这次走的哪条路 */
export function searchKnowledge(data: { query: string; ids: string[]; top_k?: number }) {
  return httpEngine
    .post<{ hits: KnowledgeHit[]; mode: string; model: string; notes: string[] }>('/knowledge/search', data)
    .then((r) => r.data)
}

/** 配置自检：embedding / rerank 填完先测一下再保存（值是「渠道::模型」复合键） */
export function testKnowledge(
  kind: 'embedding' | 'rerank',
  payload: { embedding?: string; rerank?: string },
) {
  return httpEngine
    .post<{ ok: boolean; dim?: number; model?: string; top?: { index: number; score: number }; error?: string }>('/knowledge/test', { kind, ...payload })
    .then((r) => r.data)
}

/** 一个已安装的 Agent Plugin（GET /plugins 返回的是 {spec, plugins:[…]}，不是数组） */
export interface PluginInfo {
  ok?: boolean
  name: string
  error?: string
  warnings?: string[]
  version?: string
  description?: string
  license?: string
  author?: string
  homepage?: string
  repository?: string
  skills?: { name: string; description?: string }[]
  mcp_servers?: { name: string; transport?: string }[]
  bytes?: number
  /** 有来源（装自 GitHub）才允许「更新」；本地放进去的没有来源 */
  source?: string
}

/** 插件 */
export function listPlugins() {
  return httpEngine.get<{ spec?: string; plugins?: PluginInfo[] }>('/plugins').then((r) => r.data)
}

/** 自进化的一条改进提案 */
export interface EvolveProposal {
  id: string
  text?: string
  rule?: string
  status?: string
  created_at?: string
  [key: string]: unknown
}

export interface EvolveState {
  caps?: unknown
  rules?: Array<Record<string, unknown>>
  proposals?: EvolveProposal[]
  scored?: unknown
  runs?: unknown[]
  auto?: Record<string, unknown>
}

/** 自进化：昨夜复盘挖出的改进提案 */
export function listEvolveState() {
  return httpEngine.get<EvolveState>('/evolve/state').then((r) => r.data)
}

export function listEvolveSignals() {
  return httpEngine.get<unknown>('/evolve/signals').then((r) => r.data)
}

/** 采纳 / 否决一条改进提案。注意：决定走 /evolve/proposal/:id，
 *  /evolve/review 是「重新跑一轮复盘」，不是审批入口（以前这里接错了，点采纳变成再跑一轮） */
export function decideEvolveProposal(id: string, decision: 'accept' | 'reject', reason?: string) {
  return httpEngine
    .post(`/evolve/proposal/${encodeURIComponent(id)}`, { decision, reason: reason || '' })
    .then((r) => r.data)
}

/** 立即跑一轮复盘（不等夜间定时任务） */
export function runEvolveReview(days?: number) {
  return httpEngine
    .post<{ ok: boolean; turns?: number; signals?: unknown[]; added?: unknown[]; gated?: unknown[]; notes?: string[] }>(
      '/evolve/review',
      days ? { days } : {},
    )
    .then((r) => r.data)
}

/** 下架一条已生效的规则 */
export function retireEvolveRule(id: string, why?: string) {
  return httpEngine.post(`/evolve/rule/${encodeURIComponent(id)}/retire`, { why: why || '' }).then((r) => r.data)
}

/** 回归评测 */
export function getEvalStatus() {
  return httpEngine.get<unknown>('/eval/status').then((r) => r.data)
}

export function getEvalHistory() {
  return httpEngine.get<unknown>('/eval/history').then((r) => r.data)
}

/** 启动一轮评测（后台跑，前端轮询状态） */
export function startEval() {
  return httpEngine.post('/eval/start').then((r) => r.data)
}
