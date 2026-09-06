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
function render(data) {
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
