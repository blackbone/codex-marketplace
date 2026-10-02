export type Blocker = { id: string; num: string; status: string }
export type Question = { id: string; question: string; header: string | null }
export type Interaction = {
  state: string | null
  question: string | null
  questions: Question[]
  requestId: string | null
  updatedAt: string | null
}
export type Row = {
  id: string
  num: string
  title: string
  status: string
  worker: number | null
  profile: string
  profileTooltip: string
  blockers: Blocker[]
  updated: string
  start: string
  end: string
  durationMs: number
  duration: string
  lastRunMs: number
  lastRun: string
  tokens: string
  tokensTitle: string
  tokensTotal: number
  retries: string
  retriesTitle: string
  retriesTotal: number
  error: string
  hasFile: boolean
  interaction: Interaction | null
  turnId: string | null
}
export type Worker = { id: number; status: string; taskId: string | null; taskTitle: string | null }
export type Board = {
  active: boolean
  error?: string
  repo?: string
  generatedAt?: string
  config?: { workers: number; retries: number; defaultModelProfile: string }
  runner?: {
    alive: boolean
    status: string | null
    pid: number | null
    pluginVersion: string | null
    runtimeState: string | null
    mergeWorker: string | null
  } | null
  dashboardUrl?: string | null
  profileProblems?: ProfileProblem[]
  taskCounts?: { running?: number; queued?: number; failed?: number }
  workers?: Worker[]
  tasks?: Row[]
}
export type View = { name: 'tasks' | 'file' | 'chat' | 'logs' | 'settings' | 'graph'; taskId: string | null; from?: 'tasks' | 'graph' }
export type GraphMode = { scope: 'active' | 'all'; focus: string | null; target?: string | null }
export type GraphView = { zoom: number; cx: number; cy: number }
export type Sort = { field: string; dir: 'asc' | 'desc' }
export type ChatMessage = { id: string; source: string; role: string; label?: string; status?: string; text: string; time?: number }
export type Chat = { taskId: string; messages: ChatMessage[]; truncated: boolean; error?: string }
export type LogEntry = {
  scope: string
  taskId: string | null
  attempt: string | null
  file: string
  label: string
  size?: number
  modifiedAt?: string
}
export type Logs = {
  taskId: string | null
  entries: LogEntry[]
  selected: number | null
  content: string
  offset: number
  error?: string
}
export type ModelProfile = { name: string; model: string; reasoningEffort: string; description?: string }
export type ProfileProblem = { profile: string | null; index?: number; field: string; message: string; unchecked?: boolean }
export type CatalogModel = { model: string; aliases: string[]; displayName: string; efforts: string[]; supportsEffort: boolean }
export type Catalog = { command: string; checkedAt: string; models: CatalogModel[]; error: string | null }
export type Settings = {
  revision: string
  values: {
    workers: number
    retries: number
    pollIntervalMs: number
    configReloadIntervalMs: number
    defaultModelProfile: string
    git: { executionMode: string; delivery: string; targetBranch: string | null; remote: string; push: boolean }
    modelProfiles: ModelProfile[]
  }
  profiles: string[]
  profilesInherited?: boolean
  modelCatalog: Catalog | null
  loadingModels?: boolean
  profileProblems: ProfileProblem[]
  profileUsage: Record<string, string[]>
  branches: string[]
  warning?: string | null
}
export type FileView = { id: string; content: string; offset?: number; error?: string }

declare module 'claude-code' {
  interface PluginState {
    todo: {
      board: Board
      view: View
      filter: string
      sort: Sort
      page: number
      file: FileView | null
      chat: Chat | null
      logs: Logs | null
      settings: Settings | null
      draft: Settings | null
      answers: Record<string, string>
      notice: string
      graph: GraphMode
      graphView: GraphView | null
      rowPx: number
      steadyBoard: Board
    }
  }
}
