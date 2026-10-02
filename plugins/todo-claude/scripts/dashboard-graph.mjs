// Task dependency graph dialog. Pure client-side: it reads /api/status and draws
// an SVG DAG of blocker -> dependent edges, including closed tasks whose
// dependencies are kept in history.

function graphClient() {
  const NS = "http://www.w3.org/2000/svg";
  const NODE_W = 230;
  const NODE_H = 30;
  const COL_GAP = 90;
  const ROW_GAP = 12;
  const PAD = 24;
  const dialog = document.querySelector("#graph-dialog");
  const canvas = document.querySelector("#graph-canvas");
  const status = document.querySelector("#graph-status");
  const activeOnly = document.querySelector("#graph-active-only");
  const standalone = document.querySelector("#graph-standalone");
  let tasks = [];

  const el = (name, attrs = {}, parent) => {
    const node = document.createElementNS(NS, name);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    if (parent) parent.appendChild(node);
    return node;
  };
  const closed = (task) => task.status === "completed" || task.status === "canceled" || task.status === "rejected";
  const number = (id) => Number.parseInt(id, 10) || 0;

  function build() {
    const visible = tasks.filter((task) => !activeOnly.checked || !closed(task));
    const byId = new Map(visible.map((task) => [task.id, task]));
    const parents = new Map(visible.map((task) => [task.id, []]));
    const children = new Map(visible.map((task) => [task.id, []]));
    let edgeCount = 0;
    for (const task of visible) {
      for (const blocker of task.blockers || []) {
        if (!byId.has(blocker) || blocker === task.id) continue;
        parents.get(task.id).push(blocker);
        children.get(blocker).push(task.id);
        edgeCount += 1;
      }
    }
    const nodes = visible.filter((task) => standalone.checked ||
      parents.get(task.id).length > 0 || children.get(task.id).length > 0);

    // Layer = longest blocker chain. The visiting guard keeps a corrupt cyclic
    // dependency list from recursing forever.
    const layer = new Map();
    const visiting = new Set();
    const depth = (id) => {
      if (layer.has(id)) return layer.get(id);
      if (visiting.has(id)) return 0;
      visiting.add(id);
      let value = 0;
      for (const parent of parents.get(id)) value = Math.max(value, depth(parent) + 1);
      visiting.delete(id);
      layer.set(id, value);
      return value;
    };
    for (const task of nodes) depth(task.id);

    const columns = [];
    for (const task of nodes) (columns[layer.get(task.id)] ||= []).push(task);
    const position = new Map();
    columns.forEach((column, index) => {
      if (!column) return;
      // Order by the mean row of already-placed blockers to keep edges short.
      const score = (task) => {
        const rows = parents.get(task.id).map((id) => position.get(id)?.row).filter((row) => row !== undefined);
        return rows.length ? rows.reduce((sum, row) => sum + row, 0) / rows.length : Number.POSITIVE_INFINITY;
      };
      column.sort((left, right) => score(left) - score(right) || number(left.id) - number(right.id));
      column.forEach((task, row) => position.set(task.id, {
        row, x: PAD + index * (NODE_W + COL_GAP), y: PAD + row * (NODE_H + ROW_GAP),
      }));
    });

    canvas.replaceChildren();
    const width = PAD * 2 + columns.length * (NODE_W + COL_GAP) - COL_GAP;
    const height = PAD * 2 + Math.max(1, ...columns.map((column) => (column || []).length)) * (NODE_H + ROW_GAP);
    const svg = el("svg", { width: Math.max(width, 200), height, role: "img", "aria-label": "Task dependency graph" }, canvas);
    const defs = el("defs", {}, svg);
    const marker = el("marker", { id: "graph-arrow", viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: "auto" }, defs);
    el("path", { d: "M0,0 L8,4 L0,8 z", fill: "currentColor" }, marker);

    const edges = [];
    const edgeLayer = el("g", { class: "graph-edges" }, svg);
    for (const task of nodes) {
      const to = position.get(task.id);
      for (const blocker of parents.get(task.id)) {
        const from = position.get(blocker);
        if (!from) continue;
        const x1 = from.x + NODE_W;
        const y1 = from.y + NODE_H / 2;
        const x2 = to.x;
        const y2 = to.y + NODE_H / 2;
        const bend = Math.max(30, (x2 - x1) / 2);
        const path = el("path", {
          class: "graph-edge", "marker-end": "url(#graph-arrow)",
          d: "M" + x1 + "," + y1 + " C" + (x1 + bend) + "," + y1 + " " + (x2 - bend) + "," + y2 + " " + x2 + "," + y2,
        }, edgeLayer);
        edges.push({ path, from: blocker, to: task.id });
      }
    }

    const nodeEls = new Map();
    const nodeLayer = el("g", {}, svg);
    for (const task of nodes) {
      const { x, y } = position.get(task.id);
      const group = el("g", { class: "graph-node status-" + String(task.status).replace(/[^a-z0-9_-]/gi, ""), transform: "translate(" + x + "," + y + ")", tabindex: 0 }, nodeLayer);
      el("rect", { width: NODE_W, height: NODE_H, rx: 5 }, group);
      const title = String(task.title || task.id);
      const label = el("text", { x: 8, y: NODE_H / 2 + 4 }, group);
      label.textContent = number(task.id) + " " + (title.length > 30 ? title.slice(0, 29) + "…" : title);
      el("title", {}, group).textContent = task.id + "\n" + task.status + (task.title ? "\n" + task.title : "");
      const open = () => { location.href = "/?q=" + encodeURIComponent("id:" + number(task.id)); };
      group.addEventListener("click", open);
      group.addEventListener("keydown", (event) => { if (event.key === "Enter") open(); });
      nodeEls.set(task.id, group);
    }

    // Hover/focus highlights the node with every upstream and downstream task.
    const related = (id) => {
      const seen = new Set([id]);
      const walk = (start, next) => {
        const stack = [start];
        while (stack.length) for (const other of next.get(stack.pop()) || []) {
          if (!seen.has(other)) { seen.add(other); stack.push(other); }
        }
      };
      walk(id, parents);
      walk(id, children);
      return seen;
    };
    const focus = (id) => {
      const keep = id ? related(id) : null;
      for (const [other, node] of nodeEls) node.classList.toggle("dim", Boolean(keep) && !keep.has(other));
      for (const edge of edges) {
        const on = !keep || (keep.has(edge.from) && keep.has(edge.to));
        edge.path.classList.toggle("dim", !on);
        edge.path.classList.toggle("hot", Boolean(keep) && on);
      }
    };
    for (const [id, node] of nodeEls) {
      node.addEventListener("mouseenter", () => focus(id));
      node.addEventListener("focus", () => focus(id));
      node.addEventListener("mouseleave", () => focus(null));
      node.addEventListener("blur", () => focus(null));
    }

    status.textContent = nodes.length + " tasks · " + edgeCount + " dependencies" +
      (nodes.length === 0 ? " · nothing to show" : "");
  }

  async function load() {
    status.textContent = "Loading…";
    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      tasks = (await response.json()).tasks || [];
      build();
    } catch (error) {
      status.textContent = "Graph unavailable: " + error.message;
    }
  }

  document.querySelector("#graph-open").addEventListener("click", () => {
    dialog.showModal();
    load();
  });
  activeOnly.addEventListener("change", build);
  standalone.addEventListener("change", build);
}

export const GRAPH_SCRIPT = `(${graphClient.toString()})();`;

export const GRAPH_STYLE = `
#graph-dialog { box-sizing: border-box; width: calc(100vw - 24px); height: calc(100dvh - 24px); max-width: none; padding: 0; border-radius: 10px; }
#graph-dialog[open] { display: flex; flex-direction: column; }
.graph-header { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 12px 16px; border-bottom: 1px solid #8885; }
.graph-header h2 { margin: 0; font-size: 18px; }
.graph-header label { display: inline-flex; align-items: center; gap: 5px; font-size: 13px; }
#graph-status { margin-left: auto; opacity: .7; font-size: 13px; }
#graph-canvas { flex: 1; min-height: 0; overflow: auto; }
#graph-canvas svg { display: block; color: #8888; }
.graph-edge { fill: none; stroke: currentColor; stroke-width: 1.4; }
.graph-edge.hot { stroke: #2563eb; color: #2563eb; stroke-width: 2.2; }
.graph-edge.dim, .graph-node.dim { opacity: .12; }
.graph-node { cursor: pointer; outline: none; }
.graph-node rect { fill: #8881; stroke: #8888; stroke-width: 1.2; }
.graph-node text { fill: CanvasText; font-size: 12px; pointer-events: none; }
.graph-node:hover rect, .graph-node:focus rect { stroke-width: 2.4; }
.graph-node.status-running rect, .graph-node.status-waiting-input rect { fill: #d9770633; stroke: #d97706; }
.graph-node.status-completed rect { fill: #16a34a26; stroke: #16a34a; }
.graph-node.status-failed rect { fill: #dc262633; stroke: #dc2626; }
.graph-node.status-blocked rect { fill: #7c3aed26; stroke: #7c3aed; }
.graph-node.status-merge-queued rect { fill: #0284c726; stroke: #0284c7; }
.graph-node.status-merge-conflict rect { fill: #ea580c33; stroke: #ea580c; }
.graph-node.status-canceled rect, .graph-node.status-rejected rect { stroke-dasharray: 4 3; }
.graph-legend { display: flex; flex-wrap: wrap; gap: 12px; padding: 8px 16px; border-top: 1px solid #8885; font-size: 12px; }
.graph-legend i { display: inline-block; width: 10px; height: 10px; margin-right: 5px; border-radius: 2px; border: 1.5px solid; }
`;

export const GRAPH_HTML = `
<dialog id="graph-dialog" aria-labelledby="graph-title">
  <div class="graph-header">
    <h2 id="graph-title">Task graph</h2>
    <label><input type="checkbox" id="graph-active-only"> Active only</label>
    <label><input type="checkbox" id="graph-standalone"> Show tasks without dependencies</label>
    <span id="graph-status" role="status"></span>
    <form method="dialog"><button type="submit">Close</button></form>
  </div>
  <div id="graph-canvas" tabindex="0" aria-label="Task dependency graph"></div>
  <div class="graph-legend" aria-hidden="true">
    <span><i style="border-color:#16a34a"></i>completed</span>
    <span><i style="border-color:#d97706"></i>running / waiting</span>
    <span><i style="border-color:#7c3aed"></i>blocked</span>
    <span><i style="border-color:#dc2626"></i>failed</span>
    <span><i style="border-color:#0284c7"></i>merge queued</span>
    <span><i style="border-color:#8888"></i>queued</span>
    <span>arrow: blocker → dependent · hover highlights the chain · click filters the table</span>
  </div>
</dialog>
`;
