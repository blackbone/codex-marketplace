const $ = id => document.getElementById(id);
const number = value => value == null ? '—' : new Intl.NumberFormat('ru-RU').format(value);
const time = value => new Date(value).toLocaleTimeString('ru-RU');
function element(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function files(paths, count) {
  const list = element('ul');
  for (const path of paths) list.append(element('li', path));
  if (count > paths.length) list.append(element('li', `Ещё ${number(count - paths.length)} файлов`));
  return list;
}
let projectSignature = '';
let searchBusy = false;
let searchProjectsSignature = '';
function updateSearchProjects(projects) {
  // Queue polling must not reset the user's project choice or query.
  const available = projects.filter(project => project.folders);
  const signature = JSON.stringify(available.map(({ root, name }) => [root, name]));
  if (signature !== searchProjectsSignature && !searchBusy) {
    searchProjectsSignature = signature;
    const previous = $('search-project').value;
    const selected = available.find(project => project.root === previous) || available.find(project => project.selected) || available[0];
    const options = available.map(project => {
      const option = element('option', `${project.name} — ${project.root}`);
      option.value = project.root;
      return option;
    });
    if (!options.length) { const option = element('option', 'Нет настроенных проектов'); option.value = ''; options.push(option); }
    $('search-project').replaceChildren(...options);
    $('search-project').value = selected?.root || '';
    if (previous && previous !== $('search-project').value) clearSearch();
  }
  $('search-project').disabled = searchBusy || !available.length;
  $('search-submit').disabled = searchBusy || !$('search-project').value;
}
function clearSearch() {
  $('search-results').replaceChildren();
  $('search-error').hidden = true;
  $('search-status').textContent = 'Выберите проект и введите запрос.';
}
function documentUrl(route, cwd, result) {
  const url = new URL(route, location.href);
  url.search = new URLSearchParams({ cwd, path: result.path, from: result.fromLine, to: result.toLine });
  return url;
}
function showContext(pre, context, result) {
  const lines = context.text.split('\n');
  const start = Math.max(0, result.fromLine - context.fromLine);
  const end = Math.min(lines.length, result.toLine - context.fromLine + 1);
  const numbered = lines.map((line, i) => `${context.fromLine + i} │ ${line}`);
  const before = numbered.slice(0, start).join('\n');
  const after = numbered.slice(end).join('\n');
  const match = element('mark', numbered.slice(start, end).join('\n'));
  pre.replaceChildren(document.createTextNode(before ? before + '\n' : ''), match, document.createTextNode(after ? '\n' + after : ''));
  requestAnimationFrame(() => {
    if (!pre.isConnected) return;
    pre.scrollTop = 0;
    pre.scrollTop = Math.max(0, match.getBoundingClientRect().top - pre.getBoundingClientRect().top - pre.clientHeight / 3);
  });
}
function resultCard(cwd, query, result) {
  const card = element('article', undefined, 'search-result');
  const source = element('a', `${result.path} · строки ${result.fromLine}–${result.toLine}`, 'result-source');
  source.href = documentUrl('document', cwd, result);
  source.title = 'Открыть файл в редакторе по умолчанию';
  const actionStatus = element('p', '', 'muted');
  actionStatus.setAttribute('role', 'status');
  let opening = false;
  source.addEventListener('click', async event => {
    event.preventDefault();
    if (opening) return;
    opening = true;
    actionStatus.textContent = 'Открываем файл…';
    try {
      const response = await fetch(new URL('open', location.href), { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd, path: result.path }), signal: AbortSignal.timeout(15000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      actionStatus.textContent = 'Файл передан редактору по умолчанию.';
    } catch (error) { actionStatus.textContent = `Не удалось открыть файл: ${error.message}`; }
    finally { opening = false; }
  });
  card.append(element('h3', result.heading || result.path), source);
  const terms = query.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
  const searchable = `${result.path}\n${result.heading}\n${result.text}`.toLocaleLowerCase();
  const literal = terms.some(term => searchable.includes(term));
  card.append(element('p', literal ? 'Есть совпадение текста запроса в фрагменте, заголовке или пути. Выделены строки поискового фрагмента.' : 'По смысловой близости, без совпадения текста запроса. Выделены строки поискового фрагмента.', 'match-note'));
  if (result.contextError) card.append(element('p', result.contextError, 'context-warning'));
  const pre = element('pre', undefined, 'result-text');
  if (result.context) {
    const context = result.context;
    const label = element('p', `Контекст текущего файла · строки ${context.fromLine}–${context.toLine}`, 'muted');
    showContext(pre, context, result);
    card.append(label, pre);
    if (context.truncated) {
      const more = element('button', 'Показать весь раздел', 'context-more');
      more.type = 'button';
      more.addEventListener('click', async () => {
        more.disabled = true;
        try {
          const response = await fetch(documentUrl('context', cwd, result), { signal: AbortSignal.timeout(15000) });
          const full = await response.json();
          if (!response.ok) throw new Error(full.error || `HTTP ${response.status}`);
          showContext(pre, full, result);
          label.textContent = `Весь раздел текущего файла · строки ${full.fromLine}–${full.toLine}`;
          more.remove();
        } catch (error) { actionStatus.textContent = `Не удалось загрузить раздел: ${error.message}`; more.disabled = false; }
      });
      card.append(element('p', 'Показана часть большого раздела. Полный текст доступен ниже или по ссылке на файл.', 'muted'), more);
    }
    const original = element('details', undefined, 'indexed-fragment');
    original.append(element('summary', 'Фрагмент из индекса, по которому найден результат'), element('pre', result.text, 'result-text'));
    card.append(original);
  } else { pre.textContent = result.text; card.append(pre); }
  card.append(actionStatus);
  return card;
}
$('search-project').addEventListener('change', clearSearch);
$('search-query').addEventListener('input', clearSearch);
$('search-form').addEventListener('submit', async event => {
  event.preventDefault();
  const query = $('search-query').value.trim();
  const cwd = $('search-project').value;
  if (searchBusy || !cwd || !query) return;
  clearSearch();
  searchBusy = true;
  for (const id of ['search-project', 'search-query', 'search-submit']) $(id).disabled = true;
  $('search-submit').textContent = 'Поиск…';
  $('search-results').setAttribute('aria-busy', 'true');
  $('search-status').textContent = 'Ищем фрагменты… Ожидаем подготовки индекса, если она нужна.';
  try {
    const response = await fetch(new URL('search', location.href), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd, query }), signal: AbortSignal.timeout(910_000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    const cards = data.results.map(result => resultCard(cwd, query, result));
    $('search-results').replaceChildren(...cards);
    $('search-status').textContent = cards.length ? `Найдено фрагментов: ${number(cards.length)}.` : 'Ничего не найдено. Попробуйте другой запрос или проверьте папки документации.';
    if (data.pending) $('search-status').textContent += ` В очереди ещё ${number(data.pending)} файлов; последние изменения могут отсутствовать в результатах.`;
  } catch (error) {
    $('search-status').textContent = 'Поиск не завершён.';
    $('search-error').hidden = false;
    $('search-error').textContent = `Не удалось выполнить поиск: ${error.message}`;
  } finally {
    searchBusy = false;
    for (const id of ['search-project', 'search-query', 'search-submit']) $(id).disabled = false;
    $('search-submit').textContent = 'Найти';
    $('search-results').setAttribute('aria-busy', 'false');
  }
});
function render(data) {
  updateSearchProjects(data.projects);
  $('connection').textContent = data.running ? 'Сервис работает' : 'Сервис остановлен';
  $('connection').className = data.running ? 'live' : 'offline';
  $('active-label').textContent = data.running ? 'В обработке' : 'Прервано';
  for (const key of ['projects', 'indexed', 'active', 'pending']) $(key + '-count').textContent = number(data.totals[key]);
  $('error').hidden = !data.queueError;
  $('error').textContent = data.queueError ? `Не удалось прочитать очередь: ${data.queueError}` : '';
  const signature = JSON.stringify([data.running, data.projects]);
  if (signature !== projectSignature) {
  projectSignature = signature;
  const expanded = new Set([...document.querySelectorAll('details[open]')].map(el => el.dataset.root));
  const cards = data.projects.map(project => {
    const card = element('article', undefined, 'project' + (project.selected ? ' selected' : ''));
    const heading = element('div', undefined, 'project-head');
    heading.append(element('h2', project.name));
    const label = !data.running ? 'Ожидает запуска сервиса' : project.activeCount ? 'Обработка документов' : project.pendingCount ? 'В очереди' : project.watching ? 'Наблюдение включено' : 'Наблюдение выключено';
    heading.append(element('span', label, 'badge'));
    card.append(heading, element('p', project.root, 'root'));
    if (project.folders) card.append(element('div', 'Папки: ' + project.folders.join(', '), 'folders'));
    if (project.error) card.append(element('p', project.error, 'project-error'));
    else {
      const counts = element('div', undefined, 'summary');
      counts.append(element('span', `${number(project.indexed)} файлов в индексе`), element('span', `${number(project.chunks)} фрагментов`),
        element('span', project.checkedAt ? `Последняя запись: ${new Date(project.checkedAt).toLocaleString('ru-RU')}` : 'Индекс ещё не заполнен'));
      card.append(counts);
    }
    if (project.activeCount || project.pendingCount) {
      const activity = element('div', undefined, 'activity');
      if (project.activeCount) activity.append(element('h3', `${data.running ? 'Сейчас в обработке' : 'Прерванные файлы'} · ${number(project.activeCount)}`), files(project.active, project.activeCount));
      if (project.pendingCount) {
        const queue = element('details'); queue.dataset.root = project.root; queue.open = expanded.has(project.root);
        queue.append(element('summary', `В очереди · ${number(project.pendingCount)}`), files(project.pending, project.pendingCount));
        activity.append(queue);
      }
      card.append(activity);
    }
    return card;
  });
  $('projects').replaceChildren(...cards);
  $('empty').hidden = cards.length > 0;
  }
  $('updated').textContent = 'Проверено в ' + time(data.checkedAt);
}
async function refresh() {
  try {
    const url = new URL('state', location.href); url.search = location.search;
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    render(data);
  } catch (error) {
    $('connection').textContent = 'Нет связи'; $('connection').className = 'offline';
    $('error').hidden = false; $('error').textContent = `Обновление не удалось: ${error.message}. Показанные данные могут быть устаревшими.`;
  } finally { setTimeout(refresh, 2000); }
}
refresh();
