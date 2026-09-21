import { readConfig, sourceEntry } from './common.mjs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function openDocument(cwd, file, launch = exec) {
  const document = dashboardDocument(cwd, file);
  const absolute = path.resolve(document.root, file);
  const options = { timeout: 10000, windowsHide: true };
  if (process.platform === 'darwin') await launch('open', [absolute], options);
  else if (process.platform === 'win32') await launch('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:DOCS_OPEN_FILE -ErrorAction Stop'], { ...options, env: { ...process.env, DOCS_OPEN_FILE: absolute } });
  else await launch('xdg-open', [absolute], options);
  return { opened: true, path: document.path };
}

// Presentation-only filtering also works with an already running older daemon.
export function hasBody(text) {
  return text.split('\n').some(line => {
    const value = line.trim();
    return value && !/^#{1,6}\s/.test(value) && !/^[\s|:–—_\-*`~]+$/.test(value);
  });
}

export function dashboardDocument(cwd, file) {
  const { root, config } = readConfig(cwd);
  const entry = sourceEntry(root, config, file);
  if (!entry) throw new Error('File is not in the configured documentation');
  return { root, path: file, ...entry };
}

// Keep a whole Markdown section when small. Large sections/tables use a bounded
// window; the file link always opens the entire source, including long lines.
export function sourceContext(text, fromLine, toLine, full = false) {
  const lines = text.split('\n');
  if (!Number.isInteger(fromLine) || !Number.isInteger(toLine) || fromLine < 1 || toLine < fromLine || toLine > lines.length) return null;
  let start = 0, end = lines.length, fence = null;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\s{0,3}(`{3,}|~{3,})/);
    if (match) {
      if (!fence) fence = { char: match[1][0], length: match[1].length };
      else if (match[1][0] === fence.char && match[1].length >= fence.length) fence = null;
    }
    if (!fence && /^#{1,6}\s+/.test(lines[i])) {
      if (i < fromLine) start = i;
      else if (i >= toLine) { end = i; break; }
    }
  }
  const sectionStart = start, sectionEnd = end;
  if (full) return { fromLine: start + 1, toLine: end, text: lines.slice(start, end).join('\n'), truncated: false };
  if (end - start > 80) { start = Math.max(start, fromLine - 9); end = Math.min(end, Math.max(toLine, fromLine + 15)); }
  // Character bound matters for generated tables with very long rows.
  while (lines.slice(start, end).join('\n').length > 24000 && (start < fromLine - 1 || end > toLine)) {
    if (end > toLine) end--;
    else start++;
  }
  const body = lines.slice(start, end).join('\n');
  return { fromLine: start + 1, toLine: end, sectionFromLine: sectionStart + 1, sectionToLine: sectionEnd, text: body.slice(0, 24000),
    truncated: start !== sectionStart || end !== sectionEnd || body.length > 24000 };
}

export function contextualResults(cwd, data) {
  const documents = new Map();
  const seen = new Set();
  const results = [];
  for (const result of data.results) {
    if (!hasBody(result.text)) continue;
    let context = null, contextError = null;
    try {
      if (!documents.has(result.path)) documents.set(result.path, dashboardDocument(cwd, result.path));
      const doc = documents.get(result.path);
      const current = doc.text.split('\n').slice(result.fromLine - 1, result.toLine).join('\n');
      const compact = text => text.replace(/\s/g, '');
      if (!compact(current).includes(compact(result.text))) contextError = 'Файл изменился после индексации. Ниже показан сохранённый фрагмент; ссылка откроет текущий файл.';
      else context = sourceContext(doc.text, result.fromLine, result.toLine);
    } catch (error) { contextError = `Контекст недоступен: ${error.message}`; }
    const key = JSON.stringify([result.path, context?.sectionFromLine ?? result.fromLine, context?.sectionToLine ?? result.toLine]);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ ...result, context, contextError });
    if (results.length === 6) break;
  }
  return { ...data, results };
}
