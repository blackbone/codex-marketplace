import test from 'node:test';
import assert from 'node:assert/strict';
import { changeFiles, graphData, sourcePath } from './model.js';
import { packGroups } from './layout.js';

test('graph retains cycles and distinguishes ownership from explicit relationships', () => {
  const graph = graphData({ entities: [{ id: 'a' }, { id: 'b' }], components: [{ id: 'c', entityId: 'a' }], relations: [{ id: 'ab', from: 'a', to: 'b', type: 'uses' }, { id: 'ba', from: 'b', to: 'a', type: 'uses' }] }, 'c');
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.edges.length, 3);
  assert.equal(graph.nodes.find(node => node.id === 'c').selected, true);
  assert.deepEqual(graph.edges.slice(1).map(edge => [edge.source, edge.target]), [['a', 'b'], ['b', 'a']]);
});

test('source paths are resolved from actual graph files, not IDs or projections', () => {
  const snapshot = { files: { 'projections/shared.json': '{"id":"shared"}', 'components/nested/context.json': '{"id":"shared"}', 'components/broken.json': '{' } };
  assert.equal(sourcePath(snapshot, 'shared'), 'components/nested/context.json');
  assert.equal(sourcePath(snapshot, 'missing'), null);
});

test('applied changes keep original content and added files have an empty before side', () => {
  const snapshot = { files: { 'entities/new.json': 'new', 'entities/existing.json': 'changed' } };
  const changes = changeFiles({ before: { 'entities/existing.json': 'original' }, operations: [{ path: 'entities/new.json', content: 'new' }, { path: 'entities/existing.json', content: 'changed' }] }, snapshot);
  assert.deepEqual(changes.map(file => file.before), ['', 'original']);
});

test('entity groups pack without overlap in a compact two-dimensional layout', () => {
  const groups = packGroups([{ width: 490, height: 225 }, { width: 490, height: 115 }, { width: 490, height: 115 }, { width: 490, height: 225 }], 1.7);
  assert.equal(new Set(groups.map(group => group.x)).size, 2);
  for (const [index, a] of groups.entries()) {
    for (const b of groups.slice(index + 1)) assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
  }
});
