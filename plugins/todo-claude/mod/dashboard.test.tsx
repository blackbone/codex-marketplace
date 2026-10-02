import { expect, test } from 'claude-code/testing'

// Synthetic backend answers standing in for scripts/mod-api.mjs.
const row = (id: string, title: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  num: id.split('-')[0],
  title,
  status,
  worker: null,
  profile: 'advanced',
  profileTooltip: '',
  blockers: [],
  updated: '2026-10-02T12:00:00.000Z',
  start: '',
  end: '',
  durationMs: -1,
  duration: '',
  lastRunMs: -1,
  lastRun: '',
  tokens: '—',
  tokensTitle: '',
  tokensTotal: -1,
  retries: 'M0 D0',
  retriesTitle: '',
  retriesTotal: 0,
  error: '',
  hasFile: true,
  interaction: null,
  turnId: null,
  ...extra,
})

const STATUS = {
  active: true,
  repo: 'demo',
  config: { workers: 2, retries: 1, defaultModelProfile: 'advanced' },
  runner: { alive: true, status: 'running', pid: 42, pluginVersion: 'x', runtimeState: 'current', mergeWorker: 'idle' },
  dashboardUrl: 'http://127.0.0.1:9',
  taskCounts: { running: 1, queued: 1, failed: 1 },
  workers: [
    { id: 1, status: 'running', taskId: '2-run', taskTitle: 'Run thing' },
    { id: 2, status: 'idle', taskId: null, taskTitle: null },
  ],
  tasks: [
    row('1-fail', 'Broken build', 'failed', { error: 'make test failed' }),
    row('2-run', 'Run thing', 'running', { worker: 1, blockers: [{ id: '4-done', num: '4', status: 'completed' }] }),
    row('3-ask', 'Needs answer', 'waiting-input', {
      interaction: { state: 'waiting-input', question: 'Which branch?', questions: [], requestId: 'r1', updatedAt: 'u1' },
    }),
    row('4-done', 'Shipped', 'completed', { blockers: [{ id: '1-fail', num: '1', status: 'failed' }] }),
  ],
}

const ANSWERS: Record<string, unknown> = {
  status: STATUS,
  task: { id: '1-fail', filename: '1-fail.md', content: '# Broken build\n\nFix it.' },
  chat: { truncated: false, messages: [{ id: 'm1', source: 'chat', role: 'assistant', text: 'Working on it' }] },
  logs: { logs: [{ scope: 'task', taskId: '1-fail', attempt: 'attempt-001', file: 'stdout.log', label: 'Standard output', size: 10 }] },
  log: { content: 'line one\nline two' },
  settings: {
    revision: 'rev',
    values: {
      workers: 2,
      retries: 1,
      pollIntervalMs: 5000,
      configReloadIntervalMs: 5000,
      defaultModelProfile: 'advanced',
      git: { executionMode: 'worktree', delivery: 'merge', targetBranch: 'main', remote: 'origin', push: false },
      modelProfiles: [
        { name: 'fast', model: 'claude-sonnet-5-5', reasoningEffort: 'medium' },
        { name: 'advanced', model: 'claude-opus-5-5', reasoningEffort: 'high' },
      ],
    },
    profiles: ['fast', 'advanced'],
    profilesInherited: false,
    modelCatalog: {
      command: 'claude',
      checkedAt: '2026-10-02T12:00:00.000Z',
      error: null,
      models: [
        { model: 'claude-sonnet-5-5', aliases: ['sonnet'], displayName: 'Sonnet 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], supportsEffort: true },
        { model: 'claude-opus-5-5', aliases: ['opus'], displayName: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], supportsEffort: true },
        { model: 'claude-haiku-4-5-20251001', aliases: ['haiku'], displayName: 'Haiku 4.5', efforts: [], supportsEffort: false },
        { model: 'claude-sonnet-4-6', aliases: [], displayName: 'Sonnet 4.6', efforts: ['low', 'medium', 'high', 'max'], supportsEffort: true },
      ],
    },
    profileProblems: [],
    profileUsage: { advanced: ['1-fail'] },
    branches: ['main'],
  },
  models: null as unknown,
  action: { accepted: true },
  save: { ok: true },
}

ANSWERS.models = (ANSWERS.settings as { modelCatalog: unknown }).modelCatalog

const PANE = { title: 'ToDo', isFocused: true, bodyColumns: 200, placement: 'dock' as const }

test('the dashboard pane navigates and acts on every input surface', async ($, on) => {
  const calls: string[][] = []
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('session.cwd', async () => ({ value: '/repo' }))
  on('process.run', async (_$, e) => {
    const argv = [...e.argv]
    calls.push(argv)
    const answer = ANSWERS[argv[2]] ?? { error: 'unknown' }
    return { value: { exitCode: 0, stdout: `${JSON.stringify(answer)}\n`, stderr: '' } }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'todo',
      surface,
      component: 'Pane',
      requestId: 'todo-dashboard',
      props: PANE,
      viewport: { columns: 200, rows: 60 },
    })
    await ui.press({ key: 'nav-refresh' })
    expect(await ui.find({ type: 'Text', text: /ToDo — demo/ })).toBeDefined()

    // Table: rows, sorting, status filter chips.
    expect(await ui.find({ key: 'title-1-fail' })).toBeDefined()
    await ui.press({ key: 'sort-title' })
    await ui.press({ key: 'status-1-fail' })
    expect(await ui.find({ key: 'title-2-run' })).toBeUndefined()
    await ui.press({ key: 'clear' })
    expect(await ui.find({ key: 'title-2-run' })).toBeDefined()

    // Task file.
    await ui.press({ key: 'id-1-fail' })
    expect(await ui.find({ type: 'Markdown', text: /Fix it/ })).toBeDefined()
    await ui.press({ key: 'back' })

    // A task waiting for input opens on its Chat tab.
    await ui.press({ key: 'details-3-ask' })
    expect(await ui.find({ type: 'Text', text: /Which branch\?/ })).toBeDefined()
    await ui.input({ key: 'answer-prompt', text: 'main' })
    expect(calls.some(c => c[2] === 'action' && JSON.parse(c[4]).action === 'reply')).toBe(true)
    await ui.press({ key: 'back' })

    // Details: one task window with Overview, Chat and Logs tabs.
    await ui.press({ key: 'details-1-fail' })
    expect(await ui.find({ type: 'Text', text: /make test failed/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /Fix it/ })).toBeDefined()
    await ui.press({ key: 'tab-logs' })
    expect(await ui.find({ type: 'Code', text: /line two/ })).toBeDefined()
    await ui.press({ key: 'tab-chat' })
    expect(await ui.find({ type: 'Markdown', text: /Working on it/ })).toBeDefined()
    await ui.press({ key: 'tab-overview' })
    await ui.press({ key: 'back' })
    expect(await ui.find({ key: 'details-1-fail' })).toBeDefined()

    // Settings and model profiles.
    calls.length = 0
    await ui.press({ key: 'nav-settings' })
    await ui.select({ key: 'set-delivery', value: 'keep' })
    // A profile used by an open task cannot be removed; the other one can.
    expect(await ui.find({ key: 'p-remove-1' })).toBeUndefined()
    await ui.press({ key: 'p-add' })
    await ui.select({ key: 'p-model-2', value: 'claude-sonnet-4-6' })
    await ui.input({ key: 'p-name-2', text: 'Bad Name' })
    expect(await ui.find({ type: 'Text', text: /lowercase letters/ })).toBeDefined()
    await ui.press({ key: 'save' })
    expect(calls.some(c => c[2] === 'save')).toBe(false)
    expect(await ui.find({ type: 'Text', text: /fix the model profiles first/ })).toBeDefined()
    await ui.press({ key: 'p-check' })
    expect(calls.some(c => c[2] === 'models' && c[4] === 'force')).toBe(true)
    await ui.select({ key: 'p-model-2', value: 'claude-haiku-4-5-20251001' })
    await ui.select({ key: 'p-effort-2', value: 'low' })
    await ui.input({ key: 'p-name-2', text: 'quick' })
    await ui.press({ key: 'p-remove-0' })
    await ui.select({ key: 'set-profile', value: 'advanced' })
    await ui.press({ key: 'save' })
    const save = calls.find(c => c[2] === 'save')
    const saved = save && JSON.parse(save[4]).values
    expect(saved.git.delivery).toBe('keep')
    expect(saved.modelProfiles.map((p: { name: string }) => p.name)).toEqual(['advanced', 'quick'])
    expect(saved.modelProfiles[1]).toEqual({ name: 'quick', model: 'claude-haiku-4-5-20251001', reasoningEffort: 'low', description: '' })
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
})

test('a blocked runner points at the profiles that stop it', async ($, on) => {
  const blocked = {
    ...STATUS,
    runner: { ...STATUS.runner, alive: false, status: 'stopped' },
    dashboardUrl: null,
    profileProblems: [
      { profile: 'ultra', index: 1, field: 'model', message: "Model 'claude-opus-9-9' is not in the Claude CLI model list." },
      { profile: null, field: 'models', message: 'The Claude CLI model list has not been loaded yet.', unchecked: true },
    ],
  }
  const calls: string[][] = []
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('session.cwd', async () => ({ value: '/repo' }))
  on('process.run', async (_$, e) => {
    const argv = [...e.argv]
    calls.push(argv)
    const answer = argv[2] === 'status' ? blocked : argv[2] === 'start' ? { status: 'start-blocked', reason: 'Model profiles need attention' } : ANSWERS[argv[2]]
    return { value: { exitCode: 0, stdout: `${JSON.stringify(answer ?? {})}\n`, stderr: '' } }
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'todo', surface, component: 'Pane', requestId: 'todo-dashboard', props: PANE, viewport: { columns: 200, rows: 60 } })
    await ui.press({ key: 'nav-refresh' })
    expect(await ui.find({ type: 'Text', text: /Runner cannot start: 1 model profile problem — ultra:/ })).toBeDefined()
    await ui.press({ key: 'start-runner' })
    expect(calls.some(c => c[2] === 'start')).toBe(true)
    expect(await ui.find({ type: 'Text', text: /start-blocked/ })).toBeDefined()
    await ui.press({ key: 'fix-profiles' })
    expect(await ui.find({ key: 'p-add' })).toBeDefined()
    await ui.unmount()
  }
})

test('the graph keeps completed dependencies and focuses a chain', async ($, on) => {
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('session.cwd', async () => ({ value: '/repo' }))
  on('process.run', async (_$, e) => {
    const answer = ANSWERS[[...e.argv][2]] ?? {}
    return { value: { exitCode: 0, stdout: `${JSON.stringify(answer)}\n`, stderr: '' } }
  })
  // The graph is the desktop's alone; the terminal has no Graph button.
  const terminal = await $.ui.mount({ plugin: 'todo', surface: 'terminal', component: 'Pane', requestId: 'todo-dashboard', props: PANE, viewport: { columns: 200, rows: 60 } })
  await terminal.press({ key: 'nav-refresh' })
  expect(await terminal.find({ key: 'nav-graph' })).toBeUndefined()
  expect(await terminal.find({ key: 'graph-1-fail' })).toBeUndefined()
  await terminal.unmount()
  for (const surface of ['desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'todo', surface, component: 'Pane', requestId: 'todo-dashboard', props: PANE, viewport: { columns: 200, rows: 60 } })
    await ui.press({ key: 'nav-refresh' })
    await ui.press({ key: 'nav-graph' })
    // 2-run is active and waits on 4-done, which waited on 1-fail: all three stay.
    expect(await ui.find({ type: 'Text', text: /3 tasks · 2 dependencies/ })).toBeDefined()
    {
      const box = async () => /viewBox="([^"]+)"/.exec(String((await ui.find({ type: 'Svg' }))?.props.source))?.[1]
      const fitted = await box()
      expect(fitted).toBeDefined()
      await ui.press({ key: 'g-zoom-in' })
      const zoomed = await box()
      expect(zoomed).not.toBe(fitted)
      await ui.press({ key: 'g-right' })
      expect(await box()).not.toBe(zoomed)
      await ui.press({ key: 'g-center' })
      expect(await box()).toBe(fitted)
      const tall = Number((await ui.find({ type: 'Svg' }))?.props.height)
      await ui.press({ key: 'g-taller' })
      expect(Number((await ui.find({ type: 'Svg' }))?.props.height)).toBeGreaterThan(tall)
      await ui.press({ key: 'g-shorter' })
      expect(await ui.find({ type: 'Text', text: /^100%$/ })).toBeDefined()
      // Running pulses slowly, failed quickly; an unchanged poll keeps the drawing.
      const source = String((await ui.find({ type: 'Svg' }))?.props.source)
      expect(source).toMatch(/class="node [^"]*pulse-run"/)
      expect(source).toMatch(/class="node [^"]*pulse-fail"/)
      // Hover: a node lights its edges in the other end's status color, an edge lights its nodes.
      expect(source).toMatch(/svg:has\(\.n\d+:hover\) \.s\d+\{--c:var\(--b\)/)
      expect(source).toMatch(/svg:has\(\.e0:hover\) \.x0 \.frame/)
      expect(source).toContain('class="hit"')
      await ui.press({ key: 'nav-refresh' })
      expect(String((await ui.find({ type: 'Svg' }))?.props.source)).toBe(source)
      // Details opens the task window; Back returns to the graph.
      await ui.select({ key: 'graph-focus', value: '4-done' })
      await ui.press({ key: 'graph-details' })
      expect(await ui.find({ key: 'ov-b-1-fail' })).toBeDefined()
      expect(await ui.find({ key: 'ov-d-2-run' })).toBeDefined()
      await ui.press({ key: 'ov-d-2-run' })
      expect(await ui.find({ type: 'Text', text: /\[2\] Run thing/ })).toBeDefined()
      await ui.press({ key: 'back' })
      expect(await ui.find({ key: 'graph-active' })).toBeDefined()
      await ui.press({ key: 'graph-active' })
    }
    await ui.press({ key: 'graph-all' })
    await ui.select({ key: 'graph-focus', value: '4-done' })
    expect(await ui.find({ key: 'graph-details' })).toBeDefined()
    await ui.press({ key: 'graph-details' })
    expect(await ui.find({ type: 'Text', text: /\[4\] Shipped/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the table magnifier opens the graph centered on its task', async ($, on) => {
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('session.cwd', async () => ({ value: '/repo' }))
  on('process.run', async (_$, e) => {
    const answer = ANSWERS[[...e.argv][2]] ?? {}
    return { value: { exitCode: 0, stdout: `${JSON.stringify(answer)}\n`, stderr: '' } }
  })
  for (const surface of ['desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'todo', surface, component: 'Pane', requestId: 'todo-dashboard', props: PANE, viewport: { columns: 200, rows: 60 } })
    await ui.press({ key: 'nav-refresh' })
    await ui.press({ key: 'nav-tasks' })
    // 3-ask has no dependencies, yet the magnifier still shows it.
    await ui.press({ key: 'graph-3-ask' })
    expect(await ui.find({ key: 'graph-details' })).toBeDefined()
    {
      const source = String((await ui.find({ type: 'Svg' }))?.props.source)
      expect(source).toContain('[3] Needs answer')
      expect(await ui.find({ type: 'Text', text: /^100%$/ })).toBeDefined()
    }
    await ui.unmount()
  }
})

test('the band above the prompt always shows the task status and opens the dashboard', async ($, on) => {
  const opened: string[] = []
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.open', async (_$, e) => { opened.push(e.id); return { value: undefined } })
  on('session.cwd', async () => ({ value: '/repo' }))
  on('process.run', async (_$, e) => {
    const answer = ANSWERS[[...e.argv][2]] ?? {}
    return { value: { exitCode: 0, stdout: `${JSON.stringify(answer)}\n`, stderr: '' } }
  })
  const pane = await $.ui.mount({ plugin: 'todo', surface: 'desktop', component: 'Pane', requestId: 'todo-dashboard', props: PANE, viewport: { columns: 200, rows: 60 } })
  await pane.press({ key: 'nav-refresh' })
  await pane.unmount()
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({
      plugin: 'todo', surface, component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 }, view: {} },
      viewport: { columns: 120, rows: 40 },
    })
    expect(await band.find({ key: 'band-running' })).toBeDefined()
    expect(await band.find({ key: 'band-waiting' })).toBeDefined()
    expect(await band.find({ key: 'band-queued' })).toBeUndefined()
    await band.press({ key: 'band-failed' })
    expect(opened.at(-1)).toBe('todo-dashboard')
    await band.unmount()
    // The pane opens on the table filtered to that state.
    const filtered = await $.ui.mount({ plugin: 'todo', surface, component: 'Pane', requestId: 'todo-dashboard', props: PANE, viewport: { columns: 200, rows: 60 } })
    expect(await filtered.find({ key: 'title-1-fail' })).toBeDefined()
    expect(await filtered.find({ key: 'title-2-run' })).toBeUndefined()
    await filtered.unmount()
  }
})
