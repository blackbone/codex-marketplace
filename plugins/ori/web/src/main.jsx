import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlow, Background, Controls, Handle, Position, useNodesState, useEdgesState, ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { changeFiles, graphData, sourcePath, shorten, pretty } from './model.js';
import { layoutGraph } from './layout.js';
import './style.css';

const fragment = new URLSearchParams(location.hash.slice(1));
const incomingToken = fragment.get('token');
if (incomingToken) {
  sessionStorage.setItem('ori-session', incomingToken);
  history.replaceState(null, '', location.pathname + location.search);
}
const token = sessionStorage.getItem('ori-session') || '';
async function api(path, body, options = {}) {
  const response = await fetch(path, {
    ...options,
    method: options.method || (body === undefined ? 'GET' : 'POST'),
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 401) throw new Error('Open the full session link printed by ori web.');
  let result;
  try { result = await response.json(); } catch { throw new Error(`Ori returned an unreadable response (${response.status}).`); }
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : result.error?.message || result.message || `Request failed (${response.status})`);
  return result;
}

function Icon({ name, size = 18, ...props }) {
  const paths = {
    atlas: <><rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="15" y="4" width="6" height="6" rx="1.5"/><rect x="10" y="15" width="6" height="6" rx="1.5"/><path d="M9 6h6M6 9v9h4m8-8v8h-2"/></>,
    scout: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
    lens: <><path d="m12 3 10 5-10 5L2 8l10-5Z"/><path d="m2 12 10 5 10-5M2 16l10 5 10-5"/></>,
    forge: <><path d="m8 5-5 7 5 7m8-14 5 7-5 7m-3-16-2 18"/></>,
    branch: <><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10m12-10v2a4 4 0 0 1-4 4H6"/></>,
    changes: <><path d="M4 5h16M4 12h10M4 19h16m-3-10 3 3-3 3"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    close: <path d="m6 6 12 12M6 18 18 6"/>,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>,
    check: <path d="m5 12 4 4L19 6"/>,
    refresh: <><path d="M20 10a8 8 0 1 0-2 8M20 4v6h-6"/></>,
    file: <><path d="M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 12h8m-8 4h6"/></>,
    settings: <><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/></>,
    export: <><path d="M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6"/></>,
    warning: <><path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3v1"/></>,
    link: <><path d="m10 14 4-4m-5 7-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2-2 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name] || paths.file}</svg>;
}
function Logo() { return <span className="ori-logo" aria-hidden="true"><svg width="34" height="34" viewBox="0 0 34 34"><path d="M17 2 31 10v14L17 32 3 24V10Z" fill="currentColor"/><ellipse cx="17" cy="17" rx="9" ry="5.6" fill="var(--logo-cutout)"/><circle cx="17" cy="17" r="3" fill="currentColor"/></svg></span>; }
function Badge({ children, tone = '' }) { return <span className={`badge ${tone}`}>{children}</span>; }
function Empty({ icon = 'atlas', title, children, action }) { return <div className="empty"><span className="empty-icon"><Icon name={icon} size={30}/></span><h3>{title}</h3>{children && <p>{children}</p>}{action}</div>; }
function ErrorNote({ error }) { return error ? <div className="error-note" role="alert"><Icon name="warning"/><span>{error}</span></div> : null; }
function Json({ value }) { return <pre className="json">{pretty(value)}</pre>; }
// Keep keyboard navigation inside the active dialog and return focus on close.
function useDialog(onClose, busy) {
  const ref = useRef(null);
  const state = useRef({ onClose, busy });
  state.current = { onClose, busy };
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    const controls = () => [...dialog.querySelectorAll('button, input, textarea, select, summary, [tabindex="0"]')].filter(el => !el.disabled && el.getClientRects().length);
    (dialog.querySelector('input, textarea, select') || controls()[0])?.focus();
    const keydown = event => {
      if (event.key === 'Escape' && !state.current.busy) {
        event.preventDefault(); state.current.onClose();
      }
      if (event.key !== 'Tab') return;
      const items = controls();
      const first = items[0], last = items.at(-1);
      if (!items.length) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); if (previous?.isConnected) previous.focus(); };
  }, []);
  return ref;
}

function download(filename, value) {
  const url = URL.createObjectURL(new Blob([pretty(value) + '\n'], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function OriNode({ data, selected }) {
  return <div className={`graph-node ${data.kind} ${data.constraint ? 'constraint' : ''} ${data.dimmed ? 'dimmed' : ''} ${selected ? 'selected' : ''}`}>
    <Handle type="target" position={Position.Left}/>
    <div className="node-eyebrow"><span className="node-dot"/>{data.constraint ? 'constraint' : data.kind === 'entity' ? 'entity' : data.type}</div>
    <div className="node-name">{data.name || data.id}</div>
    
    <Handle type="source" position={Position.Right}/>
  </div>;
}
const nodeTypes = { ori: OriNode };
function Graph({ snapshot, selected, onSelect, filter, layoutKey }) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [instance, setInstance] = useState(null);
  const [error, setError] = useState('');
  const [arranging, setArranging] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const data = graphData(snapshot, selected);
    setArranging(true);
    (async () => {
      const positions = await layoutGraph(data, 1.7);
      if (cancelled) return;
      setNodes(data.nodes.map(node => ({ ...node, position: positions.get(node.id) })));
      setEdges(data.edges);
      setError('');
      requestAnimationFrame(() => requestAnimationFrame(() => instance?.fitView({ padding: 0.08, duration: 250, maxZoom: 1 })));
    })().catch(err => { if (!cancelled) setError(err.message); }).finally(() => { if (!cancelled) setArranging(false); });
    return () => { cancelled = true; };
  }, [snapshot.revision, snapshot.digest, layoutKey, instance]);
  useEffect(() => {
    const values = new Map(graphData(snapshot, selected, filter).nodes.map(node => [node.id, node]));
    setNodes(current => current.map(node => ({ ...node, selected: selected === node.id, data: values.get(node.id)?.data || node.data })));
  }, [selected, filter, snapshot]);
  return <div className="graph-canvas">
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onNodeClick={(_, node) => onSelect(node.id)} onInit={setInstance} minZoom={0.15} maxZoom={1.7} fitView fitViewOptions={{ padding: 0.08, maxZoom: 1 }} nodesConnectable={false} deleteKeyCode={null} proOptions={{ hideAttribution: true }} ariaLabelConfig={{ 'controls.zoomIn.ariaLabel': 'Zoom in', 'controls.zoomOut.ariaLabel': 'Zoom out', 'controls.fitView.ariaLabel': 'Fit graph' }}>
      <Background color="var(--graph-grid)" gap={22} size={1}/><Controls showInteractive={false}/>
    </ReactFlow>
    {arranging && <span className="canvas-status"><span className="spinner"/>Arranging graph</span>}
    {error && <div className="canvas-error"><ErrorNote error={error}/></div>}
    <div className="graph-legend"><span><i className="legend-entity"/>Entity</span><span><i className="legend-component"/>Component</span><span><i className="legend-constraint"/>Constraint</span></div>
  </div>;
}

function Inspector({ snapshot, selected, onSelect, onEdit, readOnly = false }) {
  const entity = (snapshot.entities || []).find(item => item.id === selected);
  const component = (snapshot.components || []).find(item => item.id === selected);
  const item = entity || component;
  const [impact, setImpact] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setImpact(null); setError(''); }, [selected]);
  if (!item) return <aside className="inspector"><Empty title="Select a node"></Empty></aside>;
  const links = (snapshot.relations || []).filter(link => link.from === selected || link.to === selected);
  const components = entity ? (snapshot.components || []).filter(c => c.entityId === selected) : [];
  const path = sourcePath(snapshot, selected);
  const loadImpact = async () => { setBusy(true); try { setImpact(await api(`/api/impact?ids=${encodeURIComponent(selected)}`)); } catch (err) { setError(err.message); } finally { setBusy(false); } };
  return <aside className="inspector">
    <div className="inspector-heading"><Badge tone={component?.constraint ? 'amber' : 'green'}>{entity ? 'Entity' : component.type}</Badge></div>
    <h2>{item.name || item.id}</h2><div className="mono muted item-id">{item.id}</div>
    {(item.tags || []).length > 0 && <div className="tags">{item.tags.map(tag => <Badge key={tag}>{tag}</Badge>)}</div>}
    {component?.entityId && <button className="owner-link" onClick={() => onSelect(component.entityId)}><Icon name="atlas" size={15}/>{component.entityId}<Icon name="arrow" size={14}/></button>}
    {component?.text && <div className="component-text">{component.text}</div>}
    {component?.body && <div className="file-path" style={{ marginTop: 12 }}><Icon name="file" size={14}/>{component.body}</div>}
    {component?.data !== undefined && <section className="inspector-section"><h4>Structured data</h4><Json value={component.data}/></section>}
    {entity && <section className="inspector-section"><h4>Components <span>{components.length}</span></h4><div className="item-list">{components.map(c => <button key={c.id} onClick={() => onSelect(c.id)}><span className={`item-dot ${c.constraint ? 'amber' : ''}`}/><span><strong>{c.name || c.id}</strong><small>{c.type}</small></span><Icon name="arrow" size={14}/></button>)}{!components.length && <p className="muted small">No components attached yet.</p>}</div></section>}
    <section className="inspector-section"><h4>Connections <span>{links.length}</span></h4>{links.map(link => <button className="connection" key={link.id} onClick={() => onSelect(link.from === selected ? link.to : link.from)}><small>{link.type}</small><span>{link.from === selected ? link.to : link.from}<Icon name="arrow" size={14}/></span></button>)}{!links.length && <p className="muted small">No explicit relationships.</p>}</section>
    <section className="inspector-section"><h4>Graph file</h4><span className="file-path"><Icon name="file" size={14}/>{path || 'Unavailable'}</span>{readOnly ? <p className="small muted" style={{ marginTop: 12 }}>Return to the working graph to propose an edit.</p> : <button className="button full" disabled={!path} onClick={() => onEdit(path)}>Propose an edit<Icon name="arrow" size={15}/></button>}</section>
    <button className="text-button" disabled={busy} onClick={loadImpact}><Icon name="link" size={15}/>{busy ? 'Tracing connections…' : 'Trace change impact'}</button>
    <ErrorNote error={error}/>{impact && <section className="impact"><h4>{impact.ids?.length || 0} connected items</h4>{impact.truncated && <p className="warning-text">The traversal limit was reached. This impact set is incomplete.</p>}<div className="tags">{(impact.ids || []).map(id => <button key={id} onClick={() => onSelect(id)} title={(impact.reasons?.[id] || []).join(', ')}>{id}</button>)}</div></section>}
  </aside>;
}

const templates = {
  entity: { path: 'entities/new-entity.json', content: { id: 'new-entity', name: 'New entity', tags: [] } },
  component: { path: 'components/new-component.json', content: { id: 'new-component', entityId: '', type: 'behavior', name: 'New behavior', text: '' } },
  relation: { path: 'relations/new-relation.json', content: { id: 'new-relation', type: 'depends-on', from: '', to: '' } },
  projection: { path: 'projections/new-projection.json', content: { id: 'new-projection', name: 'New projection', entities: [], types: [], relationTypes: ['*'], depth: 64 } },
};

function ProposalEditor({ snapshot, path: initialPath, initialKind = 'entity', onClose, onCreated }) {
  const [kind, setKind] = useState(initialKind);
  const [path, setPath] = useState(initialPath || templates[initialKind].path);
  const [content, setContent] = useState(initialPath ? snapshot.files[initialPath] : pretty(templates[initialKind].content) + '\n');
  const [intent, setIntent] = useState('');
  const [remove, setRemove] = useState(false);
  const [operations, setOperations] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dialog = useDialog(onClose, busy);
  const chooseKind = value => { setKind(value); setPath(templates[value].path); setContent(pretty(templates[value].content) + '\n'); setRemove(false); };
  function currentOperation() {
    if (!path.trim()) throw new Error('Enter a graph-relative file path.');
    if (!remove && path.endsWith('.json')) JSON.parse(content);
    return { path: path.trim(), ...(remove ? { delete: true } : { content }) };
  }
  function stageFile() { try { const next = currentOperation(); setOperations(old => [...old.filter(item => item.path !== next.path), next]); setError(''); } catch (err) { setError(err.message); } }
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const next = currentOperation();
      const change = await api('/api/change', { intent, baseRevision: snapshot.revision, operations: [...operations.filter(item => item.path !== next.path), next] });
      onCreated(change);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}><section ref={dialog} className="modal editor-modal" role="dialog" aria-modal="true" aria-labelledby="editor-title"><header><div><h2 id="editor-title">New proposal</h2></div><button className="icon-button" aria-label="Close editor" onClick={onClose}><Icon name="close"/></button></header><form onSubmit={submit}>
    <label>What should change?<textarea className="intent-input" required value={intent} onChange={event => setIntent(event.target.value)} placeholder="Describe the intent and why this change belongs in the product." rows={2}/></label>
    <div className="editor-file-row"><label className="grow">Graph-relative file<input value={path} onChange={event => setPath(event.target.value)} required spellCheck={false}/></label><label>Template<select value={kind} onChange={event => chooseKind(event.target.value)}>{Object.keys(templates).map(value => <option key={value} value={value}>{value}</option>)}</select></label></div>
    <div className="editor-meta"><span><Icon name="branch" size={14}/>Base {shorten(snapshot.revision)}</span><label className="checkbox"><input type="checkbox" checked={remove} onChange={event => setRemove(event.target.checked)}/>Delete this file</label></div>
    {!remove && <textarea className="code-editor" aria-label="Graph file content" value={content} onChange={event => setContent(event.target.value)} spellCheck={false} rows={15}/>}
    {operations.length > 0 && <div className="staged-files">{operations.map(operation => <button type="button" key={operation.path} onClick={() => { setPath(operation.path); setContent(operation.content || ''); setRemove(!!operation.delete); }}><Icon name="file" size={13}/>{operation.path}<span>{operation.delete ? 'delete' : 'staged'}</span></button>)}</div>}
    <ErrorNote error={error}/><footer><button className="button" type="button" onClick={stageFile}>Stage file</button><button className="button primary" disabled={busy || !intent.trim()}>{busy ? 'Validating…' : 'Create proposal'}<Icon name="arrow" size={15}/></button></footer>
  </form></section></div>;
}

function ChangeReview({ change, snapshot, onClose, onUpdated }) {
  const [reviewer, setReviewer] = useState('');
  const [summary, setSummary] = useState('');
  const [questions, setQuestions] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dialog = useDialog(onClose, busy);
  const [expanded, setExpanded] = useState(change.operations?.[0]?.path);
  async function review(approved) {
    setBusy(true); setError('');
    try { onUpdated(await api('/api/change/review', { id: change.id, baseRevision: change.baseRevision, proposalDigest: change.proposalDigest, reviewer, summary, approved, questions: questions.split('\n').map(q => q.trim()).filter(Boolean) })); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function apply() { setBusy(true); setError(''); try { onUpdated(await api('/api/change/apply', { id: change.id })); } catch (err) { setError(err.message); } finally { setBusy(false); } }
  const files = changeFiles(change, snapshot);
  const canApply = change.review?.approved && !change.review?.questions?.length && change.status !== 'applied';
  return <div className="modal-backdrop"><section ref={dialog} className="modal review-modal" role="dialog" aria-modal="true" aria-labelledby="review-title"><header><div><h2 id="review-title">{change.intent || 'Review change'}</h2></div><button className="icon-button" aria-label="Close review" onClick={onClose}><Icon name="close"/></button></header>
    <div className="review-scroll"><div className="review-meta"><Badge tone={change.status === 'applied' ? 'green' : 'amber'}>{change.status || 'proposed'}</Badge><span className="mono muted">{change.id}</span><span className="mono muted">Base {shorten(change.baseRevision)}</span></div>
    {change.baseRevision !== snapshot.revision && change.status !== 'applied' && <ErrorNote error="The graph changed after this proposal. Applying it will require a fresh proposal against the current revision."/>}
    <section className="review-impact"><h4>Affected files <span>{change.operations?.length || 0}</span></h4>
      {files.map(operation => <div className="file-diff" key={operation.path}><button className="diff-heading" onClick={() => setExpanded(expanded === operation.path ? null : operation.path)}><Icon name="file" size={15}/><strong>{operation.path}</strong><Badge tone={operation.delete ? 'red' : 'green'}>{operation.delete ? 'delete' : operation.before ? 'edit' : 'add'}</Badge><span>{expanded === operation.path ? '−' : '+'}</span></button>{expanded === operation.path && <div className="diff-columns"><section><h5>{change.before ? 'Before proposal' : 'Current graph (original unavailable)'}</h5><pre>{operation.before || '(new file)'}</pre></section><section><h5>Proposed</h5><pre>{operation.delete ? '(deleted)' : operation.content}</pre></section></div>}</div>)}
    </section>
    {change.impact && <section className="review-impact"><h4>Connected impact</h4>{change.impact.truncated && <p className="warning-text">Impact traversal is incomplete.</p>}<div className="tags">{(change.impact.ids || []).map(id => <Badge key={id}>{id}</Badge>)}</div></section>}
    {change.review && <section className="review-receipt"><Icon name={change.review.approved ? 'check' : 'warning'}/><div><strong>{change.review.approved ? 'Review recorded' : 'Changes requested'} · {change.review.reviewer}</strong><p>{change.review.summary}</p>{(change.review.questions || []).map(question => <p key={question}>• {question}</p>)}</div></section>}
    {change.status !== 'applied' && <section className="review-form"><h3>Review</h3><label>Reviewer<input value={reviewer} onChange={event => setReviewer(event.target.value)} placeholder="Your name or reviewing agent"/></label><label>Assessment<textarea value={summary} onChange={event => setSummary(event.target.value)} placeholder="Explain what was checked and why this proposal is consistent." rows={3}/></label><label>Open questions (one per line)<textarea value={questions} onChange={event => setQuestions(event.target.value)} placeholder="Leave empty when no intent decisions remain." rows={2}/></label></section>}
    <ErrorNote error={error}/></div><footer>{change.status !== 'applied' && <><button className="button" disabled={busy || !reviewer.trim() || !summary.trim()} onClick={() => review(false)}>Request changes</button><button className="button" disabled={busy || !reviewer.trim() || !summary.trim() || !!questions.trim()} onClick={() => review(true)}>Approve review</button><button className="button primary" disabled={busy || !canApply || change.baseRevision !== snapshot.revision} onClick={apply}>{busy ? 'Working…' : 'Apply to graph'}<Icon name="arrow" size={15}/></button></>}{change.status === 'applied' && <button className="button primary" onClick={onClose}>Done<Icon name="check" size={15}/></button>}</footer>
  </section></div>;
}

function Scout({ snapshot, onSelect, provider }) {
  const [query, setQuery] = useState('');
  const [lexical, setLexical] = useState(provider === 'off');
  useEffect(() => { if (provider === 'off') setLexical(true); }, [provider]);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async event => { event.preventDefault(); setBusy(true); setError(''); try { setResult(await api(`/api/search?q=${encodeURIComponent(query)}&lexical=${lexical}`)); } catch (err) { setError(err.message); } finally { setBusy(false); } };
  return <div className="content-view scout-view"><div className="section-intro"><h1>Search</h1></div><form className="search-form" onSubmit={submit}><Icon name="scout" size={22}/><input aria-label="Search graph" value={query} onChange={event => setQuery(event.target.value)} placeholder="What should happen when a payment fails?" maxLength={4000}/><button className="button primary" disabled={busy || !query.trim()}>{busy ? <span className="spinner"/> : <Icon name="arrow"/>}Search</button></form><div className="search-options"><label className="checkbox"><input type="checkbox" checked={lexical} disabled={provider === 'off'} onChange={event => setLexical(event.target.checked)}/>Text matching only</label></div>
    {busy && <div className="model-progress"><span className="spinner"/><div><strong>{lexical ? 'Searching your text index' : 'Searching your graph locally'}</strong><p>{lexical ? 'Matching files in the current graph revision.' : 'The first semantic search downloads the model. This can take several minutes; later searches reuse it.'}</p></div></div>}
    <ErrorNote error={error}/>{result && <section className="search-results"><div className="results-heading"><h3>{result.hits?.length || 0} results</h3><Badge>{result.mode}</Badge><span className="mono muted small">{shorten(result.revision)}</span></div>{(result.hits || []).map(hit => <button key={hit.id} className="search-hit" onClick={() => onSelect(hit.id)}><div className="search-hit-top"><Icon name="file"/><strong>{hit.id}</strong><Icon name="arrow" size={16}/></div><p>{hit.text?.slice(0, 900)}</p><div><span className="mono small muted">{hit.path}</span><div className="tags">{(hit.reasons || []).map(reason => <Badge key={reason}>{reason}</Badge>)}</div></div></button>)}{!result.hits?.length && <Empty icon="scout" title="No matching context">Try another phrase or an exact entity identifier.</Empty>}</section>}

  </div>;
}

function Lens({ snapshot, onPreview, onEdit }) {
  const [selected, setSelected] = useState(snapshot.projections?.[0]?.id || '');
  const [projection, setProjection] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const build = async () => { setBusy(true); setError(''); try { setProjection(await api(`/api/projection?id=${encodeURIComponent(selected)}`)); } catch (err) { setError(err.message); } finally { setBusy(false); } };
  return <div className="content-view lens-view"><div className="section-intro"><h1>Projections</h1></div>
    <section className="panel"><div className="panel-heading"><div><h3>Create a projection</h3></div><Badge tone="green">Working graph</Badge></div><div className="projection-specs" role="group" aria-label="Projection">{(snapshot.projections || []).map(spec => <button key={spec.id} aria-pressed={selected === spec.id} className={`projection-spec ${selected === spec.id ? 'active' : ''}`} onClick={() => { setSelected(spec.id); setProjection(null); }}><Icon name="lens"/><span><strong>{spec.name || spec.id}</strong><small>{spec.types?.length ? spec.types.join(', ') : 'All component types'} · depth {spec.depth}</small></span><Badge>{spec.id}</Badge></button>)}</div>{!snapshot.projections?.length && <Empty icon="lens" title="No projection definitions" action={<button className="button" onClick={onEdit}>Create a definition</button>}/>}{snapshot.projections?.length > 0 && <div className="panel-actions"><button className="button primary" disabled={busy || !selected} onClick={build}>{busy ? 'Projecting…' : 'Build projection'}<Icon name="arrow" size={15}/></button></div>}</section><ErrorNote error={error}/>
    {projection && <section className="panel projection-result"><div className="panel-heading"><div><h3>{projection.spec?.name || projection.id}</h3></div><Badge tone="green"><Icon name="check" size={12}/>Validated</Badge></div><div className="metric-row"><div><strong>{projection.entities?.length || 0}</strong><small>Entities</small></div><div><strong>{projection.components?.length || 0}</strong><small>Components</small></div><div><strong>{projection.relations?.length || 0}</strong><small>Relations</small></div></div><dl className="metadata"><dt>Graph revision</dt><dd>{projection.graphRevision}</dd><dt>Projection digest</dt><dd>{projection.digest}</dd>{projection.graphCommit && <><dt>Git commit</dt><dd>{projection.graphCommit}</dd></>}</dl>{projection.truncated && <ErrorNote error="This projection reached its traversal limit and may omit connected context."/>}<div className="panel-actions"><button className="button" onClick={() => onPreview(projection)}><Icon name="atlas" size={15}/>View graph</button><button className="button primary" onClick={() => download(`ori-${projection.id}-${shorten(projection.digest)}.json`, projection)}><Icon name="export" size={15}/>Export snapshot</button></div></section>}
  </div>;
}

function Forge({ runs, graphRevision }) {
  const [selected, setSelected] = useState(null);
  const active = selected ? runs.find(run => run.id === selected) : runs[0];
  return <div className="content-view forge-view"><div className="section-intro"><h1>Source runs</h1></div>
    
    {!runs.length ? <Empty icon="forge" title="No source runs yet">Start a run with <code>$ori:build</code>.</Empty> : <div className="run-layout"><div className="run-list">{runs.map(run => <button key={run.id} onClick={() => setSelected(run.id)} className={active?.id === run.id ? 'active' : ''}><div><strong>{run.id}</strong><Badge tone={run.status === 'verified' || run.status === 'completed' ? 'green' : 'amber'}>{run.status}</Badge></div><small>{run.intent || run.projectionId || run.branch || 'Source run'}</small></button>)}</div>{active && <section className="panel run-detail"><div className="panel-heading"><h3>Execution record</h3><Badge>{active.status}</Badge></div><div className="run-freshness"><Badge tone={active.graphRevision === graphRevision ? 'green' : 'amber'}>{active.graphRevision === graphRevision ? 'Matches working graph' : 'Earlier or different graph'}</Badge><p className="small">Checks apply to the recorded source commit.</p></div><dl className="metadata">{['id', 'branch', 'projectionDigest', 'graphRevision', 'sourceCommit', 'worktree', 'createdAt'].filter(key => active[key]).map(key => <React.Fragment key={key}><dt>{key === 'id' ? 'Run ID' : key.replace(/([A-Z])/g, ' $1').replace(/^./, value => value.toUpperCase())}</dt><dd>{active[key]}</dd></React.Fragment>)}</dl>{active.questions?.length > 0 && <ErrorNote error={`Input needed: ${active.questions.join(' · ')}`}/>}<details><summary>Evidence and attempts</summary><Json value={active}/></details></section>}</div>}
  </div>;
}

function Changes({ changes, onReview, onNew }) {
  return <div className="content-view changes-view"><div className="section-intro row-intro"><div><h1>Changes</h1></div><button className="button primary" onClick={onNew}><Icon name="plus" size={16}/>New proposal</button></div>{!changes.length ? <Empty icon="changes" title="No proposals yet" action={<button className="button" onClick={onNew}>Create a proposal<Icon name="arrow" size={15}/></button>}></Empty> : <div className="change-list">{changes.map(change => <button key={change.id} className="change-card" onClick={() => onReview(change)}><span className="change-icon"><Icon name={change.status === 'applied' ? 'check' : 'changes'}/></span><div><h3>{change.intent || change.id}</h3><p><span className="mono">{shorten(change.id, 20)}</span><span>{change.operations?.length || 0} files</span><span>Base {shorten(change.baseRevision)}</span></p></div><Badge tone={change.status === 'applied' ? 'green' : 'amber'}>{change.status || 'proposed'}</Badge><Icon name="arrow"/></button>)}</div>}</div>;
}

function Settings({ config, onClose, onSaved }) {
  const [provider, setProvider] = useState(config.embeddings?.provider || 'local');
  const [command, setCommand] = useState(pretty(config.executor?.command || []));
  const [checks, setChecks] = useState(pretty(config.executor?.checks || []));
  const [attempts, setAttempts] = useState(config.executor?.maxAttempts || 2);
  const [timeout, setTimeoutValue] = useState(config.executor?.timeoutSeconds || 1800);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const dialog = useDialog(onClose, busy);
  async function save(event) {
    event.preventDefault(); setBusy(true); setError(''); setSaved(false);
    try {
      const nextCommand = JSON.parse(command), nextChecks = JSON.parse(checks);
      if (!Array.isArray(nextCommand) || nextCommand.some(value => typeof value !== 'string')) throw new Error('Executor command must be a JSON array of strings.');
      if (!Array.isArray(nextChecks) || nextChecks.some(value => !Array.isArray(value) || value.some(arg => typeof arg !== 'string'))) throw new Error('Checks must be a JSON array of command arrays.');
      await api('/api/config', { ...config, embeddings: { provider }, executor: { command: nextCommand, checks: nextChecks, maxAttempts: Number(attempts), timeoutSeconds: Number(timeout) } }, { method: 'PUT' });
      setSaved(true); await onSaved();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return <div className="modal-backdrop"><section ref={dialog} className="modal config-modal" role="dialog" aria-modal="true" aria-labelledby="config-title"><header><div><h2 id="config-title">Configuration</h2></div><button className="icon-button" aria-label="Close configuration" onClick={onClose}><Icon name="close"/></button></header><form onSubmit={save}>
    <div className="config-location"><Icon name="file" size={15}/><code>.ori/config.json</code><Badge>Graph: {config.graph}</Badge></div>
    <label>Search model<select value={provider} onChange={event => { setProvider(event.target.value); setSaved(false); }}><option value="local">Local multilingual embeddings + text index</option><option value="off">Text index only</option></select></label>{provider === 'local' && <p className="config-hint">Downloads the model on first semantic search.</p>}
    <h3 className="config-section-title">Source execution</h3>
    <label>Executor command · JSON argument array<textarea rows={2} value={command} onChange={event => { setCommand(event.target.value); setSaved(false); }} spellCheck={false} className="config-code"/><span className="config-hint">An empty array uses the default Codex executor.</span></label>
    <label>Verification commands · JSON array of argument arrays<textarea rows={4} value={checks} onChange={event => { setChecks(event.target.value); setSaved(false); }} spellCheck={false} className="config-code" placeholder={'[["go", "test", "./..."]]'} /></label>
    <div className="editor-file-row"><label className="grow">Maximum attempts<input type="number" min="1" max="10" required value={attempts} onChange={event => { setAttempts(event.target.value); setSaved(false); }}/></label><label className="grow">Timeout, seconds<input type="number" min="1" required value={timeout} onChange={event => { setTimeoutValue(event.target.value); setSaved(false); }}/></label></div>
    <ErrorNote error={error}/>{saved && <div className="config-saved" role="status"><Icon name="check" size={16}/>Configuration saved.</div>}
    <footer><button className="button primary" disabled={busy}>{busy ? 'Saving…' : 'Save configuration'}<Icon name="check" size={15}/></button></footer>
  </form></section></div>;
}

function App() {
  const [state, setState] = useState(null);
  const [view, setView] = useState('atlas');
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [editor, setEditor] = useState(null);
  const [review, setReview] = useState(null);
  const [settings, setSettings] = useState(false);
  const [preview, setPreview] = useState(null);
  const [layoutKey, setLayoutKey] = useState(0);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try { const next = await api('/api/state'); setState(next); setError(''); setSelected(current => current || next.snapshot.entities?.[0]?.id || next.snapshot.components?.[0]?.id); }
    catch (err) { setError(err.message); } finally { setRefreshing(false); }
  }, []);
  useEffect(() => { refresh(); const timer = setInterval(refresh, 8000); return () => clearInterval(timer); }, [refresh]);
  const snapshot = state?.snapshot;
  const graphSnapshot = useMemo(() => preview ? { ...preview, revision: preview.graphRevision, files: preview.sourceFiles } : snapshot, [preview, snapshot]);
  const chooseItem = id => { setSelected(id); setPreview(null); setView('atlas'); };
  const changeUpdated = async change => { setReview(change); await refresh(); };
  if (!state) return <div className="boot-screen"><Logo/><h1>Ori</h1>{!error && <p>Opening workspace…</p>}{error ? <><ErrorNote error={error}/><button className="button" onClick={refresh}>Try again</button></> : <span className="spinner"/>}</div>;
  const changes = state.changes || [];
  const runs = state.runs || [];
  const modules = [{ id: 'atlas', label: 'Atlas', purpose: 'Graph' }, { id: 'scout', label: 'Scout', purpose: 'Search' }, { id: 'lens', label: 'Lens', purpose: 'Projections' }, { id: 'forge', label: 'Forge', purpose: 'Source runs' }];
  const pending = changes.filter(change => change.status !== 'applied' && change.status !== 'rejected').length;
  return <div className="app-shell"><aside className="sidebar"><a className="brand" href="#" onClick={event => { event.preventDefault(); setView('atlas'); }}><Logo/><span>ori<span className="brand-period">.</span></span></a><nav aria-label="Workspace modules">{modules.map(module => <button key={module.id} aria-label={module.label} title={module.purpose} aria-current={view === module.id ? 'page' : undefined} className={`nav-item ${view === module.id ? 'active' : ''}`} onClick={() => { setView(module.id); if (module.id === 'atlas') setPreview(null); }}><Icon name={module.id}/><span><strong>{module.label}</strong></span>{view === module.id && <span className="nav-active-dot"/>}</button>)}</nav><div className="sidebar-rule"/><button aria-label="Changes" className={`changes-nav ${view === 'changes' ? 'active' : ''}`} onClick={() => setView('changes')}><Icon name="changes" size={18}/><span>Changes</span>{pending > 0 && <span className="count-bubble">{pending}</span>}</button><div className="sidebar-bottom"><button aria-label="Configuration" title="Configuration" className="settings-button" onClick={() => setSettings(true)}><Icon name="settings" size={17}/><span>Configuration</span></button></div></aside>
    <div className="workspace"><header className="topbar"><div className="breadcrumb"><strong>{view === 'changes' ? 'Changes' : modules.find(module => module.id === view)?.label}</strong></div><div className="topbar-right"><span className="revision" title={snapshot.commit ? `Working graph based on Git commit ${snapshot.commit}` : 'Working graph content revision'}><Icon name="branch" size={14}/>{shorten(snapshot.revision)}</span><button className={`icon-button ${refreshing ? 'refreshing' : ''}`} aria-label="Refresh workspace" onClick={refresh}><Icon name="refresh" size={17}/></button></div></header>
    {error && <div className="global-error"><ErrorNote error={error}/></div>}
    {view === 'atlas' && <><div className="atlas-heading"><div><h1>{preview ? preview.spec?.name || preview.id : 'Graph'}</h1>{preview && <Badge>Projection preview · read-only</Badge>}</div><button className="button primary" onClick={() => setEditor({ path: null })}><Icon name="plus" size={16}/>New proposal</button></div><div className="graph-toolbar"><div className="view-tabs">{preview && <button className="active" onClick={() => setPreview(null)}><Icon name="atlas" size={14}/>Back to working graph</button>}<span>{graphSnapshot.entities?.length || 0} entities</span><span>{graphSnapshot.components?.length || 0} components</span><span>{graphSnapshot.relations?.length || 0} relations</span></div><div className="graph-tools"><label className="filter"><Icon name="scout" size={14}/><input aria-label="Filter visible graph" value={filter} onChange={event => setFilter(event.target.value)} placeholder="Highlight nodes…"/></label><button className="icon-button" onClick={() => setLayoutKey(value => value + 1)} aria-label="Arrange graph"><Icon name="refresh" size={15}/></button></div></div><div className="atlas-body">{!graphSnapshot.entities?.length && !graphSnapshot.components?.length ? <div className="empty-graph"><Empty title="No entities yet" action={<button className="button primary" onClick={() => setEditor({ path: null })}><Icon name="plus" size={16}/>Create the first entity</button>}></Empty></div> : <ReactFlowProvider><Graph snapshot={graphSnapshot} selected={selected} onSelect={setSelected} filter={filter} layoutKey={layoutKey}/></ReactFlowProvider>}{!!(graphSnapshot.entities?.length || graphSnapshot.components?.length) && <Inspector snapshot={graphSnapshot} readOnly={!!preview} selected={selected} onSelect={setSelected} onEdit={path => { if (preview) { setPreview(null); } setEditor({ path }); }}/>}</div></>}
    {view === 'scout' && <Scout snapshot={snapshot} onSelect={chooseItem} provider={state.config.embeddings?.provider}/>}
    {view === 'lens' && <Lens snapshot={snapshot} onEdit={() => setEditor({ path: null, kind: 'projection' })} onPreview={projection => { setPreview(projection); setView('atlas'); setSelected(projection.entities?.[0]?.id); }}/>} 
    {view === 'forge' && <Forge runs={runs} graphRevision={snapshot.revision}/>}
    {view === 'changes' && <Changes changes={changes} onReview={setReview} onNew={() => setEditor({ path: null })}/>}
</div>
    {editor && <ProposalEditor snapshot={snapshot} path={editor.path} initialKind={editor.kind} onClose={() => setEditor(null)} onCreated={change => { setEditor(null); setReview(change); refresh(); }}/>}
    {review && <ChangeReview key={review.id} change={review} snapshot={snapshot} onClose={() => setReview(null)} onUpdated={changeUpdated}/>}
    {settings && <Settings config={state.config} onClose={() => setSettings(false)} onSaved={refresh}/>}
  </div>;
}

createRoot(document.getElementById('root')).render(<App/>);
