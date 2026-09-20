<div align="center">

# KylinWork

**说一句话，AI 自己规划、自己动手，把 PPT / Word / Excel / 网页交到你手上。**

跑在自己电脑上的 AI 办公工作台。任务在本机执行——模型调用、命令执行、文件读写都发生在这台机器上，
成果文件落进本地工作目录，配置、会话与密钥不出本机。

[![CI](https://github.com/kunpengtalk/KylinWork/actions/workflows/ci.yml/badge.svg)](https://github.com/kunpengtalk/KylinWork/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.19-3c873a.svg)](https://nodejs.org)

[快速开始](#快速开始) · [怎么用](#怎么用) · [配置](#配置) · [运行方式](#运行方式) · [开发](#开发)

</div>

---

## 这是什么

你在输入框里写下需求，剩下的交给它：拆解任务 → 调用本机工具 → 生成文件 → 自己检查交付物。

它和「把大模型接进聊天框」的区别不在于界面，而在于**工具是真的在这台机器上执行的**：

- 生成 `.xlsx` 用的是本机的 exceljs，`.docx` 用 docx，`.pptx` 用 pptxgenjs——不是让你复制一段 Markdown 自己去排版；
- 跑命令、跑 Node/Python 脚本、读写与精确编辑文件，都在你的工作目录里发生；
- 需要图就给图：echarts / Graphviz / Mermaid / PlantUML 渲染成 SVG/PNG，HTML 排版直接截图；
- 需要网页就交付网页：写单文件 HTML，起本地预览，还会自己验收（外链、断链、标签闭合、控制台报错）。

交付物是**文件**，不是一段对话记录。

---

## 能力一览

| 领域 | 具体能力 |
| --- | --- |
| **执行** | 本机命令、Node/Python 脚本、文件读写、精确替换编辑、全文搜索、目录浏览 |
| **联网** | 网页搜索、抓取正文、无头浏览器渲染并截图、网页验收（断链 / 外链 / 报错） |
| **交付** | Excel、Word、PPT、PDF、图表（4 种引擎）、图片、语音、视频合成、单文件网页 |
| **协作** | 10 位内置专家、专家团、子代理委派与并行执行 |
| **知识** | 知识库 RAG（docx / pptx / pdf / md / txt 解析，向量 + 重排，后台入库队列）、长期记忆 |
| **自动化** | 定时任务（cron）、结果推送（企业微信 / 钉钉 / 本机通知）、自进化复盘 |
| **接入** | 连接器（MCP）、Agent Plugins 1.0 插件、飞书文档、IM 远程指挥 |
| **体验** | 多任务后台执行、断点续流、成果文件应用内预览、四档权限、桌面宠物 |

内置 **72 个技能包**，覆盖投研、财务、固收、基金、宏观、对公获客、企业尽调、文档与设计等场景；
它们都是 Markdown 文件，按需加载，随时可改。

---

## 快速开始

### 一、装起来

**桌面版（推荐）**：到 [Releases](https://github.com/kunpengtalk/KylinWork/releases) 下载对应平台的安装包，
装完打开即可。桌面版自带运行时，**不用另外装 Node**。

| 平台 | 产物 |
| --- | --- |
| macOS | `.dmg`（Apple Silicon / Intel 各一份） |
| Windows | `-setup.exe` 安装版 / `-portable.exe` 免安装版 |
| Linux | `.AppImage` |

> macOS 第一次打开会被 Gatekeeper 拦下（安装包未做代码签名与公证）。右键 →「打开」，或执行
> `xattr -dr com.apple.quarantine /Applications/KylinWork.app` 放行。

**从源码跑**：需要 **Node ≥ 22.19**。

```bash
git clone https://github.com/kunpengtalk/KylinWork.git
cd KylinWork
npm install
cd ui && npm install && npm run build && cd ..   # 前端产物进 public/dist，桌面版从这里取
npm run app                                      # 打开桌面窗口
```

想用浏览器而不是桌面窗口：`npm start`，然后访问 http://localhost:3800 。

macOS / Linux 也可以用一键脚本（查环境 → 装依赖 → 备好配置 → 起服务）：

```bash
bash scripts/install.sh
```

### 二、配一个模型（第一次必做）

界面第一次打开会进引导页，填入服务商的 API Key，**当场发一条真实请求验活，通过才保存**。

它走的是 OpenAI 兼容接口，所以 DeepSeek、通义千问、智谱 GLM、Kimi、Ollama 本地模型、任何兼容网关都能接。
也可以直接编辑配置：

```jsonc
// <数据目录>/config.json
{
  "provider": "openai",
  "openai": {
    "base_url": "https://api.deepseek.com/v1",  // Ollama 本地模型填 http://localhost:11434/v1
    "api_key": "",                              // 留空则读环境变量 OPENAI_API_KEY
    "model": "deepseek-chat"
  }
}
```

<details>
<summary>数据目录在哪</summary>

| 跑法 | 数据目录 |
| --- | --- |
| 桌面版 | `~/KylinWork` |
| 源码跑 | 就是仓库目录 |
| 自定义 | 设环境变量 `KYLINWORK_HOME=/你的/路径` |

配置、会话、工作区、技能、插件、备份都在这里。放家目录而不是 `Library/Application Support` 是有意的：
工作区里是你要交出去的成果文件，得能在访达 / 资源管理器里直接找到、拖走。

</details>

### 三、说一句话

```
帮我把这份销售数据做成带图表的 Excel 报表，按区域汇总，附一段结论
调研一下这个行业最新的竞争格局，输出一份带图的 Word 报告
做一份 10 页的产品介绍 PPT
写一个落地页，介绍一下你自己
```

---

## 怎么用

### 任务模式

输入框左下角的「+」里切换，也可以在设置里定默认值。

| 模式 | 干什么 |
| --- | --- |
| **Craft · 执行** | 默认。直接开工，边做边交付 |
| **Goal · 目标** | 先声明目标与验收标准，之后每轮自动对照验收清单补未达成项 |
| **Ask · 问答** | 只回答不动手，适合问概念、读代码、看报错 |
| **Plan · 规划** | 只读探查 + 出方案，不写文件不跑命令 |

### 权限档位

它能在你机器上跑命令，所以闸门是分档的（输入框旁可一键切换）：

| 档位 | 写文件 | 跑命令 |
| --- | --- | --- |
| **只看不动** | 禁止 | 禁止（只读探查） |
| **每步都问** | 每次确认 | 每次确认 |
| **自动改文件**（默认） | 工作目录内放行 | 按名单，删除 / sudo 之类照样问 |
| **全自动** | 放行 | 放行，仅保留文件黑名单、高危命令二次确认与审计 |

文件黑名单、高危命令（`rm -rf`、`sudo`、强推分支等）在任何档位下都拦。

### 多任务后台执行

一个任务在跑，照样可以新建任务、翻历史会话。每个任务各跑各的：侧栏挂着转圈标记，
点进去就看到它此刻在干什么、跑了多久、多久没有新输出。关掉窗口、切到别的页面、刷新、甚至重开应用，
任务都不会中断——回来自动接回直播。这轮失败了也有一条带「重试 / 检测网络 / 提交反馈」的报错横幅。

### 专家与技能

**专家**是一份人格 + 一组技能 + 一段默认提示词。内置 10 位（持仓跟踪、对公获客、固收研究、核算与报告、
宏观策略、基金研究、交易测算、经营分析、企业尽调、权益研究），也可以自己建，还能把多位专家编成**专家团**，
一次派整团按顺序接力。

**技能**是一个目录 + 一份 Markdown，agent 通过 `use_skill` 按需加载：

```
skills/my-skill/
└── SKILL.md        # frontmatter: name / description；正文是给 agent 看的操作指南
```

存盘即生效——不用改代码、不用重启、不用打包。内置技能在 `skills/` 下，也可以作为插件分发。

### 连接器与插件

- **连接器（MCP）**：接入 stdio / streamable-http 的 MCP 服务器，工具自动并入 agent 工具表。
- **Agent Plugins 1.0**：一个目录装齐 `plugin.json` + 技能 + MCP 配置，按 [agent-plugins.org](https://agent-plugins.org) 规范加载，
  单个组件坏了只跳过它自己，不影响其余部分。

### 知识库

建库 → 上传资料 → agent 回答时自动检索。支持 docx / pptx / pdf / md / txt，入库在后台队列里跑
（大文件不会把上传请求吊住），失败可重试，重启后接着跑。检索可走向量 + 重排，并会在界面上告诉你
「这次用了哪条向量模型、走没走向量」。

### 定时任务

到点自动执行：每天早上出日报、每周五汇总周报。支持 cron 与自然语言两种写法，结果推送到企业微信 /
钉钉机器人或本机系统通知。睡过头的任务会补跑一次，不会叠加。

### 记忆与自进化

- **记忆**分两层：你手写的偏好（全局），和 agent 用 `remember` 自己记的一条条带归属的条目。
- **自进化**：它会从真实会话里数出「哪类毛病、几次」，据此提出提示词或规则的修改建议，
  经你点头才生效，并按下架门槛淘汰无效改动。

### 远程指挥

把 IM 接上（飞书 / 企业微信 / 公众号 / QQ / 微信 / Webhook），在手机上发一句话，任务就在电脑上跑，
跑完把结果推回聊天窗口。桌面版窗口失焦时，任务完成、等待审批、出错都会弹系统通知，点通知能把窗口拉回来。

### 成果文件

右侧面板就是交付台：实时列出产物、标出本轮新增、体积、修改时间，点开可在应用内直接预览
Word / Excel / PPT / PDF / 图片 / 压缩包（Office 三件套在服务端拆成结构化数据再由前端渲染，
不依赖本机装没装 Office），也能一键起本地预览服务看网页成果。

---

## 命令行

同一套运行时也有 CLI（`bin` 名是 `wb`，`npm link` 后可直接用）：

```bash
node engine/cli.js "帮我调研 xxx 并写成报告"   # 单发任务，跑完退出
node engine/cli.js                             # 交互式 REPL
node engine/cli.js -c                          # 接着最近的会话继续
node engine/cli.js -r                          # 列出历史会话，挑一个续接
node engine/cli.js --mode ask "这段报错什么意思"
```

交互模式内建 `/help /mode /new /files /sessions /resume /compact /cost /model /exit`。

---

## 配置

`config.json` 放在数据目录下（模板见 [`config.example.json`](./config.example.json)）。常用字段：

| 字段 | 说明 |
| --- | --- |
| `provider` | `openai`（兼容接口）或 `anthropic` |
| `openai.base_url` / `api_key` / `model` | 默认模型渠道；Key 留空则读 `OPENAI_API_KEY` |
| `models[]` | 多渠道 / 多模型清单，界面里按「渠道 · 模型」切换 |
| `server.port` | 本地服务端口，默认 `3800` |
| `agent.*` | 步数上限、工具超时、整体运行时上限、LLM 超时 |
| `search.provider` / `api_key` | 联网搜索渠道；留空自动回退免费通道 |
| `knowledge.*` | 切块大小、重叠、召回条数、注入长度、向量 / 重排渠道 |
| `mcp_servers[]` | MCP 连接器 |
| `im.*` | 飞书 / 企业微信 / 公众号 / QQ / 微信 / Webhook |
| `security.permission_mode` | `plan` / `ask` / `auto` / `full`，见上文权限档位 |

> `config.json` 含密钥，已在 `.gitignore` 里，不要提交。

---

## 运行方式

| 场景 | 怎么跑 | 说明 |
| --- | --- | --- |
| 自己电脑用 | `npm run app` | 桌面窗口 + 全局快捷键 + 系统通知，**推荐** |
| 自己电脑，想用浏览器 | `npm start` → http://localhost:3800 | 只监听本机 |
| 装在服务器上，团队共用 | `npm start`，前面套反向代理 | 见下方注意事项 |

```bash
cp config.example.json config.json     # 第一次跑之前先备一份
mkdir -p data workspace
npm start                              # 换端口：PORT=3900 npm start
```

⚠️ 放到服务器意味着把「能在机器上执行 shell、读写文件」的 agent 暴露给使用者。
**只把端口交给反向代理、套上 HTTPS、第一次打开先注册管理员账号**（第一个注册的用户就是管理员），
别留着空库对外。

---

## 目录结构

```
app/                  Electron 桌面壳（窗口、快捷键、系统通知）
engine/               Agent 引擎（Node + Express）
├── agent.js          主循环：规划 → 调工具 → 收尾自检
├── tools.js          内置工具实现（执行 / 读写 / 联网 / 产出）
├── llm.js            模型接入（OpenAI 兼容 + Anthropic，流式与重试）
├── skills.js         技能加载（skills/<名>/SKILL.md）
├── plugins.js        Agent Plugins 1.0 客户端
├── mcp.js            连接器（MCP）
├── security.js       权限档位、文件黑名单、高危命令闸门、审计
├── knowledge.js      知识库（解析 / 入库队列 / 向量检索 + 重排）
├── memory.js         长期记忆
├── evolve.js         自进化复盘
├── scheduler.js      定时任务
├── notify.js         结果推送与系统通知
└── im/               飞书 / 企业微信 / 公众号 / QQ / 微信
ui/                   前端（Vue 3 + Vite + Tailwind 4）
skills/               内置技能包（72 个）
test/e2e.js           端到端测试（用脚本化假模型驱动，不需要 API Key）
eval/                 模型评测任务集
```

## 架构

```
┌───────────────────────────────┐
│  Electron 桌面壳 (app/)        │  窗口 / 快捷键 / 系统通知 / 离屏渲染
├───────────────────────────────┤
│  前端 ui/  →  public/dist      │  Vue 3 + Vite + Tailwind，由本地 Express 托管
├───────────────────────────────┤
│  本机引擎 engine/ (Express)     │  Agent 循环 · 工具 · 技能 · 连接器
│  ├─ 模型接入 llm.js            │  →  你的 API Key → 模型服务商
│  ├─ 工具执行 tools.js          │  →  真的在你机器上跑
│  └─ 数据 paths.js              │  →  ~/KylinWork（配置 / 会话 / 工作区）
└───────────────────────────────┘
```

前端与引擎同源：桌面态由本地 Express 托管前端产物，开发态由 Vite 代理 `/engine-api`。
浏览器、桌面、CLI、IM 四条入口共用同一个运行时与同一份配置。

## 开发

```bash
npm install                # 引擎 + 桌面壳依赖
cd ui && npm install       # 前端依赖

npm test                   # 端到端测试：脚本化假模型驱动完整 agent 管线，无需 API Key
npm run app                # 桌面窗口
npm start                  # 只起引擎（浏览器访问 :3800）
cd ui && npm run dev       # 前端热更新（需另起 npm start）
cd ui && npm run typecheck # 前端类型检查
npm run cli                # 命令行模式
npm run eval               # 模型评测
```

**打包**（产物进 `dist/`）：

```bash
npm run dist:mac     # macOS：dmg + zip（arm64 + x64）
npm run dist:win     # Windows：setup + portable
npm run dist:linux   # Linux：AppImage
npm run pack         # 只出目录，不打包安装器（调试用）
```

CI 在 PR 与 main 上跑前端构建 + 引擎 e2e；打 `v*` 标签会构建三平台安装包并建 Release，见
[`.github/workflows`](./.github/workflows)。

## 常见问题

<details>
<summary><b>macOS 提示「已损坏」或「无法验证开发者」</b></summary>

安装包没做代码签名与公证（需要 Apple 开发者证书），不影响功能。右键 App →「打开」即可，
或 `xattr -dr com.apple.quarantine /Applications/KylinWork.app`。
</details>

<details>
<summary><b>起不来 / 端口被占用</b></summary>

默认端口 `3800`。改 `config.json` 的 `server.port`，或临时 `PORT=3900 npm start`。
「模型: xxx」这行没打印出来，通常是 `config.json` 没配好。
</details>

<details>
<summary><b>任务报错「模型调用失败」</b></summary>

在报错横幅上点「检测网络」：它会真发一条最小请求问上游，帮你分清是网断了、Key 不对，
还是这个模型本身不可用。换模型可以在输入框旁的模型选择器里给当前对话单独指定。
</details>

<details>
<summary><b>数据在哪？怎么重置？</b></summary>

桌面版在 `~/KylinWork`（见上文「数据目录在哪」）。删掉 `config.json` 等于重置配置；
`workspace/` 里是你的成果文件，别误删。全部删掉 = 全新状态。
</details>

<details>
<summary><b>它会不会自己乱跑命令？</b></summary>

不会越档执行。默认「自动改文件」档只放行工作目录内的写入，命令按名单来；高危命令在任何档位都要二次确认，
并且全程有审计记录。不确定它在干什么时，切到「只看不动」再跑一遍看它打算做什么。
</details>

## 安全与隐私

- **默认本地**：不登录也能用全部本地能力。模型请求直连你配置的服务商，没有中间层。
- **密钥留在本机**：`config.json` 或环境变量，且已在 `.gitignore` 中。
- **执行有闸门**：四档权限 + 文件黑名单 + 高危命令二次确认 + 审计。
- **服务端运行**：必须走 HTTPS 与反向代理，首个注册用户即管理员；那台机器上的 agent 能执行 shell，
  不要把端口直接暴露到公网。

## 贡献

欢迎 Issue 与 PR。提交前请确保 `npm test` 与 `cd ui && npm run typecheck` 通过。

改技能不用改代码——往 `skills/` 加一个目录就能提 PR。

## 许可证

[MIT](./LICENSE)。
