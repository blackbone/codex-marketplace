export function sourcePath(snapshot, id) {
  for (const [path, content] of Object.entries(snapshot.files || {})) {
    if (!/^(entities|components|relations)\/.+\.json$/.test(path)) continue;
    try { if (JSON.parse(content).id === id) return path; } catch { /* Invalid files are reported by the server. */ }
  }
  return null;
}

export function graphData(snapshot, selected, filter = '') {
  const entities = snapshot.entities || [];
  const components = snapshot.components || [];
  const all = [...entities.map(item => ({ ...item, kind: 'entity' })), ...components.map(item => ({ ...item, kind: 'component' }))];
  const term = filter.trim().toLowerCase();
  const nodes = all.map(item => ({
    id: item.id,
    type: 'ori',
    position: { x: 0, y: 0 },
    selected: selected === item.id,
    data: { ...item, dimmed: !!term && !`${item.id} ${item.name || ''} ${item.type || ''} ${item.text || ''}`.toLowerCase().includes(term) },
  }));
  const ids = new Set(nodes.map(node => node.id));
  const edges = [
    ...components.filter(item => ids.has(item.entityId)).map(item => ({ id: `owns:${item.id}`, source: item.entityId, target: item.id, type: 'smoothstep', className: 'ownership-edge', data: { label: 'owns' } })),
    ...(snapshot.relations || []).filter(item => ids.has(item.from) && ids.has(item.to)).map(item => ({ id: `relation:${item.id}`, source: item.from, target: item.to, label: item.type, type: 'smoothstep', markerEnd: { type: 'arrowclosed', width: 14, height: 14, color: item.type === 'constrains' ? '#c6b677' : '#9cb88e' }, className: item.type === 'constrains' ? 'constraint-edge' : 'relation-edge' })),
  ];
  return { nodes, edges };
}

export function changeFiles(change, snapshot) {
  return (change.operations || []).map(operation => ({
    ...operation,
    before: change.before ? change.before[operation.path] || '' : snapshot.files?.[operation.path] || '',
    after: operation.delete ? '' : operation.content || '',
  }));
}

export function shorten(value, length = 10) { return value ? String(value).slice(0, length) : '—'; }
export function pretty(value) { return JSON.stringify(value, null, 2); }
