/* Shared graph model: renderer, storage and runtime use the same contract. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object') module.exports = api; else root.Workflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const kinds = new Set(['start', 'action', 'condition', 'end']);
  function validate(graph, parseActions = value => value) {
    if (!graph || graph.version !== 1 || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || graph.nodes.length > 1000 || graph.edges.length > 2000) throw new Error('워크플로우 형식 또는 크기가 잘못되었습니다.');
    const ids = new Set();
    const nodes = graph.nodes.map(node => {
      if (!node || typeof node.id !== 'string' || !/^[\w-]{1,64}$/.test(node.id) || ids.has(node.id) || !kinds.has(node.kind)) throw new Error('노드 ID 또는 종류가 잘못되었습니다.');
      ids.add(node.id);
      if (![node.x, node.y].every(v => Number.isFinite(v) && Math.abs(v) <= 100000)) throw new Error('노드 위치가 잘못되었습니다.');
      const result = { id: node.id, kind: node.kind, name: String(node.name || node.kind).slice(0, 100), x: node.x, y: node.y };
      if (['action', 'condition'].includes(node.kind)) result.action = parseActions([node.action])[0];
      if (node.kind === 'condition' && result.action.type !== 'image_detect') throw new Error('분기 노드는 이미지 감지 조건이 필요합니다.');
      return result;
    });
    if (nodes.filter(n => n.kind === 'start').length !== 1) throw new Error('시작 노드는 정확히 하나여야 합니다.');
    const ports = new Set();
    const edges = graph.edges.map(edge => {
      const source = nodes.find(n => n.id === edge.source), target = nodes.find(n => n.id === edge.target);
      const port = edge.port || 'next';
      if (!source || !target || target.kind === 'start' || source.kind === 'end' || source.id === target.id || !(source.kind === 'condition' ? ['true', 'false'] : ['next']).includes(port)) throw new Error('허용되지 않은 연결입니다.');
      const key = `${source.id}:${port}`;
      if (ports.has(key)) throw new Error('출력 포트에는 하나의 연결만 가능합니다.');
      ports.add(key); return { source: source.id, target: target.id, port };
    });
    const visiting = new Set(), visited = new Set();
    function visit(id) {
      if (visiting.has(id)) throw new Error('순환 연결 대신 워크플로우 반복 횟수를 사용하세요.');
      if (visited.has(id)) return;
      visiting.add(id); edges.filter(e => e.source === id).forEach(e => visit(e.target)); visiting.delete(id); visited.add(id);
    }
    nodes.forEach(n => visit(n.id));
    return { version: 1, nodes, edges };
  }
  function runnable(graph) {
    const g = validate(graph), seen = new Set();
    function visit(node) {
      if (seen.has(node.id)) return; seen.add(node.id);
      if (node.kind === 'end' || node.action?.type === 'stop') return;
      for (const port of node.kind === 'condition' ? ['true', 'false'] : ['next']) {
        const edge = g.edges.find(e => e.source === node.id && e.port === port);
        if (!edge) throw new Error(`“${node.name}” 노드의 ${port} 출력을 연결하세요.`);
        visit(g.nodes.find(n => n.id === edge.target));
      }
    }
    visit(g.nodes.find(n => n.kind === 'start'));
    if (seen.size !== g.nodes.length) throw new Error('시작 노드에서 연결되지 않은 노드가 있습니다.');
    return g;
  }
  function fromActions(actions) {
    const nodes = [{ id: 'start', kind: 'start', name: '시작', x: 80, y: 220 }, ...actions.map((action, i) => ({ id: `step-${i}`, kind: 'action', name: action.type, x: 340 + i * 260, y: 220, action })), { id: 'end', kind: 'end', name: '완료', x: 340 + actions.length * 260, y: 220 }];
    return { version: 1, nodes, edges: nodes.slice(0, -1).map((n, i) => ({ source: n.id, target: nodes[i + 1].id, port: 'next' })) };
  }
  return { validate, runnable, fromActions };
});
