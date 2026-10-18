/**
 * Curated display metadata for extensions this manager knows by package name.
 *
 * The package manager returns the original manifest/locale text, which is often
 * English only. The Extension Manager is a Chinese-first surface, so known
 * packages get a hand-written Chinese summary here; unknown packages keep their
 * own text (never machine-invented). Entries are display data only — no
 * management behavior depends on them.
 */
import type { LocalizedTextLike } from './text'

export interface PackageDisplayMeta {
  /** Chinese display title, when the technical name is not the best label. */
  title?: string
  /** Chinese one-line summary. */
  description: string
}

/** Known plugin bundle packages → Chinese display metadata. */
export const PLUGIN_DISPLAY: Record<string, PackageDisplayMeta> = {
  '@deepseek-ai/dsh-base': {
    title: 'DSH 核心基础层',
    description: 'DSH 的基础组合层：会话、模型、工具、沙箱与权限等核心能力的插件集合。',
  },
  '@deepseek-ai/dsh-web-app': {
    title: 'DSH Web 界面层',
    description: 'DSH 的浏览器界面组合层：Web 服务、Web UI 插件、API 网关与客户端运行时。',
  },
  '@deepseek-ai/dsh-experimental-agent-team-profile': {
    title: 'Agent Teams 协作',
    description: '多智能体协作：团队任务板、队友派生与消息传递，以及对应 Web 界面。',
  },
  '@deepseek-ai/dsh-experimental-voice-input-bundle': {
    title: '语音输入（实验）',
    description: '基于本地 SenseVoice 的语音输入，首次使用时下载语音运行时。',
  },
  '@deepseek-ai/dsh-experimental-auto-review': {
    title: '自动审查（实验）',
    description: '在自动权限预设下，用模型逐次复核每个工具调用是否应被允许。',
  },
  '@deepseek-ai/dsh-experimental-inspector-profile': {
    title: '会话检查器（实验）',
    description: '在 Web 界面中查看原始会话日志与对话节点结构，便于调试与排查。',
  },
  '@deepseek-ai/dsh-experimental-session-search': {
    title: '历史会话检索（实验）',
    description: '让智能体搜索并读取同一工作区中的历史会话内容。',
  },
  '@deepseek-ai/dsh-experimental-tool-worktree': {
    title: 'Git Worktree 工具（实验）',
    description: '提供给模型的工具：创建并进入一个新的 Git worktree 进行隔离工作。',
  },
  '@deepseek-ai/dsh-experimental-cot-translation-bundle': {
    title: '思维链翻译（实验）',
    description: '对展开的推理内容做机器翻译，便于阅读英文推理过程。',
  },
  '@deepseek-ai/dsh-experimental-terminal-bundle': {
    title: '持久终端（实验）',
    description: '让 Shell 进程在多次工具调用之间保持存活，支持交互式终端操作。',
  },
  '@deepseek-ai/dsh-experimental-badge-skill-bundle': {
    title: '文档徽标技能（实验）',
    description: '允许智能体在文档、PR 等产物中加入 “powered by dsh” 徽标。',
  },
  '@deepseek-ai/dsh-experimental-ralph-bundle': {
    title: '重复执行工作流（实验）',
    description: '以全新智能体重复执行用户明确要求的循环任务。',
  },
  '@deepseek-ai/dsh-experimental-session-titles-bundle': {
    title: '会话标题刷新（实验）',
    description: '每当有新的用户提示时刷新会话标题。',
  },
  '@deepseek-ai/dsh-experimental-plugin-market-bundle': {
    title: '插件市场（实验）',
    description: '在 Plugins 页面新增 Discover 标签页，浏览并安装自定义插件市场中的组合包。',
  },
  '@deepseek-ai/dsh-acp-app': {
    title: 'ACP 应用层',
    description: '自动化专用的 JSON-RPC stdio 应用层，用于与编辑器等外部客户端集成。',
  },
  '@deepseek-ai/dsh-headless': {
    title: '无界面运行层',
    description: '一次性的无界面智能体会话运行器，不包含 Web 或浏览器层。',
  },
  '@deepseek-ai/dsh-sdk-app': {
    title: 'SDK 应用层',
    description: '以 stdio JSON-RPC 方式对外提供智能体能力的 SDK 运行层。',
  },
  '@deepseek-ai/dsh-sdk-minimal': {
    title: '最小 SDK 运行层',
    description: '只包含 JSON-RPC、单一模型适配器、持久 Shell 与 JSONL 会话的最小运行层。',
  },
  '@deepseek-ai/dsh-subagent-claude-code': {
    title: 'Claude Code 子智能体',
    description: '把 Claude Code 作为子智能体提供方的官方可选组件。',
  },
  '@deepseek-ai/dsh-subagent-codex': {
    title: 'Codex 子智能体',
    description: '把 Codex 作为子智能体提供方的官方可选组件。',
  },
  '@michengai/dsh-skills-manager': {
    title: 'DSH Skills Manager',
    description: '社区技能管理器：统一浏览、启停、导入与更新本机与项目内的 Agent Skills。',
  },
  '@eddyskywalker/dsh-chatgpt-subscription': {
    title: 'ChatGPT 订阅模型通道',
    description: '通过 ChatGPT 订阅访问 Codex 模型的 DSH 模型提供方插件。',
  },
  'dsh-ops': {
    title: 'DSH Ops 高性能工具',
    description: '为 Windows 提供的 Rust 高性能工具集：Bash、PowerShell 7 与文件操作等。',
  },
  'dsh-whale-widget': {
    title: 'DeepSeek 余额小鲸鱼',
    description: 'Web 界面右下角的余额挂件：余额、消耗、峰谷定价与自定义气泡形象。',
  },
  'dsh-context': {
    title: '上下文洞察',
    description: '查看上下文窗口由什么构成、如何变化，并提供上下文管理命令。',
  },
  'dsh-web-search-free': {
    title: '免费网页搜索',
    description: '多引擎回退的免费网页搜索与网页抓取插件。',
  },
  'dsh-better-sidebar': {
    title: '增强侧边栏',
    description: '文件树、编辑器、改动、任务与侧聊合一的多功能侧边栏，并对外提供标签页扩展服务。',
  },
  'ds-bot': {
    title: 'DS Bot 团队',
    description: '长期驻留的多 Bot 协作系统：主 Bot、Bot 间消息与群聊。',
  },
  'dsh-extension-manager': {
    title: '扩展管理器',
    description: '统一查看、检查并安全更新本机安装的 Plugins 与 Skills。',
  },
}

/** Known skill-name → Chinese summary overrides (skills carry their own frontmatter text). */
export const SKILL_DISPLAY: Record<string, string> = {}

/** Resolve manifest-localized text, preferring Chinese, then the given fallback. */
export function localizedText(value: LocalizedTextLike, fallback = ''): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return fallback
  for (const key of ['zh', 'zh-CN', 'zh-cn', 'zh-Hans', 'en']) {
    const text = value[key]
    if (typeof text === 'string' && text.trim() !== '') return text
  }
  const first = Object.values(value).find(text => typeof text === 'string' && text.trim() !== '')
  return typeof first === 'string' ? first : fallback
}
