export function packGroups(groups, aspectRatio = 1.7) {
  if (!groups.length) return [];
  let best;
  for (let columns = 1; columns <= groups.length; columns++) {
    const gap = 48;
    const width = Math.max(...groups.map(group => group.width));
    const rows = Array.from({ length: Math.ceil(groups.length / columns) }, (_, row) => Math.max(...groups.slice(row * columns, (row + 1) * columns).map(group => group.height)));
    const totalWidth = columns * width + (columns - 1) * gap;
    const totalHeight = rows.reduce((sum, height) => sum + height, 0) + (rows.length - 1) * gap;
    const score = Math.abs(Math.log(totalWidth / totalHeight / aspectRatio));
    if (!best || score < best.score) best = { score, columns, width, rows, gap };
  }
  return groups.map((group, index) => ({
    ...group,
    x: (index % best.columns) * (best.width + best.gap),
    y: best.rows.slice(0, Math.floor(index / best.columns)).reduce((sum, height) => sum + height + best.gap, 0),
  }));
}

export async function layoutGraph(data, aspectRatio) {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  const groups = new Map();
  for (const node of data.nodes) {
    const owner = node.data.kind === 'entity' ? node.id : node.data.entityId || node.id;
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner).push(node);
  }
  const layouts = await Promise.all([...groups.entries()].map(([owner, nodes]) => elk.layout({
    id: `group:${owner}`,
    layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.spacing.nodeNode': '22', 'elk.layered.spacing.nodeNodeBetweenLayers': '45' },
    children: nodes.map(node => ({ id: node.id, width: 212, height: 91 })),
    edges: nodes.filter(node => node.id !== owner).map(node => ({ id: `owns:${node.id}`, sources: [owner], targets: [node.id] })),
  })));
  const positions = new Map();
  for (const group of packGroups(layouts, aspectRatio)) {
    for (const node of group.children) positions.set(node.id, { x: group.x + node.x, y: group.y + node.y });
  }
  return positions;
}
