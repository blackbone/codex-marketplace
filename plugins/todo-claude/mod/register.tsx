import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

import type { Board, Catalog, CatalogModel, Chat, FileView, GraphMode, GraphView, Logs, ModelProfile, ProfileProblem, Row, Settings, Sort, View } from './types'

// The ToDo dashboard drawn natively in a Claude Code pane: the same table,
// filters, sorting, task files, chat and input, logs and settings as the web
// dashboard, backed by scripts/mod-api.mjs.

type PaneRender = RenderInput<'Pane'>

const API = 'scripts/mod-api.mjs'
const PANE = 'todo-dashboard'
const POLL_MS = 3000

const board = atom({ plugin: 'todo', key: 'board' } as const, { active: false } as Board)
const view = atom({ plugin: 'todo', key: 'view' } as const, { name: 'tasks', taskId: null } as View)
const filter = atom({ plugin: 'todo', key: 'filter' } as const, '')
const sort = atom({ plugin: 'todo', key: 'sort' } as const, { field: 'status', dir: 'asc' } as Sort)
const page = atom({ plugin: 'todo', key: 'page' } as const, 0)
const file = atom({ plugin: 'todo', key: 'file' } as const, null as FileView | null)
const chat = atom({ plugin: 'todo', key: 'chat' } as const, null as Chat | null)
const logs = atom({ plugin: 'todo', key: 'logs' } as const, null as Logs | null)
const settings = atom({ plugin: 'todo', key: 'settings' } as const, null as Settings | null)
const draft = atom({ plugin: 'todo', key: 'draft' } as const, null as Settings | null)
const answers = atom({ plugin: 'todo', key: 'answers' } as const, {} as Record<string, string>)
const notice = atom({ plugin: 'todo', key: 'notice' } as const, '')
const graph = atom({ plugin: 'todo', key: 'graph' } as const, { scope: 'active', focus: null } as GraphMode)
// null: fit the whole graph into the frame.
const graphView = atom({ plugin: 'todo', key: 'graphView' } as const, null as GraphView | null)
const rowPx = atom({ plugin: 'todo', key: 'rowPx' } as const, 20)
// The board without fields that change while a task runs (durations, tokens,
// timestamps): the graph reads it, so a running task does not redraw the graph.
const steadyBoard = atom({ plugin: 'todo', key: 'steadyBoard' } as const, { active: false } as Board)

const COLOR: Record<string, string> = {
  running: '#3fb950',
  'waiting-input': '#d29922',
  queued: '#58a6ff',
  'merge-queued': '#a371f7',
  blocked: '#8b949e',
  'merge-conflict': '#f85149',
  failed: '#f85149',
  completed: '#2ea043',
  rejected: '#6e7681',
}
const STATUS_ORDER = ['waiting-input', 'running', 'queued', 'merge-queued', 'blocked', 'merge-conflict', 'failed', 'completed', 'rejected']
const TILES = ['running', 'waiting-input', 'queued', 'merge-queued', 'blocked', 'failed'] as const
const FILTER_FIELDS = new Set(['id', 'task', 'title', 'status', 'worker', 'profile', 'blocker', 'blockers', 'updated', 'start', 'end', 'duration', 'lastrun', 'tokens', 'retries', 'error'])

type Column = { field: string; label: string; width: number; sortable: boolean }
const COLUMNS: Column[] = [
  { field: 'id', label: 'ID', width: 5, sortable: true },
  { field: 'title', label: 'Task', width: 0, sortable: true },
  { field: 'status', label: 'Status', width: 15, sortable: true },
  { field: 'worker', label: 'Worker', width: 7, sortable: true },
  { field: 'profile', label: 'Profile', width: 10, sortable: true },
  { field: 'blockers', label: 'Blockers', width: 12, sortable: true },
  { field: 'updated', label: 'Updated', width: 12, sortable: true },
  { field: 'start', label: 'Start', width: 12, sortable: true },
  { field: 'end', label: 'End', width: 12, sortable: true },
  { field: 'duration', label: 'Duration', width: 10, sortable: true },
  { field: 'lastRun', label: 'Last Run', width: 10, sortable: true },
  { field: 'tokens', label: 'Tokens', width: 10, sortable: true },
  { field: 'retries', label: 'Retries', width: 8, sortable: true },
  { field: 'error', label: 'Error', width: 24, sortable: true },
  { field: 'actions', label: '', width: 12, sortable: false },
]
// Columns dropped first when the pane is narrow, least important first.
const DROP_ORDER = ['start', 'end', 'lastRun', 'retries', 'tokens', 'blockers', 'updated', 'error', 'worker', 'duration', 'profile']

// ---------- pure helpers ----------

// Engine bounds: a Text/Markdown/Code string holds at most 10,000 characters and
// a whole tree at most 100,000 serialized characters.
const MAX_TEXT = 9000
const TREE_BUDGET = 80000
const MAX_ROWS = 80
// Desktop pixels per table row. The surface reports its size only in cells,
// so the pane fills by a pixels-per-row estimate (rowPx, 20 by default) that
// the pane's Taller / Shorter buttons adjust.
const TABLE_ROW_PX = 30
// Rows the header, toolbars and footer take above and below the content.
const CHROME_ROWS = 14
const FILE_CHUNK = 8000

function fit(value: string, limit = MAX_TEXT, fromEnd = false): string {
  const text = String(value ?? '')
  if (text.length <= limit) return text
  return fromEnd ? `…${text.slice(text.length - limit + 1)}` : `${text.slice(0, limit - 1)}…`
}

function treeSize(tree: unknown): number {
  try {
    return JSON.stringify(tree)?.length ?? 0
  } catch {
    return TREE_BUDGET + 1
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function stamp(value: string): string {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function clip(value: string, width: number): string {
  const text = String(value ?? '').replace(/\s+/g, ' ')
  return width > 0 && text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text
}

function bytes(value?: number): string {
  const n = Number(value) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`
}

function filterTokens(query: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: string | null = null
  for (const ch of String(query || '').trim()) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch.trim() === '') {
      if (current) tokens.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current) tokens.push(current)
  return tokens
}

function alternatives(value: string): string[] {
  const v = String(value || '').trim()
  const inner = v.startsWith('(') && v.endsWith(')') ? v.slice(1, -1) : v
  const list = inner.split('|').map(s => s.trim()).filter(Boolean)
  return list.length ? list : ['']
}

function fieldValue(t: Row, field: string): string {
  switch (field) {
    case 'id':
      return t.num
    case 'task':
    case 'title':
      return t.title
    case 'status':
      return t.status
    case 'worker':
      return t.worker === null ? '' : String(t.worker)
    case 'profile':
      return t.profile
    case 'blocker':
    case 'blockers':
      return t.blockers.map(b => b.num).join(' ')
    case 'updated':
      return `${t.updated} ${stamp(t.updated)}`
    case 'start':
      return `${t.start} ${stamp(t.start)}`
    case 'end':
      return `${t.end} ${stamp(t.end)}`
    case 'duration':
      return `${Math.max(0, t.durationMs)} ${t.duration}`
    case 'lastrun':
      return `${Math.max(0, t.lastRunMs)} ${t.lastRun}`
    case 'tokens':
      return String(Math.max(0, t.tokensTotal))
    case 'retries':
      return String(t.retriesTotal)
    case 'error':
      return t.error
    default:
      return ''
  }
}

function matches(t: Row, query: string): boolean {
  const tokens = filterTokens(query)
  if (!tokens.length) return true
  const search = [t.id, t.num, t.title, t.status, t.worker ?? '', t.profile, ...t.blockers.map(b => b.id), ...t.blockers.map(b => b.num), t.error]
    .join(' ')
    .toLowerCase()
  return tokens.every(token => {
    const sep = token.indexOf(':')
    const field = sep > 0 ? token.slice(0, sep).toLowerCase() : ''
    const value = sep > 0 ? token.slice(sep + 1) : token
    if (field && FILTER_FIELDS.has(field)) {
      const fv = fieldValue(t, field).toLowerCase()
      return alternatives(value).some(a => fv.includes(a.toLowerCase()))
    }
    return search.includes(token.toLowerCase())
  })
}

function sortValue(t: Row, field: string): string | number {
  switch (field) {
    case 'id':
      return t.num
    case 'worker':
      return t.worker ?? ''
    case 'blockers':
      return t.blockers.map(b => b.num).join(', ')
    case 'duration':
      return t.durationMs
    case 'lastRun':
      return t.lastRunMs
    case 'tokens':
      return t.tokensTotal
    case 'retries':
      return t.retriesTotal
    default:
      return String((t as unknown as Record<string, unknown>)[field] ?? '')
  }
}

function sorted(rows: Row[], s: Sort): Row[] {
  const factor = s.dir === 'desc' ? -1 : 1
  return [...rows].sort((a, b) => {
    const av = sortValue(a, s.field)
    const bv = sortValue(b, s.field)
    if (s.field === 'status') {
      const ar = STATUS_ORDER.indexOf(String(av))
      const br = STATUS_ORDER.indexOf(String(bv))
      const ra = ar < 0 ? STATUS_ORDER.length : ar
      const rb = br < 0 ? STATUS_ORDER.length : br
      if (ra !== rb) return (ra - rb) * factor
    }
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * factor
    return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' }) * factor
  })
}

function addFilter(current: string, field: string, value: string): string {
  const raw = String(value || '').trim()
  if (!raw) return current
  const formatted = /\s/.test(raw) ? `"${raw.replace(/"/g, '')}"` : raw
  const tokens = filterTokens(current)
  if (field === 'status' || field === 'profile') {
    const i = tokens.findIndex(t => t.toLowerCase().startsWith(`${field}:`))
    if (i >= 0) {
      const existing = alternatives(tokens[i].slice(field.length + 1))
      if (existing.some(a => a.toLowerCase() === raw.toLowerCase())) return current
      tokens[i] = `${field}:${[...existing, formatted].join('|')}`
      return tokens.join(' ')
    }
  }
  const clause = `${field}:${formatted}`
  if (tokens.some(t => t.toLowerCase() === clause.toLowerCase())) return current
  return [...tokens, clause].join(' ').trim()
}

const PROFILE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

// Matches by id, alias, or dated id, as findCliModel in scripts/claude-models.mjs.
function catalogEntry(catalog: Catalog | null, model: string): CatalogModel | undefined {
  const models = catalog?.models ?? []
  return models.find(m => m.model === model || m.aliases.includes(model)) ??
    models.find(m => m.model.startsWith(`${model}-`) && /^\d{8}$/.test(m.model.slice(model.length + 1)))
}

function effortsOf(catalog: Catalog | null, model: string): string[] {
  const entry = catalogEntry(catalog, model)
  return entry?.supportsEffort ? entry.efforts : EFFORTS
}

// Mirrors profileProblems in scripts/claude-models.mjs, which the save re-checks.
function localProblems(profiles: ModelProfile[], defaultName: string, catalog: Catalog | null): ProfileProblem[] {
  const problems: ProfileProblem[] = []
  if (!profiles.length) return [{ profile: null, field: 'profiles', message: 'Add at least one model profile.' }]
  if (catalog && !catalog.models.length) {
    problems.push({ profile: null, field: 'models', message: `The Claude CLI model list is unavailable${catalog.error ? `: ${catalog.error}` : '.'}` })
  }
  const names = new Set<string>()
  profiles.forEach((p, index) => {
    const label = p.name || `#${index + 1}`
    const add = (field: string, message: string) => problems.push({ profile: label, index, field, message })
    if (!PROFILE_NAME.test(p.name || '')) add('name', 'Name must be lowercase letters, digits and single hyphens.')
    else if (names.has(p.name)) add('name', `Profile name '${p.name}' is used twice.`)
    names.add(p.name)
    if (!p.model) add('model', 'Choose a model.')
    else if (catalog?.models.length && !catalogEntry(catalog, p.model)) add('model', `Model '${p.model}' is not in the Claude CLI model list.`)
    const efforts = effortsOf(catalog, p.model)
    if (!efforts.includes(p.reasoningEffort)) add('reasoningEffort', `Effort '${p.reasoningEffort}' is not supported by '${p.model}'. Supported: ${efforts.join(', ')}.`)
  })
  if (!profiles.some(p => p.name === defaultName)) problems.push({ profile: null, field: 'defaultModelProfile', message: `Default profile '${defaultName}' is not in the profile list.` })
  return problems
}

function summary(b: Board): string {
  const rows = (b.tasks ?? []).filter(t => !['completed', 'rejected'].includes(t.status))
  const n = (k: string) => rows.filter(t => t.status === k).length
  const parts: string[] = []
  if (n('running')) parts.push(`${n('running')}▶`)
  if (n('waiting-input')) parts.push(`${n('waiting-input')}?`)
  const q = n('queued') + n('merge-queued')
  if (q) parts.push(`${q}·`)
  const f = n('failed') + n('merge-conflict')
  if (f) parts.push(`${f}✗`)
  return `ToDo ${parts.join(' ') || 'idle'}${b.runner?.alive ? '' : ' · runner off'}`
}

function esc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function overview(b: Board, width: number): string {
  const tasks = b.tasks ?? []
  const counts: Record<string, number> = {}
  for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1
  const total = Math.max(1, tasks.length)
  const W = Math.max(480, Math.min(1400, width))
  const tileW = (W - 5 * 8) / 6
  const font = 'font-family="system-ui,-apple-system,sans-serif"'
  const tiles = TILES.map((k, i) => {
    const x = i * (tileW + 8)
    const n = counts[k] ?? 0
    return `<g transform="translate(${x},0)"><rect width="${tileW}" height="58" rx="8" fill="${COLOR[k]}" fill-opacity="${n ? 0.16 : 0.05}" stroke="${COLOR[k]}" stroke-opacity="${n ? 0.55 : 0.18}"/><text x="12" y="33" font-size="24" font-weight="700" fill="${COLOR[k]}" fill-opacity="${n ? 1 : 0.4}" ${font}>${n}</text><text x="12" y="49" font-size="11" fill="#9ba1a6" ${font}>${esc(k)}</text></g>`
  }).join('')
  let x = 0
  const bar = STATUS_ORDER.filter(k => counts[k])
    .map(k => {
      const w = ((counts[k] ?? 0) / total) * W
      const r = `<rect x="${x}" y="72" width="${Math.max(2, w - 1)}" height="8" fill="${COLOR[k] ?? '#6e7681'}"><title>${esc(k)}: ${counts[k]}</title></rect>`
      x += w
      return r
    })
    .join('')
  const workers = b.workers ?? []
  const lanes = workers
    .map((w, i) => {
      const busy = w.status !== 'idle'
      return `<rect x="${i * 20}" y="98" width="16" height="16" rx="4" fill="${busy ? '#3fb950' : '#6e7681'}" fill-opacity="${busy ? 1 : 0.25}"><title>worker ${w.id}: ${esc(w.status)}${w.taskTitle ? ` — ${esc(w.taskTitle)}` : ''}</title></rect>`
    })
    .join('')
  const busy = workers.filter(w => w.status !== 'idle').length
  const text = `<text x="0" y="93" font-size="11" fill="#9ba1a6" ${font}>completed ${counts.completed ?? 0} of ${tasks.length}</text><text x="${workers.length * 20 + 6}" y="111" font-size="11" fill="#9ba1a6" ${font}>workers ${busy}/${workers.length}</text>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 120" width="${W}" height="120">${tiles}<rect y="72" width="${W}" height="8" rx="4" fill="#6e7681" fill-opacity="0.18"/>${bar}${text}${lanes}</svg>`
}

// ---------- task graph ----------

const CLOSED = new Set(['completed', 'rejected'])
const GRAPH_LIMIT = 150

// The tasks a graph shows: active tasks with every task they depend on, or the
// whole history; a focus narrows it to one task's ancestors and dependents.
function graphNodes(rows: Row[], mode: GraphMode): Row[] {
  const byId = new Map(rows.map(t => [t.id, t]))
  const dependents = new Map<string, string[]>()
  for (const t of rows) for (const b of t.blockers) (dependents.get(b.id) ?? dependents.set(b.id, []).get(b.id)!).push(t.id)
  const walk = (start: string[], next: (id: string) => string[]) => {
    const seen = new Set<string>()
    const stack = [...start]
    while (stack.length) {
      const id = stack.pop() as string
      if (seen.has(id) || !byId.has(id)) continue
      seen.add(id)
      stack.push(...next(id))
    }
    return seen
  }
  const up = (id: string) => (byId.get(id)?.blockers ?? []).map(b => b.id)
  const down = (id: string) => dependents.get(id) ?? []
  let ids: Set<string>
  if (mode.focus && byId.has(mode.focus)) {
    ids = new Set([...walk([mode.focus], up), ...walk([mode.focus], down)])
  } else if (mode.scope === 'active') {
    ids = walk(rows.filter(t => !CLOSED.has(t.status)).map(t => t.id), up)
  } else {
    ids = new Set(rows.filter(t => t.blockers.length || dependents.has(t.id)).map(t => t.id))
  }
  // Tasks without a dependency inside the picture add nothing to a graph.
  const linked = (id: string) => (byId.get(id)?.blockers ?? []).some(b => ids.has(b.id)) || (dependents.get(id) ?? []).some(d => ids.has(d))
  if (mode.target && byId.has(mode.target)) ids.add(mode.target)
  return [...ids].filter(id => id === mode.focus || id === mode.target || linked(id)).map(id => byId.get(id) as Row)
    .sort((a, b) => Number(b.num) - Number(a.num)).slice(0, GRAPH_LIMIT)
}

// Columns by dependency depth: a task sits one column right of its deepest blocker.
function graphLayout(nodes: Row[]) {
  const byId = new Map(nodes.map(t => [t.id, t]))
  const depth = new Map<string, number>()
  const visiting = new Set<string>()
  const depthOf = (id: string): number => {
    if (depth.has(id)) return depth.get(id) as number
    if (visiting.has(id)) return 0
    visiting.add(id)
    const parents = (byId.get(id)?.blockers ?? []).filter(b => byId.has(b.id))
    const d = parents.length ? Math.max(...parents.map(b => depthOf(b.id))) + 1 : 0
    visiting.delete(id)
    depth.set(id, d)
    return d
  }
  const columns: Row[][] = []
  for (const t of [...nodes].sort((a, b) => Number(a.num) - Number(b.num))) (columns[depthOf(t.id)] ||= []).push(t)
  const filled = columns.map(c => c ?? [])
  // Fewer crossings: order each column by the mean row of its blockers, then
  // the first column by the mean row of its dependents (two sweeps).
  const rowOf = new Map<string, number>()
  const index = () => filled.forEach(c => c.forEach((t, r) => rowOf.set(t.id, r)))
  const mean = (ids: string[], fallback: number) => {
    const rows = ids.map(id => rowOf.get(id)).filter((r): r is number => r !== undefined)
    return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : fallback
  }
  for (let sweep = 0; sweep < 2; sweep += 1) {
    index()
    for (let c = 1; c < filled.length; c += 1) {
      filled[c] = filled[c].map((t, r) => ({ t, k: mean(t.blockers.map(b => b.id), r) })).sort((a, b) => a.k - b.k).map(x => x.t)
      index()
    }
    for (let c = filled.length - 2; c >= 0; c -= 1) {
      filled[c] = filled[c].map((t, r) => ({ t, k: mean(nodes.filter(n => n.blockers.some(b => b.id === t.id)).map(n => n.id), r) }))
        .sort((a, b) => a.k - b.k).map(x => x.t)
      index()
    }
  }
  return { columns: filled, depth }
}

const STATUS_LABEL: Record<string, string> = {
  completed: 'Succeeded',
  running: 'Running',
  'waiting-input': 'Needs input',
  queued: 'Queued',
  'merge-queued': 'Merging',
  blocked: 'Blocked',
  'merge-conflict': 'Merge conflict',
  failed: 'Failed',
  rejected: 'Canceled',
}
const STATUS_TONE: Record<string, string> = {
  completed: '#3fb950',
  running: '#58a6ff',
  'waiting-input': '#e3b341',
  queued: '#8b949e',
  'merge-queued': '#a371f7',
  blocked: '#f0883e',
  'merge-conflict': '#f85149',
  failed: '#f85149',
  rejected: '#6e7681',
}
const CARD_W = 150
const CARD_H = 62
const COL_GAP = 80
const ROW_GAP = 26
const MARGIN = 40

// Splits a title into at most two lines of `width` characters, the second
// ending in an ellipsis when the title is longer.
function titleLines(text: string, width: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ')
  const lines: string[] = ['']
  for (const word of words) {
    const line = lines[lines.length - 1]
    if (!line || line.length + 1 + word.length <= width) lines[lines.length - 1] = line ? `${line} ${word}` : word
    else if (lines.length < 2) lines.push(word)
    else { lines[1] = `${lines[1]} ${word}`; break }
  }
  return lines.map((line, i) => (line.length > width || (i === 1 && words.join(' ').length > lines.join(' ').length) ? `${line.slice(0, width - 1).trimEnd()}…` : line))
}

const PULSE: Record<string, string> = { running: 'pulse-run', failed: 'pulse-fail', 'merge-conflict': 'pulse-fail', 'waiting-input': 'pulse-wait' }
const PULSE_STYLE = '<style>' +
  '.pulse-run .glow{animation:glow 2.8s ease-in-out infinite}' +
  '.pulse-fail .glow{animation:glow .75s ease-in-out infinite}' +
  '.pulse-wait .glow{animation:glow 1.5s ease-in-out infinite}' +
  '@keyframes glow{0%,100%{opacity:.12}50%{opacity:.95}}' +
  '</style><filter id="blur" x="-20%" y="-40%" width="140%" height="180%"><feGaussianBlur stdDeviation="4"/></filter>'

type Scene = { body: string; width: number; height: number; pos: Map<string, { x: number; y: number }> }

// The whole graph in its own coordinates: cards in dependency-depth columns,
// orthogonal edges through a bus between columns, like a pipeline view.
function graphScene(nodes: Row[], focus: string | null, target: string | null = null): Scene {
  const { columns } = graphLayout(nodes)
  const pos = new Map<string, { x: number; y: number }>()
  columns.forEach((column, c) => column.forEach((t, r) => pos.set(t.id, { x: MARGIN + c * (CARD_W + COL_GAP), y: MARGIN + r * (CARD_H + ROW_GAP) })))
  const width = MARGIN * 2 + Math.max(1, columns.length) * (CARD_W + COL_GAP) - COL_GAP
  const height = MARGIN * 2 + Math.max(1, ...columns.map(c => c.length)) * (CARD_H + ROW_GAP) - ROW_GAP
  // Short CSS names: node k is n<k>; edge i is e<i>. Hover works through
  // :has(), as the drawing has no script.
  const index = new Map(nodes.map((t, k) => [t.id, k]))
  const toneOf = (t: Row | undefined) => (t ? STATUS_TONE[t.status] ?? '#8b949e' : '#8b949e')
  const byId = new Map(nodes.map(t => [t.id, t]))
  const related = new Map<string, Set<number>>(nodes.map(t => [t.id, new Set<number>()]))
  const incident = new Map<string, number[]>(nodes.map(t => [t.id, []]))
  const edges: string[] = []
  let e = 0
  for (const t of nodes) {
    const to = pos.get(t.id)
    for (const b of t.blockers) {
      const from = pos.get(b.id)
      if (!from || !to) continue
      const x1 = from.x + CARD_W, y1 = from.y + CARD_H / 2, x2 = to.x, y2 = to.y + CARD_H / 2
      // The bus sits just right of the blocker's column, so edges from one
      // column share their vertical runs.
      const bus = x1 + Math.min(COL_GAP / 2, (x2 - x1) / 2)
      const hot = focus !== null && (t.id === focus || b.id === focus)
      const r = Math.min(6, Math.abs(y2 - y1) / 2)
      const d = y1 === y2
        ? `M${x1} ${y1}H${x2 - 5}`
        : `M${x1} ${y1}H${bus - r}Q${bus} ${y1} ${bus} ${y1 + Math.sign(y2 - y1) * r}V${y2 - Math.sign(y2 - y1) * r}Q${bus} ${y2} ${bus + r} ${y2}H${x2 - 5}`
      const src = index.get(b.id) as number, dst = index.get(t.id) as number
      related.get(b.id)!.add(dst)
      related.get(t.id)!.add(src)
      incident.get(b.id)!.push(e)
      incident.get(t.id)!.push(e)
      // --a / --b: the colors of the blocker and the dependent, for a hover on the other end.
      edges.push(`<g class="edge e${e} s${src} t${dst}" style="--a:${toneOf(byId.get(b.id))};--b:${toneOf(t)}"><path class="hit" d="${d}"/>` +
        `<path class="line" d="${d}" fill="none" stroke="${hot ? '#58a6ff' : '#6e7681'}" stroke-width="${hot ? 1.8 : 1}" stroke-opacity="${hot ? 1 : 0.75}" marker-end="url(#${hot ? 'h' : 'a'})"/></g>`)
      e += 1
    }
  }
  const cards = nodes.map((t, k) => {
    const p = pos.get(t.id) as { x: number; y: number }
    const tone = toneOf(t)
    const selected = t.id === focus || t.id === target
    const pulse = PULSE[t.status]
    const glow = pulse ? `<rect class="glow" x="${p.x - 3}" y="${p.y - 3}" width="${CARD_W + 6}" height="${CARD_H + 6}" rx="7" fill="none" stroke="${tone}" stroke-width="4" filter="url(#blur)"/>` : ''
    const classes = ['node', `n${k}`, ...[...related.get(t.id)!].map(m => `r${m}`), ...incident.get(t.id)!.map(i => `x${i}`), ...(pulse ? [pulse] : [])]
    return `<g class="${classes.join(' ')}" style="--tone:${tone}"><title>${esc(`[${t.num}] ${t.title}\n${STATUS_LABEL[t.status] ?? t.status}${t.profile ? ` · ${t.profile}` : ''}`)}</title>${glow}` +
      `<rect class="frame" x="${p.x}" y="${p.y}" width="${CARD_W}" height="${CARD_H}" rx="4" fill="#1f2023" stroke="${selected ? '#58a6ff' : pulse ? tone : '#3a3b3f'}" stroke-width="${selected ? 1.6 : 1}"/>` +
      `<circle cx="${p.x}" cy="${p.y + CARD_H / 2}" r="2" fill="#6e7681"/><circle cx="${p.x + CARD_W}" cy="${p.y + CARD_H / 2}" r="2" fill="#6e7681"/>` +
      titleLines(`[${t.num}] ${t.title}`, 24).map((line, i) => `<text x="${p.x + 10}" y="${p.y + 17 + i * 13}" fill="#e6edf3" font-size="10.5">${esc(line)}</text>`).join('') +
      `<circle cx="${p.x + 12}" cy="${p.y + CARD_H - 13}" r="2.6" fill="${tone}"/><text x="${p.x + 19}" y="${p.y + CARD_H - 10}" fill="${tone}" font-size="9.5">${esc(STATUS_LABEL[t.status] ?? t.status)}</text></g>`
  })
  // Hovering a node dims the rest and lights the node, its edges and the tasks
  // they reach in those tasks' status colors; hovering an edge lights it and
  // its two nodes in a faint white.
  const hover = [
    'text{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}',
    '.hit{fill:none;stroke:transparent;stroke-width:12;pointer-events:stroke}',
    'svg:has(.node:hover) .node{opacity:.4}',
    // A hovered node sets --c/--o/--w on its edges; the rest fade.
    'svg:has(.node:hover) .line{stroke:var(--c,#6e7681);stroke-opacity:var(--o,.15);stroke-width:var(--w,1)}',
    '.edge:hover .line{stroke:#fff;stroke-opacity:.6;stroke-width:1.8}',
    ...nodes.map((_, k) => {
      const on = `svg:has(.n${k}:hover)`
      return `${on} :is(.n${k},.r${k}){opacity:1}${on} .n${k} .frame{stroke:#e6edf3}${on} .r${k} .frame{stroke:var(--tone)}` +
        `${on} .s${k}{--c:var(--b);--o:1;--w:1.8}${on} .t${k}{--c:var(--a);--o:1;--w:1.8}`
    }),
    ...Array.from({ length: e }, (_, i) => `svg:has(.e${i}:hover) .x${i} .frame{fill:#2a2b2f;stroke:#ffffffa0}`),
  ].join('')
  const defs = `<defs>${PULSE_STYLE}<style>${hover}</style><marker id="a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L8 4L0 8z" fill="#6e7681"/></marker><marker id="h" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L8 4L0 8z" fill="#58a6ff"/></marker></defs>`
  return { body: `${defs}${edges.join('')}${cards.join('')}`, width, height, pos }
}

// The visible window onto the scene: zoom 1 shows it at natural size; the
// center moves with the pan buttons.
function graphSvg(scene: Scene, frame: { width: number; height: number }, view: GraphView): string {
  const w = frame.width / view.zoom
  const h = frame.height / view.zoom
  const x = Math.round(view.cx - w / 2)
  const y = Math.round(view.cy - h / 2)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${Math.round(w)} ${Math.round(h)}" width="${frame.width}" height="${frame.height}" preserveAspectRatio="xMidYMid meet"><rect x="${x - 2000}" y="${y - 2000}" width="${Math.round(w) + 4000}" height="${Math.round(h) + 4000}" fill="#1a1a1a"/>${scene.body}</svg>`
}

function fitView(scene: { width: number; height: number }, frame: { width: number; height: number }): GraphView {
  const zoom = Math.min(1.5, frame.width / scene.width, frame.height / scene.height)
  return { zoom, cx: scene.width / 2, cy: scene.height / 2 }
}

// Opening view: 100% centered on the target, else on running work, else on a
// task waiting for input or failed; the whole graph fits when none is drawn.
function openingView(scene: Scene, frame: { width: number; height: number }, nodes: Row[], target: string | null): GraphView {
  const pick = [target, ...['running', 'waiting-input', 'failed', 'merge-conflict'].map(st => nodes.find(t => t.status === st)?.id ?? null)]
    .find(id => id && scene.pos.has(id))
  if (!pick) return fitView(scene, frame)
  const p = scene.pos.get(pick) as { x: number; y: number }
  return { zoom: 1, cx: p.x + CARD_W / 2, cy: p.y + CARD_H / 2 }
}

// ---------- calls into mod-api.mjs ----------

async function api($: EngineInterface, args: string[]): Promise<any> {
  const cwd = await $.session.cwd()
  const ran = await $.process
    .run(['node', `${$.plugin.root}/${API}`, args[0], cwd, ...args.slice(1)], { timeoutMs: 30000 })
    .catch(() => null)
  if (!ran) return { error: 'ToDo backend did not answer' }
  try {
    return JSON.parse(ran.stdout.trim().split('\n').pop() || '{}')
  } catch {
    return { error: ran.stderr.trim().slice(0, 300) || 'Unexpected backend output' }
  }
}

let previous = new Map<string, string>()
let isFirst = true
let lastSignature = ''
let lastSteadySignature = ''
let lastBoardWrite = 0
let lastStatus: string | undefined = '\u0000'
const BOARD_REFRESH_MS = 15000

async function poll($: EngineInterface) {
  const next: Board = await api($, ['status'])
  if (next.error && !next.active) return
  // Every write redraws the pane, and a press that lands on a replaced drawing
  // is lost, so writes stay rare: at once when a status, task or dependency
  // changes, and at most every BOARD_REFRESH_MS for durations and tokens.
  const signature = JSON.stringify({ ...next, generatedAt: undefined })
  const steady: Board = {
    ...next,
    generatedAt: undefined,
    tasks: next.tasks?.map(t => ({ ...t, updated: '', start: '', end: '', durationMs: 0, duration: '', lastRunMs: 0, lastRun: '', tokens: '', tokensTitle: '', tokensTotal: 0, retries: '', retriesTitle: '' })),
  }
  const steadySig = JSON.stringify(steady)
  const steadyChanged = steadySig !== lastSteadySignature
  if (steadyChanged) {
    lastSteadySignature = steadySig
    await update($, steadyBoard, () => steady)
  }
  const nowMs = Date.now()
  if (signature !== lastSignature && (steadyChanged || nowMs - lastBoardWrite >= BOARD_REFRESH_MS)) {
    lastSignature = signature
    lastBoardWrite = nowMs
    await update($, board, () => next)
  }
  const status = next.active ? summary(next) : undefined
  if (status !== lastStatus) {
    lastStatus = status
    $.ui.status(status)
  }
  if (!next.active) return

  const now = new Map((next.tasks ?? []).map(t => [t.id, t.status]))
  if (!isFirst) {
    for (const t of next.tasks ?? []) {
      const was = previous.get(t.id)
      if (was === undefined || was === t.status) continue
      if (t.status === 'waiting-input') $.ui.toast(`ToDo ${t.num} waits for input: ${t.title}`)
      else if (t.status === 'failed' || t.status === 'merge-conflict') $.ui.toast(`ToDo ${t.num} ${t.status}: ${t.title}`)
      else if (t.status === 'completed') $.ui.toast(`ToDo ${t.num} completed: ${t.title}`)
    }
  }
  previous = now
  isFirst = false

  const v = await read($, view)
  if (v.name === 'chat' && v.taskId) await loadChat($, v.taskId)
}

async function openView($: EngineInterface, name: View['name'], taskId: string | null, from?: View['from']) {
  await update($, notice, () => '')
  // A task's tabs keep the view the task window was opened from, for Back.
  const previous = await read($, view)
  const origin = from ?? (taskId && previous.taskId ? previous.from : previous.name === 'graph' ? 'graph' : 'tasks')
  await update($, view, () => ({ name, taskId, from: taskId ? origin : undefined }))
  if (name === 'file' && taskId) {
    await update($, file, () => null)
    const r = await api($, ['task', taskId])
    await update($, file, () => ({ id: taskId, content: r.content ?? '', offset: 0, error: r.error }))
  } else if (name === 'chat' && taskId) {
    await update($, chat, () => null)
    await update($, answers, () => ({}))
    await loadChat($, taskId)
  } else if (name === 'logs') {
    await update($, logs, () => null)
    const r = await api($, taskId ? ['logs', taskId] : ['logs'])
    await update($, logs, () => ({ taskId, entries: r.logs ?? [], selected: null, content: '', offset: 0, error: r.error }))
    if ((r.logs ?? []).length) await openLog($, 0)
  } else if (name === 'settings') {
    const r = await api($, ['settings'])
    if (r.error) await update($, notice, () => `Error: ${r.error}`)
    await update($, settings, () => (r.error ? null : r))
    await update($, draft, () => (r.error ? null : r))
    if (!r.error && (!r.modelCatalog || r.modelCatalog.error)) void refreshModels($, false)
  }
}

async function loadChat($: EngineInterface, taskId: string) {
  const r = await api($, ['chat', taskId])
  const next = { taskId, messages: r.messages ?? [], truncated: Boolean(r.truncated), error: r.error }
  // Polling rewrites the chat only when it changed, so the pane is not redrawn under a click.
  const current = await read($, chat)
  if (JSON.stringify(current) !== JSON.stringify(next)) await update($, chat, () => next)
}

async function openLog($: EngineInterface, index: number) {
  const current = await read($, logs)
  const entry = current?.entries[index]
  if (!current || !entry) return
  await update($, logs, l => (l ? { ...l, selected: index, content: 'Loading…', offset: 0 } : l))
  const r = await api($, ['log', entry.scope, entry.taskId ?? '', entry.attempt ?? '', entry.file])
  await update($, logs, l => (l ? { ...l, selected: index, content: r.content ?? `Error: ${r.error}`, offset: 0 } : l))
}

async function sendInput($: EngineInterface, task: Row) {
  const values = await read($, answers)
  const action = task.status === 'waiting-input' ? 'reply' : task.status === 'running' ? 'steer' : 'continue'
  const body = {
    taskId: task.id,
    action,
    text: values.prompt || '',
    answers: values,
    requestId: task.interaction?.requestId ?? undefined,
    expectedInteractionId: task.interaction?.updatedAt ?? undefined,
    expectedTurnId: task.turnId ?? undefined,
  }
  await update($, notice, () => 'Sending…')
  const r = await api($, ['action', JSON.stringify(body)])
  await update($, notice, () => (r.error ? `Error: ${r.error}` : r.warning || (r.queued ? 'Queued to continue' : 'Accepted')))
  if (!r.error && r.accepted !== false) await update($, answers, () => ({}))
  await loadChat($, task.id)
}

async function refreshModels($: EngineInterface, force: boolean) {
  await update($, settings, x => (x ? { ...x, loadingModels: true } : x))
  const r = await api($, force ? ['models', 'force'] : ['models'])
  await update($, settings, x => (x ? { ...x, loadingModels: false, modelCatalog: r.models ? r : x.modelCatalog } : x))
  if (r.error && !r.models) await update($, notice, () => `Error: ${r.error}`)
}

async function startRunner($: EngineInterface) {
  await update($, notice, () => 'Checking model profiles and starting the runner…')
  const r = await api($, ['start'])
  if (r.status === 'running' || r.status === 'started' || r.status === 'starting') {
    await update($, notice, () => `Runner ${r.status}.`)
  } else {
    await update($, notice, () => `Error: runner ${r.status ?? 'failed'}${r.reason ? ` — ${r.reason}` : r.error ? ` — ${r.error}` : ''}`)
  }
  await poll($)
}

// Opens the graph at 100% centered on one task, in the active view when the
// task is part of it, else in the whole history.
async function showInGraph($: EngineInterface, id: string) {
  const rows = (await read($, board)).tasks ?? []
  const active = graphNodes(rows, { scope: 'active', focus: null }).some(t => t.id === id)
  await update($, graph, () => ({ scope: active ? 'active' : 'all', focus: null, target: id }))
  await update($, graphView, () => null)
  await openView($, 'graph', null)
}

// Taller or shorter content: the pixels-per-row estimate, kept across sessions.
async function adjustRowPx($: EngineInterface, delta: number) {
  const next = Math.max(8, Math.min(60, (await read($, rowPx)) + delta))
  await update($, rowPx, () => next)
  await $.store.set('rowPx', next).catch(() => undefined)
}

// The dashboard table with one filter, opened from the band above the prompt.
async function openDashboard($: EngineInterface, query: string) {
  await update($, filter, () => query)
  await update($, page, () => 0)
  await openView($, 'tasks', null)
  await $.ui.open({ id: PANE, title: 'ToDo', focus: true })
}

async function saveSettings($: EngineInterface) {
  const d = await read($, draft)
  if (!d) return
  await update($, notice, () => 'Saving…')
  const known = await read($, settings)
  const blocking = localProblems(d.values.modelProfiles, d.values.defaultModelProfile, known?.modelCatalog ?? null)
  if (blocking.length) {
    await update($, notice, () => `Error: fix the model profiles first — ${blocking.map(p => (p.profile ? `${p.profile}: ${p.message}` : p.message)).join(' · ')}`)
    return
  }
  await update($, notice, () => 'Saving…')
  const r = await api($, ['save', JSON.stringify({ revision: d.revision, values: d.values })])
  if (r.error) {
    await update($, notice, () => `Error: ${r.error.replace(/\n/g, ' · ')}`)
    return
  }
  const fresh = await api($, ['settings'])
  await update($, settings, () => fresh)
  await update($, draft, () => fresh)
  await update($, notice, () => 'Saved. The runner applies settings on its next config reload.')
}

// ---------- the pane ----------

async function drawPane($: EngineInterface, e: PaneRender) {
  const ui = $.ui.resolve(e)
  const { Box, Button, Code, Input, Markdown, Select, Text } = ui
  const Svg = (ui as any).Svg
  const isDesktop = e.surface === 'desktop'
  const v = await read($, view)
  // The graph subscribes to the steady board only, so it redraws on real changes.
  const b = v.name === 'graph' && e.surface === 'desktop' ? await read($, steadyBoard) : await read($, board)
  const msg = await read($, notice)
  const cols = Math.max(60, e.props.bodyColumns ?? e.viewport?.columns ?? 120)
  const height = Math.max(20, e.viewport?.rows ?? 40)
  const px = await read($, rowPx)
  // The content's share of the pane, in desktop pixels.
  const fillPx = Math.max(300, (height - CHROME_ROWS) * px)

  if (!b.active) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>ToDo</Text>
        <Text dimColor>ToDo is not activated in this repository. Run /todo:init, then /todo:start.</Text>
        <Button key="nav-refresh" label="Refresh" onPress={() => poll($)} />
      </Box>
    )
  }

  const rows = b.tasks ?? []
  const byId = new Map(rows.map(t => [t.id, t]))
  const statusPill = (status: string, key: string, onPress?: () => void) =>
    onPress ? (
      <Button key={key} plain label={` ${status} `} onPress={onPress} />
    ) : (
      <Text color="#0d1117" backgroundColor={COLOR[status] ?? '#6e7681'} bold>{` ${status} `}</Text>
    )

  const blockers = (b.profileProblems ?? []).filter(p => !p.unchecked)
  const header = (
    <Box flexDirection="column">
      <Box justifyContent="space-between" alignItems="center">
        <Text bold>ToDo — {b.repo}</Text>
        <Box gap={1}>
          <Button key="nav-tasks" label="Tasks" variant={v.name === 'tasks' ? 'primary' : undefined} onPress={() => openView($, 'tasks', null)} />
          {isDesktop ? <Button key="nav-graph" label="Graph" variant={v.name === 'graph' ? 'primary' : undefined} onPress={() => openView($, 'graph', null)} /> : null}
          <Button key="nav-logs" label="All logs" onPress={() => openView($, 'logs', null)} />
          <Button key="nav-settings" label="Settings" onPress={() => openView($, 'settings', null)} />
          <Button key="nav-refresh" label="Refresh" onPress={() => poll($)} />
        </Box>
      </Box>
      <Text dimColor>
        {`runner ${b.runner?.alive ? b.runner?.status ?? 'running' : 'off'}${b.runner?.pid ? ` · pid ${b.runner.pid}` : ''}${b.runner?.runtimeState ? ` · runtime ${b.runner.runtimeState}` : ''}${b.runner?.mergeWorker ? ` · merge ${b.runner.mergeWorker}` : ''} · workers ${(b.workers ?? []).filter(w => w.status !== 'idle').length}/${b.config?.workers ?? 0} · retries ${b.config?.retries ?? '-'} · default ${b.config?.defaultModelProfile ?? '-'} · running ${b.taskCounts?.running ?? 0} · queued ${b.taskCounts?.queued ?? 0} · failed ${b.taskCounts?.failed ?? 0}`}
      </Text>
      {!b.runner?.alive ? (
        <Box gap={1} alignItems="center">
          {blockers.length ? (
            <Text color="#f85149">{`Runner cannot start: ${blockers.length} model profile problem${blockers.length > 1 ? 's' : ''} — ${fit(blockers.map(p => (p.profile ? `${p.profile}: ${p.message}` : p.message)).join(' · '), 300)}`}</Text>
          ) : (
            <Text color="#d29922">Runner is not running.</Text>
          )}
          {blockers.length ? <Button key="fix-profiles" label="Fix profiles" variant="primary" onPress={() => openView($, 'settings', null)} /> : null}
          <Button key="start-runner" label="Start runner" variant={blockers.length ? undefined : 'primary'} onPress={() => startRunner($)} />
        </Box>
      ) : null}
      {msg ? <Text color={msg.startsWith('Error') ? '#f85149' : '#3fb950'}>{fit(msg, 2000)}</Text> : null}
    </Box>
  )

  // ----- task window: Overview, Chat and Logs tabs of one task -----
  const taskBar = (taskId: string, tab: 'file' | 'chat' | 'logs') => {
    const t = byId.get(taskId)
    const back = v.from === 'graph' ? 'graph' : 'tasks'
    return (
      <Box flexDirection="column" gap={1}>
        <Box gap={1} alignItems="center" flexWrap="wrap">
          <Button key="back" label={back === 'graph' ? '← Graph' : '← Tasks'} onPress={() => openView($, back, null)} />
          <Text bold>{t ? `[${t.num}] ${t.title}` : taskId}</Text>
          {t ? statusPill(t.status, 'st') : null}
        </Box>
        <Box gap={1} alignItems="center">
          <Button key="tab-overview" label="Overview" variant={tab === 'file' ? 'primary' : undefined} onPress={() => openView($, 'file', taskId)} />
          <Button key="tab-chat" label={t?.status === 'waiting-input' ? 'Chat · answer' : 'Chat'} variant={tab === 'chat' ? 'primary' : undefined} onPress={() => openView($, 'chat', taskId)} />
          <Button key="tab-logs" label="Logs" variant={tab === 'logs' ? 'primary' : undefined} onPress={() => openView($, 'logs', taskId)} />
          {isDesktop ? <Button key="tab-graph" label="🔍 Graph" onPress={() => showInGraph($, taskId)} /> : null}
          <Button key="tab-refresh" label="Refresh" onPress={() => openView($, tab, taskId)} />
        </Box>
      </Box>
    )
  }

  if (v.name === 'file' && v.taskId) {
    const f = await read($, file)
    const t = byId.get(v.taskId)
    const dependents = rows.filter(r => r.blockers.some(x => x.id === v.taskId))
    const chip = (r: { id: string; num: string; status: string }, key: string) => (
      <Button key={key} plain label={`[${r.num}] ${STATUS_LABEL[r.status] ?? r.status}`} onPress={() => openView($, 'file', r.id)} />
    )
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {taskBar(v.taskId, 'file')}
        {t ? (
          <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor={STATUS_TONE[t.status] ?? '#3a3b3f'}>
            <Text color={STATUS_TONE[t.status] ?? '#8b949e'}>
              {`● ${STATUS_LABEL[t.status] ?? t.status}${t.profile ? ` · ${t.profile}` : ''}${t.worker ? ` · worker ${t.worker}` : ''}`}
            </Text>
            <Text dimColor>
              {`updated ${stamp(t.updated) || '-'} · started ${stamp(t.start) || '-'} · ended ${stamp(t.end) || '-'} · duration ${t.duration || '-'} · last run ${t.lastRun || '-'} · tokens ${t.tokens} · retries ${t.retries}`}
            </Text>
            {t.error ? <Text color="#f85149">{fit(t.error, 3000)}</Text> : null}
            {t.interaction?.question ? <Text color="#e3b341">{`Question: ${fit(t.interaction.question, 3000)}`}</Text> : null}
            {t.blockers.length ? (
              <Box gap={1} flexWrap="wrap" alignItems="center">
                <Text dimColor>Depends on</Text>
                {t.blockers.map(x => chip(x, `ov-b-${x.id}`))}
              </Box>
            ) : null}
            {dependents.length ? (
              <Box gap={1} flexWrap="wrap" alignItems="center">
                <Text dimColor>Needed by</Text>
                {dependents.map(r => chip(r, `ov-d-${r.id}`))}
              </Box>
            ) : null}
          </Box>
        ) : null}
        {!f ? <Text dimColor>Loading…</Text> : f.error ? <Text color="#f85149">{f.error}</Text> : <Box flexDirection="column" gap={1}>
            {f.content.length > FILE_CHUNK ? (
              <Box gap={1} alignItems="center">
                <Button key="f-prev" label="‹ Prev" dimColor={(f.offset ?? 0) === 0} onPress={() => update($, file, x => (x ? { ...x, offset: Math.max(0, (x.offset ?? 0) - FILE_CHUNK) } : x))} />
                <Text dimColor>{`part ${Math.floor((f.offset ?? 0) / FILE_CHUNK) + 1}/${Math.ceil(f.content.length / FILE_CHUNK)}`}</Text>
                <Button key="f-next" label="Next ›" onPress={() => update($, file, x => (x && (x.offset ?? 0) + FILE_CHUNK < x.content.length ? { ...x, offset: (x.offset ?? 0) + FILE_CHUNK } : x))} />
              </Box>
            ) : null}
            <Markdown text={f.content.slice(f.offset ?? 0, (f.offset ?? 0) + FILE_CHUNK) || ' '} />
          </Box>}
      </Box>
    )
  }

  // ----- chat / input -----
  if (v.name === 'chat' && v.taskId) {
    const c = await read($, chat)
    const t = byId.get(v.taskId)
    const values = await read($, answers)
    const questions = t?.status === 'waiting-input' && t.interaction?.questions?.length ? t.interaction.questions : null
    const sendLabel = t?.status === 'waiting-input' ? 'Send answer' : t?.status === 'running' ? 'Steer' : 'Continue task'
    // Newest messages that fit the tree budget, each clipped to the text bound.
  const messages: { id: string; role: string; label?: string; status?: string; text: string }[] = []
  let budget = 50000
  for (const m of [...(c?.messages ?? [])].reverse()) {
    const text = m.role === 'tool' ? fit(m.text.split('\n').slice(-20).join('\n'), 3000, true) : fit(m.text, 6000, true)
    if (messages.length >= 40 || (budget -= text.length + 300) < 0) break
    messages.unshift({ ...m, text })
  }
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {taskBar(v.taskId, 'chat')}
        {!c ? <Text dimColor>Loading…</Text> : null}
        {c?.error ? <Text color="#f85149">{c.error}</Text> : null}
        {c && !c.messages.length ? <Text dimColor>No local execution messages yet. Messages appear when the runner starts the task.</Text> : null}
        {c?.truncated ? <Text dimColor>Older messages are truncated; showing the latest.</Text> : null}
        <Box flexDirection="column" gap={1}>
          {messages.map(m => {
            const who = m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Agent' : m.role === 'tool' ? 'Tool' : 'System'
            const label = `${who}${m.label ? ` · ${clip(m.label, 120)}` : ''}${m.status ? ` · ${m.status}` : ''}`
            const color = m.role === 'user' ? '#58a6ff' : m.role === 'assistant' ? '#3fb950' : '#8b949e'
            return (
              <Box key={m.id} flexDirection="column" paddingLeft={1} borderStyle="single" borderColor={color}>
                <Text bold color={color}>{label}</Text>
                {m.role === 'tool' ? <Code source={m.text || ' '} wrap="truncate-end" /> : <Markdown text={m.text || ' '} />}
              </Box>
            )
          })}
        </Box>
        {t?.status === 'waiting-input' && !questions ? <Text color="#d29922">{t.interaction?.question || 'Waiting for your answer'}</Text> : null}
        {t && b.dashboardUrl ? (
          <Box flexDirection="column" gap={1} paddingBottom={1}>
            {(questions ?? [{ id: 'prompt', question: t.status === 'running' ? 'Instruction for the running agent' : t.status === 'waiting-input' ? 'Answer' : 'Instruction to continue the task', header: null }]).map(q => (
              <Box key={`answer-row-${q.id}`} flexDirection="column">
                <Text dimColor>{q.header ? `${q.header}: ${q.question}` : q.question}</Text>
                {/* A column box stretches the field across the pane; its submit button sits at the right end. */}
                <Box flexDirection="column" flexGrow={1} width="100%">
                  <Input
                    key={`answer-${q.id}`}
                    placeholder="Type here"
                    value={values[q.id] ?? ''}
                    submitLabel={questions && questions.length > 1 ? '↵' : sendLabel}
                    onInput={text => update($, answers, a => ({ ...a, [q.id]: text }))}
                    onSubmit={async text => {
                      await update($, answers, a => ({ ...a, [q.id]: text }))
                      if (!questions || questions.length === 1) await sendInput($, t)
                    }}
                  />
                </Box>
              </Box>
            ))}
            {questions && questions.length > 1 ? (
              <Box justifyContent="flex-end">
                <Button key="send" label={sendLabel} variant="primary" onPress={() => sendInput($, t)} />
              </Box>
            ) : null}
          </Box>
        ) : (
          <Text dimColor>Input needs the running runner (/todo:start).</Text>
        )}
      </Box>
    )
  }

  // ----- logs -----
  if (v.name === 'logs') {
    const l = await read($, logs)
    const room = Math.max(10, height - 14)
    const lines = (l?.content ?? '').split('\n')
    const start = Math.max(0, lines.length - room - (l?.offset ?? 0))
    const visible = fit(lines.slice(start, start + room).map(line => clip(line, 400)).join('\n'), MAX_TEXT, true)
    const t = v.taskId ? byId.get(v.taskId) : null
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {v.taskId ? (
          taskBar(v.taskId, 'logs')
        ) : (
          <Box gap={1} alignItems="center">
            <Button key="back" label="← Back" onPress={() => openView($, 'tasks', null)} />
            <Text bold>All logs</Text>
          </Box>
        )}
        {!l ? <Text dimColor>Loading…</Text> : null}
        {l?.error ? <Text color="#f85149">{l.error}</Text> : null}
        {l && !l.entries.length ? <Text dimColor>No logs yet.</Text> : null}
        {l && l.entries.length ? (
          <Box gap={2}>
            <Box flexDirection="column" width={Math.min(48, Math.floor(cols / 3))}>
              {l.entries.slice(0, 60).map((entry, i) => (
                <Button
                  key={`log-${i}`}
                  plain
                  label={clip(`${i === l.selected ? '▸ ' : '  '}${entry.scope === 'runner' ? 'runner' : `${entry.taskId?.split('-')[0] ?? ''} · ${String(entry.attempt ?? '').replace(/^attempt-0*/, '#').slice(0, 6)}`} · ${entry.label} · ${bytes(entry.size)}`, Math.min(48, Math.floor(cols / 3)))}
                  onPress={() => openLog($, i)}
                />
              ))}
            </Box>
            <Box flexDirection="column" flexGrow={1}>
              {l.selected !== null ? (
                <Box gap={1}>
                  <Text dimColor>{`${l.entries[l.selected]?.label ?? ''} · lines ${start + 1}-${Math.min(lines.length, start + room)} of ${lines.length}`}</Text>
                  <Button key="older" label="▲ Older" onPress={() => update($, logs, x => (x ? { ...x, offset: Math.min(Math.max(0, lines.length - room), x.offset + room) } : x))} />
                  <Button key="newer" label="▼ Newer" onPress={() => update($, logs, x => (x ? { ...x, offset: Math.max(0, x.offset - room) } : x))} />
                  <Button key="reload" label="Reload" onPress={() => openLog($, l.selected as number)} />
                </Box>
              ) : null}
              <Code source={visible || 'Select a log'} wrap="truncate-end" />
            </Box>
          </Box>
        ) : null}
      </Box>
    )
  }

  // ----- task graph -----
  // The graph is a drawing only the desktop shows; a terminal stays on the table.
  if (v.name === 'graph' && isDesktop) {
    const mode = await read($, graph)
    let nodes = graphNodes(rows, mode)
    const edgeCount = (list: Row[]) => {
      const ids = new Set(list.map(t => t.id))
      return list.reduce((n, t) => n + t.blockers.filter(b => ids.has(b.id)).length, 0)
    }
    // The drawing is part of the tree, which holds at most 100,000 characters.
    const allNodes = nodes.length
    let scene = isDesktop && Svg ? graphScene(nodes, mode.focus, mode.target ?? null) : null
    while (scene && scene.body.length > 72000 && nodes.length > 10) {
      nodes = nodes.slice(0, Math.floor(nodes.length * 0.75))
      scene = graphScene(nodes, mode.focus, mode.target ?? null)
    }
    // A fixed frame the size of the pane; the view pans and zooms inside it.
    const frame = { width: Math.max(480, cols * 8), height: isDesktop ? fillPx : 600 }
    const savedView = await read($, graphView)
    const view = scene ? savedView ?? openingView(scene, frame, nodes, mode.target ?? null) : null
    const svg = scene && view ? graphSvg(scene, frame, view) : ''
    const moveView = (fn: (x: GraphView) => GraphView) => update($, graphView, x => fn(x ?? (view as GraphView)))
    // Arrows move the drawing itself: ← moves the graph left, so the window moves right.
    const step = (axis: 'cx' | 'cy', sign: number) => () =>
      moveView(x => ({ ...x, [axis]: x[axis] - sign * 0.1 * (axis === 'cx' ? frame.width : frame.height) / x.zoom }))
    const zoomBy = (factor: number) => () => moveView(x => ({ ...x, zoom: Math.max(0.15, Math.min(4, x.zoom * factor)) }))
    const setMode = async (next: GraphMode) => {
      await update($, graph, () => ({ target: null, ...next }))
      await update($, graphView, () => null)
    }
    const focused = mode.focus ? byId.get(mode.focus) : undefined
    const selectedTask = (mode.target ? byId.get(mode.target) : undefined) ?? focused
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        <Box gap={1} alignItems="center" flexWrap="wrap">
          <Button key="back" label="← Back" onPress={() => openView($, 'tasks', null)} />
          <Text bold>Task graph</Text>
          <Button key="graph-active" label="Active + dependencies" variant={!mode.focus && mode.scope === 'active' ? 'primary' : undefined} onPress={() => setMode({ scope: 'active', focus: null })} />
          <Button key="graph-all" label="All history" variant={!mode.focus && mode.scope === 'all' ? 'primary' : undefined} onPress={() => setMode({ scope: 'all', focus: null })} />
          <Select
            key="graph-focus"
            label="Focus"
            value={mode.focus ?? ''}
            options={[{ value: '', label: '(none)' }, ...nodes.map(t => ({ value: t.id, label: `${t.num} ${clip(t.title, 50)} · ${t.status}` }))]}
            onSelect={value => setMode({ ...mode, focus: value || null })}
          />
          {selectedTask ? <Button key="graph-details" label={`Details ${selectedTask.num}`} variant="primary" onPress={() => openView($, 'file', selectedTask.id, 'graph')} /> : null}
        </Box>
        <Text dimColor>{`${nodes.length} tasks · ${edgeCount(nodes)} dependencies · arrows run from a blocker to the task that waited for it${nodes.length < allNodes ? ` · newest ${nodes.length} of ${allNodes} shown (Focus narrows it)` : nodes.length >= GRAPH_LIMIT ? ` · newest ${GRAPH_LIMIT} shown` : ''}`}</Text>
        {!nodes.length ? <Text dimColor>No dependencies to show. Closed tasks recorded before dependency history keep only the edges listed in their Dependencies section.</Text> : null}
        {svg && view ? (
          <Box gap={1} alignItems="center" flexWrap="wrap">
            <Button key="g-left" label="←" onPress={step('cx', -1)} />
            <Button key="g-up" label="↑" onPress={step('cy', -1)} />
            <Button key="g-down" label="↓" onPress={step('cy', 1)} />
            <Button key="g-right" label="→" onPress={step('cx', 1)} />
            <Button key="g-zoom-out" label="−" onPress={zoomBy(1 / 1.3)} />
            <Button key="g-zoom-in" label="+" onPress={zoomBy(1.3)} />
            <Button key="g-fit" label="Fit" onPress={() => update($, graphView, () => (scene ? fitView(scene, frame) : null))} />
            <Button key="g-center" label="Center" onPress={() => update($, graphView, () => null)} />
            <Button key="g-actual" label="100%" onPress={() => moveView(x => ({ ...x, zoom: 1 }))} />
            <Button key="g-taller" label="Taller" onPress={() => adjustRowPx($, 1)} />
            <Button key="g-shorter" label="Shorter" onPress={() => adjustRowPx($, -1)} />
            <Text dimColor>{`${Math.round(view.zoom * 100)}%`}</Text>
          </Box>
        ) : null}
        {svg && scene && view ? (
          <Box key="graph-frame" position="relative" flexDirection="column">
            <Svg source={svg} alt={`Task graph: ${nodes.length} tasks, ${edgeCount(nodes)} dependencies`} width={frame.width} height={frame.height} isInteractive />
          </Box>
        ) : null}
      </Box>
    )
  }

  // ----- settings -----
  if (v.name === 'settings') {
    const d = await read($, draft)
    const s = await read($, settings)
    if (!d || !s) return <Box flexDirection="column" gap={1}>{header}<Text dimColor>Loading settings…</Text></Box>
    const setValues = (fn: (x: Settings['values']) => Settings['values']) => update($, draft, x => (x ? { ...x, values: fn(x.values) } : x))
    const single = d.values.git.executionMode === 'single-branch'
    const dirty = JSON.stringify(d.values) !== JSON.stringify(s.values)
    const problems = localProblems(d.values.modelProfiles, d.values.defaultModelProfile, s.modelCatalog)
    const LABEL = 26
    const CONTROL = 36
    // One aligned row: a label column, the control, and a dim hint.
    const field = (label: string, control: unknown, hint?: string) => (
      <Box key={`row-${label}`} alignItems="center" gap={1}>
        <Box width={LABEL} flexShrink={0}><Text>{label}</Text></Box>
        <Box width={CONTROL} flexShrink={0} flexDirection="column">{control as never}</Box>
        {hint ? <Text dimColor>{hint}</Text> : null}
      </Box>
    )
    const section = (title: string, children: unknown, aside?: unknown) => (
      <Box key={`section-${title}`} flexDirection="column" gap={1} paddingX={1} paddingY={1} borderStyle="round" borderColor="#30363d">
        <Box gap={2} alignItems="center">
          <Text bold>{title}</Text>
          {aside as never}
        </Box>
        {children as never}
      </Box>
    )
    const numeric = (key: 'workers' | 'retries' | 'pollIntervalMs' | 'configReloadIntervalMs', label: string, hint: string) =>
      field(label, (
        <Input
          key={`set-${key}`}
          value={String(d.values[key])}
          submitLabel="↵"
          onSubmit={text => setValues(x => ({ ...x, [key]: Number.parseInt(text, 10) }))}
          onInput={text => setValues(x => ({ ...x, [key]: Number.parseInt(text, 10) }))}
        />
      ), hint)
    const COLS = { name: 20, model: 34, effort: 12, state: 14 }
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        <Box gap={1} alignItems="center">
          <Button key="back" label="← Back" onPress={() => openView($, 'tasks', null)} />
          <Text bold>Settings</Text>
          <Text dimColor>.todo/config.json · other fields are kept</Text>
        </Box>
        {s.warning ? <Text color="#d29922">{s.warning}</Text> : null}

        {section('Runner', (
          <Box flexDirection="column" gap={1}>
            {numeric('workers', 'Workers', '1–32 parallel tasks')}
            {numeric('retries', 'Retries', '-1 retries without limit')}
            {numeric('pollIntervalMs', 'Task poll interval', 'ms, 250–60000')}
            {numeric('configReloadIntervalMs', 'Config reload interval', 'ms, 250–60000')}
            {field('Default model profile', (
              <Select
                key="set-profile"
                value={d.values.defaultModelProfile}
                options={d.values.modelProfiles.filter(p => PROFILE_NAME.test(p.name)).map(p => ({ value: p.name }))}
                onSelect={value => setValues(x => ({ ...x, defaultModelProfile: value }))}
              />
            ), 'for tasks created without one')}
          </Box>
        ))}

        {section('Git', (
          <Box flexDirection="column" gap={1}>
            {field('Execution mode', (
              <Select
                key="set-mode"
                value={d.values.git.executionMode}
                options={[{ value: 'worktree', label: 'Isolated worktrees' }, { value: 'single-branch', label: 'Single branch' }]}
                onSelect={value => setValues(x => ({ ...x, git: { ...x.git, executionMode: value, push: value === 'single-branch' ? false : x.git.push } }))}
              />
            ), single ? 'one worker, commits locally in the current branch' : undefined)}
            {!single ? (
              <Box flexDirection="column" gap={1}>
                {field('Delivery', (
                  <Select
                    key="set-delivery"
                    value={d.values.git.delivery}
                    options={[{ value: 'merge', label: 'Merge into target branch' }, { value: 'keep', label: 'Keep task branch' }]}
                    onSelect={value => setValues(x => ({ ...x, git: { ...x.git, delivery: value } }))}
                  />
                ))}
                {field('Target branch', (
                  <Select
                    key="set-branch"
                    value={d.values.git.targetBranch ?? ''}
                    options={[{ value: '', label: '(branch active at preflight)' }, ...Array.from(new Set([...(d.values.git.targetBranch ? [d.values.git.targetBranch] : []), ...s.branches.filter(n => !n.startsWith('codex/todo-') && !n.startsWith('claude/todo-'))])).map(n => ({ value: n }))]}
                    onSelect={value => setValues(x => ({ ...x, git: { ...x.git, targetBranch: value || null } }))}
                  />
                ))}
                {field('Remote', (
                  <Input
                    key="set-remote"
                    value={d.values.git.remote}
                    submitLabel="↵"
                    onInput={text => setValues(x => ({ ...x, git: { ...x.git, remote: text.trim() } }))}
                    onSubmit={text => setValues(x => ({ ...x, git: { ...x.git, remote: text.trim() } }))}
                  />
                ))}
                {field('Push after delivery', (
                  <Select
                    key="set-push"
                    value={d.values.git.push ? 'yes' : 'no'}
                    options={[{ value: 'no' }, { value: 'yes' }]}
                    onSelect={value => setValues(x => ({ ...x, git: { ...x.git, push: value === 'yes' } }))}
                  />
                ))}
              </Box>
            ) : null}
          </Box>
        ))}

        {section('Model profiles', (
          <Box flexDirection="column" gap={1}>
            <Box gap={1} paddingX={1}>
              <Box width={COLS.name} flexShrink={0}><Text dimColor>Name</Text></Box>
              <Box width={COLS.model} flexShrink={0}><Text dimColor>Model</Text></Box>
              <Box width={COLS.effort} flexShrink={0}><Text dimColor>Effort</Text></Box>
              <Box width={COLS.state} flexShrink={0}><Text dimColor>Status</Text></Box>
            </Box>
            {d.values.modelProfiles.map((p, i) => {
              const entry = catalogEntry(s.modelCatalog, p.model)
              const efforts = effortsOf(s.modelCatalog, p.model)
              const mine = problems.filter(x => x.index === i)
              const used = s.profileUsage[p.name]?.length ?? 0
              const state = !s.modelCatalog ? '… loading' : entry ? '✓ listed' : '✗ not listed'
              const stateColor = !s.modelCatalog ? '#d29922' : entry ? '#3fb950' : '#f85149'
              const setProfile = (fn: (x: ModelProfile) => ModelProfile) =>
                setValues(x => ({ ...x, modelProfiles: x.modelProfiles.map((q, j) => (j === i ? fn(q) : q)) }))
              return (
                <Box key={`p-${i}`} flexDirection="column" gap={1} paddingX={1} paddingY={1} backgroundColor={mine.length ? '#2d1517' : i % 2 ? '#161b22' : undefined}>
                  <Box gap={1} alignItems="center">
                    <Box width={COLS.name} flexShrink={0} flexDirection="column">
                      <Input key={`p-name-${i}`} value={p.name} submitLabel="↵"
                        onInput={text => setProfile(x => ({ ...x, name: text.trim() }))}
                        onSubmit={text => setProfile(x => ({ ...x, name: text.trim() }))} />
                    </Box>
                    <Box width={COLS.model} flexShrink={0} flexDirection="column">
                      <Select key={`p-model-${i}`} value={p.model}
                        options={[
                          ...((s.modelCatalog?.models ?? []).some(m => m.model === p.model) || !p.model ? [] : [{ value: p.model, label: entry ? `${entry.displayName} (${p.model})` : `${p.model} (not in list)` }]),
                          ...(s.modelCatalog?.models ?? []).map(m => ({ value: m.model, label: `${m.displayName} · ${m.model}` })),
                        ]}
                        onSelect={value => {
                          const allowed = effortsOf(s.modelCatalog, value)
                          return setProfile(x => ({ ...x, model: value, reasoningEffort: allowed.includes(x.reasoningEffort) ? x.reasoningEffort : allowed.includes('high') ? 'high' : allowed[0] }))
                        }} />
                    </Box>
                    <Box width={COLS.effort} flexShrink={0} flexDirection="column">
                      <Select key={`p-effort-${i}`} value={p.reasoningEffort}
                        options={efforts.map(x => ({ value: x }))}
                        onSelect={value => setProfile(x => ({ ...x, reasoningEffort: value }))} />
                    </Box>
                    <Box width={COLS.state} flexShrink={0}><Text color={stateColor}>{state}</Text></Box>
                    {d.values.defaultModelProfile === p.name ? <Text color="#58a6ff">default</Text> : null}
                    {used ? (
                      <Text dimColor>{`in use by ${used} open task${used > 1 ? 's' : ''}`}</Text>
                    ) : (
                      <Button key={`p-remove-${i}`} plain label="✕ Remove" onPress={() => setValues(x => ({ ...x, modelProfiles: x.modelProfiles.filter((_, j) => j !== i) }))} />
                    )}
                  </Box>
                  <Box gap={1} alignItems="center">
                    <Box width={COLS.name} flexShrink={0}><Text dimColor>Description</Text></Box>
                    <Box width={COLS.model + COLS.effort + COLS.state + 2} flexShrink={0} flexDirection="column">
                    <Input key={`p-desc-${i}`} value={p.description ?? ''} placeholder="When to use this profile" submitLabel="↵"
                      onInput={text => setProfile(x => ({ ...x, description: text }))}
                      onSubmit={text => setProfile(x => ({ ...x, description: text }))} />
                    </Box>
                  </Box>
                  {mine.map((x, k) => <Text key={`p-err-${i}-${k}`} color="#f85149">{fit(x.message, 600)}</Text>)}
                </Box>
              )
            })}
            {problems.filter(x => x.index === undefined).map((x, k) => <Text key={`p-gerr-${k}`} color="#f85149">{x.message}</Text>)}
          </Box>
        ), (
          <Box gap={1} alignItems="center">
            <Text dimColor>{s.profilesInherited ? 'plugin defaults until saved' : `${d.values.modelProfiles.length} profiles`}</Text>
            <Button key="p-add" label="+ Add profile" onPress={async () => {
              await setValues(x => {
                let name = 'custom'
                for (let i = 2; x.modelProfiles.some(p => p.name === name); i += 1) name = `custom-${i}`
                return { ...x, modelProfiles: [...x.modelProfiles, { name, model: s.modelCatalog?.models[0]?.model ?? 'claude-sonnet-5-5', reasoningEffort: 'medium', description: '' }] }
              })
            }} />
            <Button key="p-check" label="Reload model list" onPress={() => refreshModels($, true)} />
            <Text dimColor>{s.loadingModels ? 'loading the Claude CLI model list…' : s.modelCatalog ? `${s.modelCatalog.models.length} models from the Claude CLI` : ''}</Text>
          </Box>
        ))}

        <Box gap={1} alignItems="center">
          <Button key="save" label="Save" variant="primary" onPress={() => saveSettings($)} />
          <Button key="reset" label="Reset" dimColor={!dirty} onPress={() => update($, draft, () => s)} />
          <Button key="reload" label="Reload" onPress={() => openView($, 'settings', null)} />
          {dirty ? <Text color="#d29922">unsaved changes</Text> : null}
        </Box>
      </Box>
    )
  }

  // ----- tasks table -----
  const f = await read($, filter)
  const s = await read($, sort)
  const p = await read($, page)
  const shown = sorted(rows.filter(t => matches(t, f)), s)

  // Fit columns to the pane: drop the least important until the title keeps 24 columns.
  const dropped = new Set<string>()
  const fixed = () => COLUMNS.filter(c => !dropped.has(c.field) && c.width > 0).reduce((sum, c) => sum + c.width + 1, 0)
  for (const field of DROP_ORDER) {
    if (cols - fixed() >= 28) break
    dropped.add(field)
  }
  const columns = COLUMNS.filter(c => !dropped.has(c.field))
  const titleWidth = Math.max(16, cols - fixed() - 2)
  const width = (c: Column) => (c.field === 'title' ? titleWidth : c.width)

  const statuses = STATUS_ORDER.filter(st => rows.some(t => t.status === st))

  const cell = (t: Row, c: Column) => {
    const w = width(c)
    switch (c.field) {
      case 'id':
        return t.hasFile ? (
          <Button key={`id-${t.id}`} plain label={t.num} onPress={() => openView($, 'file', t.id, 'tasks')} />
        ) : (
          <Text>{t.num}</Text>
        )
      case 'title':
        return <Button key={`title-${t.id}`} plain label={clip(t.title, w)} onPress={() => openView($, 'file', t.id, 'tasks')} />
      case 'status':
        return (
          <Text color={COLOR[t.status] ?? undefined} bold hover={{ underline: true }}>
            {clip(`● ${t.status}`, w)}
          </Text>
        )
      case 'worker':
        return <Text>{t.worker ?? ''}</Text>
      case 'profile':
        return t.profile ? (
          <Button key={`profile-${t.id}`} plain label={clip(t.profile, w)} onPress={() => update($, filter, q => addFilter(q, 'profile', t.profile))} />
        ) : (
          <Text> </Text>
        )
      case 'blockers':
        return (
          <Box gap={1}>
            {t.blockers.slice(0, 3).map(bl => (
              <Button key={`bl-${t.id}-${bl.id}`} plain label={bl.num} dimColor={bl.status === 'completed'} onPress={() => openView($, 'file', bl.id)} />
            ))}
            {t.blockers.length > 3 ? <Text dimColor>+{t.blockers.length - 3}</Text> : null}
          </Box>
        )
      case 'updated':
        return <Text dimColor>{stamp(t.updated)}</Text>
      case 'start':
        return <Text dimColor>{stamp(t.start)}</Text>
      case 'end':
        return <Text dimColor>{stamp(t.end)}</Text>
      case 'duration':
        return <Text>{t.duration}</Text>
      case 'lastRun':
        return <Text>{t.lastRun}</Text>
      case 'tokens':
        return <Text>{t.tokensTotal >= 1e6 ? `${(t.tokensTotal / 1e6).toFixed(1)}M` : t.tokensTotal >= 1e3 ? `${Math.round(t.tokensTotal / 1e3)}k` : t.tokens}</Text>
      case 'retries':
        return <Text dimColor={t.retriesTotal === 0}>{t.retries}</Text>
      case 'error':
        return <Text color="#f85149">{clip(t.error, w)}</Text>
      case 'actions':
        return (
          <Box gap={1}>
            <Button key={`details-${t.id}`} label="ⓘ" variant={t.status === 'waiting-input' ? 'primary' : undefined} onPress={() => openView($, t.status === 'waiting-input' ? 'chat' : 'file', t.id, 'tasks')} />
            {isDesktop ? <Button key={`graph-${t.id}`} label="🔍" onPress={() => showInGraph($, t.id)} /> : null}
          </Box>
        )
      default:
        return <Text> </Text>
    }
  }

  // One page of the table; the page shrinks until the tree fits the engine's
  // bounds (100,000 serialized characters per tree).
  const build = (pageSize: number) => {
    const pages = Math.max(1, Math.ceil(shown.length / pageSize))
    const current = Math.min(p, pages - 1)
    const slice = shown.slice(current * pageSize, current * pageSize + pageSize)
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {isDesktop && Svg ? <Svg source={overview(b, cols * 8)} alt="ToDo overview" /> : null}
        <Box gap={1} alignItems="center" flexWrap="wrap">
          <Input
            key="filter"
            label="Filter"
            placeholder="status:failed|blocked profile:advanced text…"
            value={f}
            submitLabel="Apply"
            onInput={text => update($, filter, () => text)}
            onSubmit={async text => {
              await update($, filter, () => text)
              await update($, page, () => 0)
            }}
          />
          <Button key="clear" label="Clear" onPress={() => update($, filter, () => '')} />
          {statuses.map(st => (
            <Button key={`chip-${st}`} plain label={`● ${st} ${rows.filter(t => t.status === st).length}`} onPress={async () => {
              await update($, filter, q => addFilter(q, 'status', st))
              await update($, page, () => 0)
            }} />
          ))}
        </Box>
        <Box flexDirection="column">
          <Box gap={1} paddingX={1} backgroundColor="#161b22">
            {columns.map(c => (
              <Box key={`h-${c.field}`} width={width(c)} flexShrink={0}>
                {c.sortable ? (
                  <Button
                    key={`sort-${c.field}`}
                    plain
                    label={`${c.label}${s.field === c.field ? (s.dir === 'asc' ? ' ↑' : ' ↓') : ''}`}
                    onPress={() => update($, sort, x => ({ field: c.field, dir: x.field === c.field && x.dir === 'asc' ? 'desc' : 'asc' }))}
                  />
                ) : (
                  <Text> </Text>
                )}
              </Box>
            ))}
          </Box>
          {slice.map((t, i) => (
            <Box key={`row-${t.id}`} gap={1} paddingX={1} backgroundColor={i % 2 ? '#0d1117' : undefined} hover={{ backgroundColor: '#1f2937' }}>
              {columns.map(c => (
                <Box key={`c-${t.id}-${c.field}`} width={width(c)} flexShrink={0} overflow="hidden">
                  {c.field === 'status' ? (
                    <Button key={`status-${t.id}`} plain label={clip(`● ${t.status}`, width(c))} onPress={() => update($, filter, q => addFilter(q, 'status', t.status))} />
                  ) : (
                    cell(t, c)
                  )}
                </Box>
              ))}
            </Box>
          ))}
          {!slice.length ? <Text dimColor>No tasks match the filter.</Text> : null}
        </Box>
        <Box gap={1} alignItems="center">
          <Button key="prev" label="‹ Prev" dimColor={current === 0} onPress={() => update($, page, x => Math.max(0, x - 1))} />
          <Text dimColor>{`page ${current + 1}/${pages} · ${shown.length} of ${rows.length} tasks${dropped.size ? ` · hidden columns: ${[...dropped].join(', ')} (widen the pane)` : ''}`}</Text>
          <Button key="next" label="Next ›" dimColor={current >= pages - 1} onPress={() => update($, page, x => Math.min(pages - 1, x + 1))} />
          {isDesktop ? <Button key="t-taller" label="Taller" onPress={() => adjustRowPx($, 1)} /> : null}
          {isDesktop ? <Button key="t-shorter" label="Shorter" onPress={() => adjustRowPx($, -1)} /> : null}
        </Box>
      </Box>
    )
  }
  let size = Math.max(5, Math.min(MAX_ROWS, isDesktop ? Math.floor((fillPx - 3 * TABLE_ROW_PX) / TABLE_ROW_PX) : height - CHROME_ROWS))
  let tree = build(size)
  while (size > 5 && treeSize(tree) > TREE_BUDGET) {
    size = Math.max(5, Math.floor(size * 0.7))
    tree = build(size)
  }
  return tree
}

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'todo-dashboard', description: 'Open the ToDo dashboard in a pane' })
    const savedRowPx = Number(await $.store.get('rowPx').catch(() => undefined))
    if (savedRowPx >= 8 && savedRowPx <= 60) await update($, rowPx, () => savedRowPx)
    void poll($)
    $.clock.every(POLL_MS, () => poll($))
    return next(e)
  })

  on('command.run', { command: 'todo-dashboard' }, async $ => {
    await $.ui.open({ id: PANE, title: 'ToDo', focus: true })
    return { text: 'ToDo dashboard opened.' }
  })

  // Always above the prompt while ToDo is active: one button per task state
  // with its count, each opening the dashboard table filtered to that state.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const b = await read($, board)
    if (e.props.hasSurvey || !b.active) return next(e)
    const rows = (b.tasks ?? []).filter(t => !CLOSED.has(t.status))
    const count = (statuses: string) => rows.filter(t => statuses.split('|').includes(t.status)).length
    const parts = [
      { key: 'running', mark: '🔵', label: 'running', filter: 'running', color: STATUS_TONE.running },
      { key: 'waiting', mark: '🟡', label: 'waiting', filter: 'waiting-input', color: STATUS_TONE['waiting-input'] },
      { key: 'failed', mark: '🔴', label: 'failed', filter: 'failed|merge-conflict', color: STATUS_TONE.failed },
      { key: 'queued', mark: '⚪', label: 'queued', filter: 'queued', color: STATUS_TONE.queued },
      { key: 'blocked', mark: '🟠', label: 'blocked', filter: 'blocked', color: STATUS_TONE.blocked },
      { key: 'merging', mark: '🟣', label: 'merging', filter: 'merge-queued', color: STATUS_TONE['merge-queued'] },
    ].map(x => ({ ...x, n: count(x.filter) })).filter(x => x.n > 0)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box gap={1} alignItems="center">
        <Button key="open" plain label="ToDo" onPress={() => openDashboard($, '')} />
        {/* A Button takes no color: its colored circle opens the filter, the count beside it is colored Text. */}
        {parts.map(x => (
          <Box key={`band-box-${x.key}`} alignItems="center" gap={1}>
            <Button key={`band-${x.key}`} label={x.mark} onPress={() => openDashboard($, `status:${x.filter}`)} />
            <Text color={x.color}>{`${x.n} ${x.label}`}</Text>
          </Box>
        ))}
        {!parts.length ? <Text dimColor>idle</Text> : null}
        {!b.runner?.alive ? <Text color={STATUS_TONE.failed}>runner off</Text> : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, drawPane)
  // Panes the desktop restores from the first preview of this mod.
  on('ui.render', { component: 'Pane', requestId: 'todo-live' }, drawPane)
}
