import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { atomicJson, cacheDir, readConfig, scan, sourceEntry, IGNORED, CONFIG_NAME } from './common.mjs';
import { indexedFiles, fingerprint, chunkDocument, commitDocuments, indexSummary } from './index.mjs';
import { getEmbedder } from './embedding.mjs';

const key = job => JSON.stringify([job.root, job.path]);
export const queuePath = () => path.join(cacheDir('servers'), 'index-queue.json');
const descriptor = job => ({ root: job.root, path: job.path });

export class IndexQueue {
  constructor({ file = queuePath(), embedder, watch = true, debounceMs = 150, retryMs = 5000, maxFiles = 8, batchSize = 32 } = {}) {
    Object.assign(this, { file, embedder, watch, debounceMs, retryMs, maxFiles, batchSize });
    this.projects = new Map();
    this.pending = new Map();
    this.active = [];
    this.sequence = 0;
    this.events = new EventEmitter();
    this.events.setMaxListeners(0);
    this.closed = false;
    this.running = false;
  }

  save() {
    atomicJson(this.file, { version: 1,
      projects: [...this.projects.values()].map(project => ({ root: project.root, owners: [...project.owners] })),
      active: this.active.map(descriptor), pending: [...this.pending.values()].map(descriptor) });
    this.events.emit('change');
  }

  restore() {
    let state;
    try { state = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') console.error(`Queue state unreadable; registered projects must reconnect: ${error.message}`); return; }
    if (state.version !== 1 || !Array.isArray(state.projects) || !Array.isArray(state.active) || !Array.isArray(state.pending)) throw new Error('Unsupported index queue state');
    // Load registrations first, then recover the interrupted batch before pending
    // jobs. Reconciliation is delayed until all recovered paths are deduplicated.
    for (const saved of state.projects) {
      try {
        if (!path.isAbsolute(saved.root) || !fs.existsSync(path.join(saved.root, CONFIG_NAME))) continue;
        const { root, config } = readConfig(saved.root);
        if (root !== saved.root) continue;
        this.addProject(root, config, (saved.owners || []).filter(owner => typeof owner === 'string' && !owner.startsWith('request:')));
      } catch (error) { console.error(`Skipping unavailable project: ${error.message}`); }
    }
    for (const job of [...state.active, ...state.pending]) {
      if (this.projects.has(job.root) && typeof job.path === 'string' && !path.isAbsolute(job.path) && !job.path.split(/[\\/]/).includes('..')) {
        if (!this.pending.has(key(job))) this.enqueue(job.root, job.path, { persist: false, immediate: true });
      }
    }
    for (const project of this.projects.values()) this.reconcile(project.root);
    for (const project of this.projects.values()) this.release(project);
    this.save();
    this.kick();
  }

  addProject(root, config, owners = []) {
    const project = { root, config, owners: new Set(owners), watchers: new Map(), error: null, skipped: [], updated: 0, removed: 0 };
    this.projects.set(root, project);
    this.syncWatchers(project);
    return project;
  }

  register(cwd, owner) {
    if (typeof owner !== 'string' || !owner || owner.length > 300) throw new Error('A stable registration owner is required');
    const { root, config } = readConfig(cwd);
    let project = this.projects.get(root);
    const fresh = !project;
    if (!project) project = this.addProject(root, config);
    const added = !project.owners.has(owner);
    project.owners.add(owner);
    if (fresh || project.error || JSON.stringify(config) !== JSON.stringify(project.config)) this.reconcile(root);
    if (fresh || added) this.save();
    this.kick();
    return root;
  }

  unregister(owner) {
    for (const project of this.projects.values()) {
      project.owners.delete(owner);
      this.release(project);
    }
    this.save();
  }

  release(project) {
    if (project.owners.size || this.active.some(job => job.root === project.root) || [...this.pending.values()].some(job => job.root === project.root)) return;
    clearTimeout(project.scanTimer);
    for (const watcher of project.watchers.values()) watcher.close();
    this.projects.delete(project.root);
  }

  enqueue(root, file, { persist = true, immediate = false, hash } = {}) {
    const id = key({ root, path: file });
    const previous = this.pending.get(id);
    this.pending.delete(id);
    const sequence = ++this.sequence;
    this.pending.set(id, { root, path: file, since: previous?.since ?? sequence, sequence, hash,
      readyAt: immediate ? 0 : Math.min(Date.now() + this.debounceMs, previous?.deadline ?? Date.now() + 1000),
      deadline: previous?.deadline ?? Date.now() + 1000 });
    if (persist) this.save();
    this.kick();
  }

  reconcile(root) {
    const project = this.projects.get(root);
    if (!project) return;
    try {
      if (!fs.existsSync(path.join(root, CONFIG_NAME))) {
        // An absent project/config is no longer a source registration. Do not
        // recreate its directory or accidentally adopt an ancestor's config.
        for (const [id, job] of this.pending) if (job.root === root) this.pending.delete(id);
        project.owners.clear();
        for (const watcher of project.watchers.values()) watcher.close();
        this.projects.delete(root);
        this.save();
        return;
      }
      project.config = readConfig(root).config;
      this.syncWatchers(project); // Observe changes before taking the snapshot.
      const snapshot = scan(root, project.config);
      project.skipped = snapshot.skipped;
      const old = indexedFiles(root);
      for (const file of new Set([...snapshot.files.keys(), ...old.keys()])) {
        const desired = snapshot.files.get(file)?.hash ?? null;
        const stored = old.get(file);
        const id = key({ root, path: file });
        const active = this.active.find(job => key(job) === id);
        const pending = this.pending.get(id);
        const current = desired === null ? !stored : stored?.hash === desired && stored?.fingerprint === fingerprint;
        // Idempotence: unchanged checks neither reorder queued paths nor create
        // another copy of work already in flight for the same source hash.
        if (pending) {
          pending.hash = desired;
          if (pending.error) { delete pending.error; pending.readyAt = 0; }
          continue;
        }
        if (active ? active.hash !== desired : !current) this.enqueue(root, file, { hash: desired, immediate: true, persist: false });
      }
      project.error = null;
      this.save();
    } catch (error) { project.error = error.message; this.events.emit('change'); }
    this.kick();
  }

  scheduleReconcile(project) {
    clearTimeout(project.scanTimer);
    project.scanTimer = setTimeout(() => { project.scanTimer = null; this.reconcile(project.root); }, this.debounceMs);
  }

  syncWatchers(project) {
    if (!this.watch || this.closed) return;
    const wanted = new Set([project.root]);
    const excluded = relative => relative.split('/').some(part => part.startsWith('.') || IGNORED.has(part)) || project.config.exclude.some(prefix => relative === prefix.replace(/\/$/, '') || relative.startsWith(prefix.replace(/\/$/, '') + '/'));
    const add = dir => {
      const relative = path.relative(project.root, dir).split(path.sep).join('/');
      if (relative && excluded(relative)) return;
      let stat;
      try { stat = fs.lstatSync(dir); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      wanted.add(dir);
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) if (item.isDirectory()) add(path.join(dir, item.name));
    };
    for (const folder of project.config.folders) {
      // Watch existing parents too, so recreation of a missing docs folder is seen.
      let cursor = project.root;
      for (const part of folder.split('/').filter(part => part !== '.')) {
        cursor = path.join(cursor, part);
        if (fs.existsSync(cursor)) wanted.add(cursor);
      }
      add(path.resolve(project.root, folder));
    }
    for (const [dir, watcher] of project.watchers) if (!wanted.has(dir)) { watcher.close(); project.watchers.delete(dir); }
    for (const dir of wanted) {
      if (project.watchers.has(dir)) continue;
      const watcher = fs.watch(dir, (event, filename) => {
        if (this.closed || !this.projects.has(project.root)) return;
        if (!filename) return this.scheduleReconcile(project);
        const absolute = path.join(dir, filename.toString());
        const relative = path.relative(project.root, absolute).split(path.sep).join('/');
        if (relative === CONFIG_NAME) return this.scheduleReconcile(project);
        if (excluded(relative)) return;
        // A rename may replace a watched directory's inode. Rebuild the watcher
        // tree on reconciliation, not just its path list.
        if (event === 'rename') {
          for (const [watched, handle] of project.watchers) if (watched === absolute || watched.startsWith(absolute + path.sep)) { handle.close(); project.watchers.delete(watched); }
          this.scheduleReconcile(project);
        }
        if (project.config.extensions.includes(path.extname(relative).toLowerCase()) && project.config.folders.some(folder => folder === '.' || relative.startsWith(folder + '/'))) {
          this.enqueue(project.root, relative);
        }
      });
      watcher.on('error', error => { watcher.close(); project.watchers.delete(dir); project.error = `Watcher: ${error.message}`; this.scheduleReconcile(project); });
      project.watchers.set(dir, watcher);
    }
  }

  kick() {
    if (this.closed || this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.work().catch(error => { console.error(error); });
    }, 10);
  }

  async work() {
    if (this.closed || this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      for (const [id, job] of this.pending) {
        if (this.active.length >= this.maxFiles) break;
        if (job.readyAt > now || this.active.some(active => key(active) === id)) continue;
        this.pending.delete(id);
        this.active.push(job);
      }
      if (!this.active.length) return;
      this.save(); // Durable paths before reading files or starting the model.
      const failed = [];
      for (const job of this.active) {
        if (job.chunks) continue;
        try {
          const project = this.projects.get(job.root);
          if (!project || !fs.existsSync(path.join(job.root, CONFIG_NAME))) { job.skip = true; job.chunks = []; continue; }
          const entry = sourceEntry(job.root, project.config, job.path);
          const old = indexedFiles(job.root).get(job.path);
          job.hash = entry?.hash ?? null;
          if (entry ? old?.hash === entry.hash && old?.fingerprint === fingerprint : !old) {
            job.skip = true; job.chunks = []; continue;
          }
          if (!entry) { job.chunks = []; continue; }
          // Capture bytes/hash before awaiting model loading; later writes enqueue
          // another job and never invalidate this captured version.
          const embedder = this.embedder || await getEmbedder();
          if (this.closed) return;
          job.chunks = chunkDocument(entry.text, job.path, embedder.tokenCount);
          job.cursor = 0;
        } catch (error) {
          this.retry(job, error);
          failed.push(job);
        }
      }
      this.active = this.active.filter(job => !failed.includes(job));
      if (failed.length) this.save();
      const selected = [];
      // Round-robin fragments across files/projects, bounded inference batches.
      while (selected.length < this.batchSize) {
        let added = false;
        for (const job of this.active) {
          if (selected.length >= this.batchSize) break;
          if ((job.cursor ?? 0) < job.chunks.length) {
            selected.push(job.chunks[job.cursor++]); added = true;
          }
        }
        if (!added) break;
      }
      if (selected.length) {
        const embedder = this.embedder || await getEmbedder();
        const vectors = await embedder.embed(selected.map(chunk => chunk.input));
        if (vectors.length !== selected.length) throw new Error('Embedding batch returned an unexpected vector count');
        selected.forEach((chunk, i) => { chunk.vector = vectors[i]; });
      }
      if (this.closed) return;
      const completed = this.active.filter(job => job.chunks.every(chunk => chunk.vector));
      for (const root of new Set(completed.map(job => job.root))) {
        const project = this.projects.get(root);
        if (!project || !fs.existsSync(path.join(root, CONFIG_NAME))) continue;
        const documents = completed.filter(job => job.root === root && !job.skip);
        try {
          if (documents.length) commitDocuments(root, documents);
          project.updated += documents.filter(job => job.hash !== null).length;
          project.removed += documents.filter(job => job.hash === null).length;
        } catch (error) {
          for (const job of documents) this.retry(job, error);
        }
      }
      this.active = this.active.filter(job => !completed.includes(job));
      for (const project of this.projects.values()) this.release(project);
      this.save();
    } catch (error) {
      if (this.closed) return;
      for (const job of this.active) this.retry(job, error);
      this.active = [];
      this.save();
    } finally {
      this.running = false;
      if (!this.closed && (this.active.length || this.pending.size)) {
        const delay = this.active.length ? 0 : Math.max(10, Math.min(...[...this.pending.values()].map(job => job.readyAt)) - Date.now());
        this.timer = setTimeout(() => { this.timer = null; this.kick(); }, delay);
      }
    }
  }

  retry(job, error) {
    const id = key(job);
    const pending = this.pending.get(id);
    this.pending.set(id, { ...descriptor(job), since: Math.min(job.since, pending?.since ?? Infinity), sequence: pending?.sequence ?? job.sequence, error: error.message, readyAt: Date.now() + this.retryMs });
  }

  async flush(root, { reconcile = false, timeoutMs = 850_000 } = {}) {
    const project = this.projects.get(root);
    if (!project) throw new Error('Project is not registered');
    if (project.scanTimer) { clearTimeout(project.scanTimer); project.scanTimer = null; this.reconcile(root); }
    if (reconcile) this.reconcile(root);
    const barrier = this.sequence;
    const before = { updated: project.updated, removed: project.removed };
    for (const job of this.pending.values()) if (job.root === root && job.since <= barrier) job.readyAt = 0;
    clearTimeout(this.timer); this.timer = null; this.kick();
    const outstanding = () => [...this.active, ...this.pending.values()].some(job => job.root === root && job.since <= barrier);
    const failure = () => project.error || [...this.pending.values()].find(job => job.root === root && job.since <= barrier && job.error)?.error;
    const deadline = Date.now() + timeoutMs;
    while (outstanding()) {
      if (this.closed) throw new Error('Index daemon stopped');
      if (failure()) throw new Error(failure());
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Timed out waiting for project indexing');
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); this.events.off('change', done); resolve(); };
        const timer = setTimeout(done, Math.min(remaining, 1000));
        this.events.once('change', done);
      });
    }
    if (failure()) throw new Error(failure());
    if (!this.projects.has(root) || !fs.existsSync(path.join(root, CONFIG_NAME))) throw new Error('Project is no longer available');
    return { ...indexSummary(root), updated: project.updated - before.updated, removed: project.removed - before.removed,
      skipped: project.skipped.slice(0, 30), skippedCount: project.skipped.length,
      pending: [...this.active, ...this.pending.values()].filter(job => job.root === root).length };
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    for (const project of this.projects.values()) {
      clearTimeout(project.scanTimer);
      for (const watcher of project.watchers.values()) watcher.close();
    }
    this.save();
  }
}
