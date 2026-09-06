import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { readConfig, scan, ENGINE, MODEL_KEY, TRANSFORMERS_VERSION, privateDir } from './common.mjs';
import { getEmbedder } from './embedding.mjs';

export const fingerprint = `${ENGINE}:${MODEL_KEY}:${TRANSFORMERS_VERSION}:chunks120`;
export const databasePath = root => path.join(root, '.semantic-search', 'index.sqlite');

function database(root) {
  const dir = privateDir(path.dirname(databasePath(root)));
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n', { flag: 'wx', mode: 0o600 });
  const file = databasePath(root);
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(file + suffix) && fs.lstatSync(file + suffix).isSymbolicLink()) throw new Error('Index files must not be symlinks');
  }
  const db = new DatabaseSync(file);
  fs.chmodSync(file, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, hash TEXT NOT NULL, fingerprint TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, path TEXT NOT NULL, heading TEXT NOT NULL, from_line INTEGER, to_line INTEGER, text TEXT NOT NULL, vector BLOB NOT NULL);
    CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path);
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(path, heading, text, tokenize='unicode61');`);
  if (!db.prepare('PRAGMA table_info(files)').all().some(column => column.name === 'fingerprint')) db.exec("ALTER TABLE files ADD COLUMN fingerprint TEXT NOT NULL DEFAULT ''");
  return db;
}

// Every source line is covered, including long paragraphs and fenced code. The
// embedding input (heading + body) is bounded by actual model tokens, not words.
export function chunkDocument(text, filename, tokenCount) {
  const chunks = [];
  const headings = [];
  let heading = filename;
  let pending = [];
  let fenced = null;
  function title() {
    let value = heading;
    while (tokenCount(value) > 22 && value.length > 1) value = value.slice(0, Math.floor(value.length * 0.8));
    return value;
  }
  function fits(body) { return tokenCount(`${title()}\n${body}`) <= 120; }
  function flush() {
    if (!pending.length) return;
    const body = pending.map(x => x.text).join('\n');
    if (body.trim()) chunks.push({ heading, fromLine: pending[0].line, toLine: pending.at(-1).line, text: body, input: `${title()}\n${body}` });
    pending = [];
  }
  function append(value, line) {
    if (!fits(value)) {
      flush();
      const chars = Array.from(value);
      if (chars.length <= 1) throw new Error(`Cannot tokenize document fragment at ${filename}:${line}`);
      let middle = Math.floor(chars.length / 2);
      const boundary = chars.slice(0, middle).join('').lastIndexOf(' ');
      if (boundary > middle / 2) middle = Array.from(chars.slice(0, middle).join('').slice(0, boundary + 1)).length;
      append(chars.slice(0, middle).join(''), line);
      append(chars.slice(middle).join(''), line);
      return;
    }
    if (pending.length && !fits([...pending.map(x => x.text), value].join('\n'))) flush();
    pending.push({ text: value, line });
  }
  for (const [i, line] of text.split('\n').entries()) {
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (!fenced) fenced = { char: fence[1][0], length: fence[1].length };
      else if (fence[1][0] === fenced.char && fence[1].length >= fenced.length) fenced = null;
    }
    const match = !fenced && line.match(/^(#{1,6})\s+(.+)/);
    if (match) {
      flush();
      headings.length = match[1].length - 1;
      headings[match[1].length - 1] = match[2].trim();
      heading = headings.filter(Boolean).join(' > ');
    }
    append(line, i + 1);
  }
  flush();
  return chunks;
}

function encodeVector(vector) { return Buffer.from(Float32Array.from(vector).buffer); }
function decodeVector(bytes) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Float32Array(buffer);
}

export function indexedFiles(root) {
  const db = database(root);
  try { return new Map(db.prepare('SELECT path, hash, fingerprint FROM files').all().map(row => [row.path, row])); }
  finally { db.close(); }
}

// Commit the captured content, even if its source changed while embedding.
// A later queue entry owns the newer version. Fingerprints are per file so a
// crash partway through a model upgrade cannot mark untouched files current.
export function commitDocuments(root, documents) {
  const db = database(root);
  try {
    db.exec('BEGIN IMMEDIATE');
    const removeFts = db.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE path = ?)');
    const removeChunks = db.prepare('DELETE FROM chunks WHERE path = ?');
    const removeFile = db.prepare('DELETE FROM files WHERE path = ?');
    const addFile = db.prepare('INSERT INTO files(path, hash, fingerprint) VALUES (?, ?, ?)');
    const addChunk = db.prepare('INSERT INTO chunks(path, heading, from_line, to_line, text, vector) VALUES (?, ?, ?, ?, ?, ?)');
    const addFts = db.prepare('INSERT INTO chunks_fts(rowid, path, heading, text) VALUES (?, ?, ?, ?)');
    for (const doc of documents) {
      removeFts.run(doc.path); removeChunks.run(doc.path); removeFile.run(doc.path);
      if (doc.hash === null) continue;
      addFile.run(doc.path, doc.hash, fingerprint);
      for (const chunk of doc.chunks) {
        const result = addChunk.run(doc.path, chunk.heading, chunk.fromLine, chunk.toLine, chunk.text, encodeVector(chunk.vector));
        addFts.run(result.lastInsertRowid, doc.path, chunk.heading, chunk.text);
      }
    }
    db.prepare('INSERT OR REPLACE INTO metadata VALUES (?, ?)').run('checkedAt', new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }
}

export function indexSummary(root) {
  const db = database(root);
  try {
    return { root, indexed: db.prepare('SELECT count(*) AS n FROM files').get().n,
      chunks: db.prepare('SELECT count(*) AS n FROM chunks').get().n,
      checkedAt: db.prepare('SELECT value FROM metadata WHERE key = ?').get('checkedAt')?.value ?? null };
  } finally { db.close(); }
}

// Explicit one-shot refresh retained for isolated CLI-independent callers/tests.
export async function refresh(cwd, providedEmbedder) {
  const { root, config } = readConfig(cwd);
  const snapshot = scan(root, config);
  const old = indexedFiles(root);
  const changed = [...snapshot.files].filter(([file, value]) => old.get(file)?.fingerprint !== fingerprint || old.get(file)?.hash !== value.hash);
  const removed = [...old.keys()].filter(file => !snapshot.files.has(file));
  const documents = removed.map(file => ({ path: file, hash: null, chunks: [] }));
  if (changed.length) {
    const embedder = providedEmbedder || await getEmbedder();
    for (const [file, value] of changed) {
      const chunks = chunkDocument(value.text, file, embedder.tokenCount);
      const vectors = await embedder.embed(chunks.map(chunk => chunk.input));
      documents.push({ path: file, hash: value.hash, chunks: chunks.map((chunk, i) => ({ ...chunk, vector: vectors[i] })) });
    }
  }
  if (documents.length) commitDocuments(root, documents);
  return { ...indexSummary(root), updated: changed.length, removed: removed.length, unchanged: snapshot.files.size - changed.length,
    skipped: snapshot.skipped.slice(0, 30), skippedCount: snapshot.skipped.length };
}

export async function search(cwd, query, limit = 6, providedEmbedder, readyIndex) {
  if (typeof query !== 'string' || !query.trim() || query.length > 4000) throw new Error('query must contain 1–4000 characters');
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('limit must be between 1 and 20');
  const freshness = readyIndex || await refresh(cwd, providedEmbedder);
  if (!freshness.chunks) return { ...freshness, results: [] };
  const embedder = providedEmbedder || await getEmbedder();
  if (embedder.tokenCount(query) > 120) throw new Error('Search query is too long. Use a focused question (up to 120 model tokens).');
  const [vector] = await embedder.embed([query]);
  const db = database(freshness.root);
  try {
    const rows = db.prepare('SELECT * FROM chunks').all();
    const semantic = rows.map(row => {
      const values = decodeVector(row.vector);
      if (values.length !== vector.length) throw new Error('Embedding dimensions changed; rebuild the project index');
      const cosine = values.reduce((sum, value, i) => sum + value * vector[i], 0);
      return { id: row.id, cosine };
    }).sort((a, b) => b.cosine - a.cosine);
    const words = query.match(/[\p{L}\p{N}_]+/gu) || [];
    const expression = [...new Set(words)].slice(0, 32).map(w => `"${w}"`).join(' OR ');
    const lexical = expression ? db.prepare('SELECT rowid AS id, bm25(chunks_fts, 2, 2, 1) AS score FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY score LIMIT 100').all(expression) : [];
    const scores = new Map();
    for (const list of [semantic.slice(0, 100), lexical]) list.forEach((row, i) => scores.set(row.id, (scores.get(row.id) || 0) + 1 / (60 + i + 1)));
    const byId = new Map(rows.map(row => [row.id, row]));
    const cosines = new Map(semantic.map(row => [row.id, row.cosine]));
    const perFile = new Map();
    const results = [];
    for (const [id, score] of [...scores].sort((a, b) => b[1] - a[1])) {
      const row = byId.get(id);
      if ((perFile.get(row.path) || 0) >= 3) continue;
      perFile.set(row.path, (perFile.get(row.path) || 0) + 1);
      results.push({ path: row.path, heading: row.heading, fromLine: row.from_line, toLine: row.to_line, text: row.text, cosine: cosines.get(id), rankScore: score });
      if (results.length === limit) break;
    }
    return { ...freshness, model: embedder.model, results };
  } finally { db.close(); }
}

export function status(cwd) {
  const { root, config } = readConfig(cwd);
  const snapshot = scan(root, config);
  const file = databasePath(root);
  if (!fs.existsSync(file)) return { root, config, files: snapshot.files.size, indexExists: false, stale: true };
  const db = database(root);
  try {
    const old = new Map(db.prepare('SELECT path, hash, fingerprint FROM files').all().map(row => [row.path, row]));
    const stale = old.size !== snapshot.files.size || [...snapshot.files].some(([file, value]) => old.get(file)?.hash !== value.hash || old.get(file)?.fingerprint !== fingerprint);
    return { root, config, files: snapshot.files.size, indexExists: true, stale, chunks: db.prepare('SELECT count(*) AS n FROM chunks').get().n, skippedCount: snapshot.skipped.length, checkedAt: db.prepare('SELECT value FROM metadata WHERE key = ?').get('checkedAt')?.value };
  } finally { db.close(); }
}
