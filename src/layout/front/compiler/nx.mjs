/** 그래프와 부분 그래프 맞추기 — networkx 의 Graph(일부)와 VF2 GraphMatcher 를 옮긴 것.
 *
 *  ALIGN 은 회로를 "소자 마디 — 넷 마디" 그래프로 보고, 원시 소자 틀과 같은 모양의 부분을 VF2 로 찾는다.
 *  찾은 순서가 결과(어느 소자가 어느 틀에 묶이는가)를 정하므로, networkx 의 순서를 그대로 따른다:
 *  마디·이웃은 넣은 순서 (Map), 후보 쌍은 G2 의 마디 순서로 고른다.
 *
 *    NxGraph                마디 속성(nodeAttrs), 이웃(adj), 변 속성(getEdgeData)
 *    GraphMatcher(G1, G2, nodeMatch, edgeMatch).subgraphIsomorphisms()
 *                           G1 의 (유도) 부분 그래프 중 G2 와 같은 것 — Map(G1 마디 -> G2 마디) 를 차례로
 */

export class NxGraph {
  constructor() {
    /** 마디 -> 속성 */
    this._node = new Map();
    /** 마디 -> (이웃 -> 변 속성) */
    this._adj = new Map();
  }
  _ensure(n) {
    if (n == null) throw new Error("None cannot be a node");
    if (!this._node.has(n)) { this._adj.set(n, new Map()); this._node.set(n, {}); }
  }
  addNode(n, attrs = {}) {
    this._ensure(n);
    Object.assign(this._node.get(n), attrs);
  }
  addEdge(u, v, attrs = {}) {
    this._ensure(u);
    this._ensure(v);
    const d = this._adj.get(u).get(v) ?? {};
    Object.assign(d, attrs);
    this._adj.get(u).set(v, d);
    this._adj.get(v).set(u, d);
  }
  hasNode(n) { return this._node.has(n); }
  hasEdge(u, v) { return this._adj.get(u)?.has(v) ?? false; }
  nodeAttrs(n) {
    const a = this._node.get(n);
    if (!a) throw new Error(`no node ${n}`);
    return a;
  }
  /** 이웃 -> 변 속성 (살아 있는 Map) */
  adj(n) {
    const a = this._adj.get(n);
    if (!a) throw new Error(`The node ${n} is not in the graph.`);
    return a;
  }
  neighbors(n) { return [...this.adj(n).keys()]; }
  degree(n) {
    const a = this.adj(n);
    return a.size + (a.has(n) ? 1 : 0);
  }
  getEdgeData(u, v) { return this._adj.get(u)?.get(v) ?? null; }
  numberOfEdges(u, v) { return this.hasEdge(u, v) ? 1 : 0; }
  nodes() { return [...this._node.keys()]; }
  get order() { return this._node.size; }
  removeNode(n) {
    const nbrs = this._adj.get(n);
    if (!nbrs) throw new Error(`The node ${n} is not in the graph.`);
    this._node.delete(n);
    for (const u of [...nbrs.keys()]) this._adj.get(u).delete(n);
    this._adj.delete(n);
  }
  removeNodesFrom(nodes) {
    for (const n of nodes) {
      if (!this._node.has(n)) continue;
      this._node.delete(n);
      for (const u of [...this._adj.get(n).keys()]) this._adj.get(u).delete(n);
      this._adj.delete(n);
    }
  }
}

// ---------------------------------------------------------------- VF2 (networkx isomorphvf2 + vf2userfunc)
class GMState {
  constructor(GM, n1 = null, n2 = null) {
    this.GM = GM;
    this.G1_node = null;
    this.G2_node = null;
    this.depth = GM.core_1.size;
    if (n1 === null || n2 === null) {
      GM.core_1 = new Map(); GM.core_2 = new Map(); GM.inout_1 = new Map(); GM.inout_2 = new Map();
    }
    if (n1 !== null && n2 !== null) {
      GM.core_1.set(n1, n2);
      GM.core_2.set(n2, n1);
      this.G1_node = n1;
      this.G2_node = n2;
      this.depth = GM.core_1.size;
      if (!GM.inout_1.has(n1)) GM.inout_1.set(n1, this.depth);
      if (!GM.inout_2.has(n2)) GM.inout_2.set(n2, this.depth);
      for (const nb of GM.G1.adj(n1).keys()) if (!GM.core_1.has(nb) && !GM.inout_1.has(nb)) GM.inout_1.set(nb, this.depth);
      for (const nb of GM.G2.adj(n2).keys()) if (!GM.core_2.has(nb) && !GM.inout_2.has(nb)) GM.inout_2.set(nb, this.depth);
    }
  }
  restore() {
    const GM = this.GM;
    if (this.G1_node !== null && this.G2_node !== null) {
      GM.core_1.delete(this.G1_node);
      GM.core_2.delete(this.G2_node);
    }
    for (const vec of [GM.inout_1, GM.inout_2]) for (const node of [...vec.keys()]) if (vec.get(node) === this.depth) vec.delete(node);
  }
}

export class GraphMatcher {
  /**
   * @param {NxGraph} G1  큰 그래프 (회로)
   * @param {NxGraph} G2  찾을 모양 (틀)
   * @param {(a:object, b:object)=>boolean} [nodeMatch]  마디 속성 비교
   * @param {(a:object, b:object)=>boolean} [edgeMatch]  변 속성 비교
   */
  constructor(G1, G2, nodeMatch = null, edgeMatch = null) {
    this.G1 = G1;
    this.G2 = G2;
    this.nodeMatch = nodeMatch;
    this.edgeMatch = edgeMatch;
    this.G2_nodes = new Set(G2.nodes());
    this.G2_node_order = new Map(G2.nodes().map((n, i) => [n, i]));
    this.test = "graph";
    this.initialize();
  }
  initialize() {
    this.core_1 = new Map(); this.core_2 = new Map(); this.inout_1 = new Map(); this.inout_2 = new Map();
    this.state = new GMState(this);
    this.mapping = new Map(this.core_1);
  }
  _minByOrder(nodes) {
    let best = null, bi = Infinity;
    for (const n of nodes) { const i = this.G2_node_order.get(n); if (i < bi) { bi = i; best = n; } }
    return best;
  }
  *candidatePairs() {
    const T1 = [...this.inout_1.keys()].filter((n) => !this.core_1.has(n));
    const T2 = [...this.inout_2.keys()].filter((n) => !this.core_2.has(n));
    if (T1.length && T2.length) {
      const n2 = this._minByOrder(T2);
      for (const n1 of T1) yield [n1, n2];
    } else {
      const other = this._minByOrder([...this.G2_nodes].filter((n) => !this.core_2.has(n)));
      for (const n of this.G1.nodes()) if (!this.core_1.has(n)) yield [n, other];
    }
  }
  *match() {
    if (this.core_1.size === this.G2.order) {
      this.mapping = new Map(this.core_1);
      yield this.mapping;
      return;
    }
    for (const [n1, n2] of this.candidatePairs()) {
      if (this.syntacticFeasibility(n1, n2) && this.semanticFeasibility(n1, n2)) {
        const st = new GMState(this, n1, n2);
        yield* this.match();
        st.restore();
      }
    }
  }
  semanticFeasibility(n1, n2) {
    if (this.nodeMatch && !this.nodeMatch(this.G1.nodeAttrs(n1), this.G2.nodeAttrs(n2))) return false;
    if (this.edgeMatch) {
      const a = this.G1.adj(n1), b = this.G2.adj(n2);
      for (const nb of a.keys()) {
        if (nb === n1) {
          if (b.has(n2) && !this.edgeMatch(a.get(n1), b.get(n2))) return false;
        } else if (this.core_1.has(nb)) {
          const m = this.core_1.get(nb);
          if (b.has(m) && !this.edgeMatch(a.get(nb), b.get(m))) return false;
        }
      }
    }
    return true;
  }
  syntacticFeasibility(n1, n2) {
    const G1 = this.G1, G2 = this.G2;
    if (G1.numberOfEdges(n1, n1) !== G2.numberOfEdges(n2, n2)) return false;
    const a = G1.adj(n1), b = G2.adj(n2);
    for (const nb of a.keys()) {
      if (this.core_1.has(nb)) {
        const m = this.core_1.get(nb);
        if (!b.has(m)) return false;
        if (G1.numberOfEdges(nb, n1) !== G2.numberOfEdges(m, n2)) return false;
      }
    }
    for (const nb of b.keys()) {
      if (this.core_2.has(nb)) {
        const m = this.core_2.get(nb);
        if (!a.has(m)) return false;
        if (G1.numberOfEdges(m, n1) !== G2.numberOfEdges(nb, n2)) return false;
      }
    }
    let num1 = 0, num2 = 0;
    for (const nb of a.keys()) if (this.inout_1.has(nb) && !this.core_1.has(nb)) num1++;
    for (const nb of b.keys()) if (this.inout_2.has(nb) && !this.core_2.has(nb)) num2++;
    if (this.test === "graph" ? num1 !== num2 : !(num1 >= num2)) return false;
    num1 = 0; num2 = 0;
    for (const nb of a.keys()) if (!this.inout_1.has(nb)) num1++;
    for (const nb of b.keys()) if (!this.inout_2.has(nb)) num2++;
    if (this.test === "graph" ? num1 !== num2 : !(num1 >= num2)) return false;
    return true;
  }
  /** subgraph_isomorphisms_iter */
  *subgraphIsomorphisms() {
    this.test = "subgraph";
    this.initialize();
    yield* this.match();
  }
}
