// services/isolationForest.service.js
// Pure JavaScript Isolation Forest with DETERMINISTIC (seeded) RNG.
//
// Reference:  Liu, Fei Tony, Ting, Kai Ming, and Zhou, Zhi-Hua. "Isolation forest." (2008).
//
// v2 changes:
//   ✓ Seeded mulberry32 RNG → identical scores across rescans for unchanged data
//   ✓ Pluggable seed (default derived from businessId for stability per-business)

// ── Seeded RNG (mulberry32) ──────────────────────────────────────────────────
//   Tiny, fast, deterministic 32-bit PRNG.  Produces same sequence for same seed.
function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return function rng() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash an arbitrary string into a 32-bit seed (FNV-1a). */
function seedFromString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h || 1;
}

class IsolationNode {
  constructor({ isLeaf, size = 0, featureIdx = -1, splitVal = 0, left = null, right = null } = {}) {
    this.isLeaf = isLeaf;
    this.size = size;
    this.featureIdx = featureIdx;
    this.splitVal = splitVal;
    this.left = left;
    this.right = right;
  }
}

class IsolationTree {
  constructor(maxDepth, rng) {
    this.maxDepth = maxDepth;
    this.rng      = rng || Math.random;
    this.root     = null;
  }

  fit(data) {
    this.root = this._build(data, 0);
    return this;
  }

  _build(data, depth) {
    if (depth >= this.maxDepth || data.length <= 1) {
      return new IsolationNode({ isLeaf: true, size: data.length });
    }
    const numFeatures = data[0].length;
    const featureIdx = Math.floor(this.rng() * numFeatures);

    let min = Infinity, max = -Infinity;
    for (const point of data) {
      const v = point[featureIdx];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min >= max) {
      return new IsolationNode({ isLeaf: true, size: data.length });
    }
    const splitVal = min + this.rng() * (max - min);
    const left = [], right = [];
    for (const point of data) {
      (point[featureIdx] < splitVal ? left : right).push(point);
    }
    return new IsolationNode({
      isLeaf: false,
      featureIdx,
      splitVal,
      left:  this._build(left,  depth + 1),
      right: this._build(right, depth + 1),
    });
  }

  pathLength(point) { return this._traverse(point, this.root, 0); }

  _traverse(point, node, depth) {
    if (node === null) return depth;
    if (node.isLeaf)   return depth + _avgPathLength(node.size);
    if (point[node.featureIdx] < node.splitVal) {
      return this._traverse(point, node.left,  depth + 1);
    }
    return this._traverse(point, node.right, depth + 1);
  }
}

function _avgPathLength(n) {
  if (n <= 1) return 0;
  if (n === 2) return 1;
  return 2.0 * (Math.log(n - 1) + 0.5772156649) - (2.0 * (n - 1) / n);
}

/**
 * IsolationForest with deterministic seeding.
 *
 * Usage:
 *   const forest = new IsolationForest({ numTrees: 100, sampleSize: 256, seed: 'my-biz-id' });
 *   forest.fit(featureMatrix);
 *   const scores = forest.predict(featureMatrix);
 *
 * `seed` can be a string (hashed via FNV-1a), a number, or omitted (then a
 * fixed default seed is used so repeated calls on identical data give
 * identical scores).
 */
class IsolationForest {
  constructor({ numTrees = 100, sampleSize = 256, seed = 'vousfin-default' } = {}) {
    this.numTrees   = numTrees;
    this.sampleSize = sampleSize;
    this.seed       = typeof seed === 'number' ? seed : seedFromString(String(seed));
    this.rng        = makeRng(this.seed);
    this.trees      = [];
    this._n         = 0;
  }

  fit(data) {
    if (!data || data.length === 0) throw new Error('IsolationForest.fit: empty dataset');
    this._n = data.length;
    const effectiveSampleSize = Math.min(this.sampleSize, data.length);
    const maxDepth = Math.ceil(Math.log2(effectiveSampleSize));
    this.trees = [];
    for (let i = 0; i < this.numTrees; i++) {
      const sample = this._subsample(data, effectiveSampleSize);
      // Each tree gets its own seeded RNG, derived from forest seed + tree index
      // so different trees see different random splits but the SEQUENCE is reproducible.
      const treeRng = makeRng(this.seed + i + 1);
      const tree = new IsolationTree(maxDepth, treeRng);
      tree.fit(sample);
      this.trees.push(tree);
    }
    return this;
  }

  scorePoint(point) {
    const avgPathLen =
      this.trees.reduce((sum, tree) => sum + tree.pathLength(point), 0) / this.trees.length;
    const c = _avgPathLength(this._n);
    if (c === 0) return 0.5;
    return Math.pow(2, -avgPathLen / c);
  }

  predict(data) { return data.map(point => this.scorePoint(point)); }

  _subsample(data, size) {
    if (size >= data.length) return [...data];
    const result  = new Array(size);
    const indices = Array.from({ length: data.length }, (_, i) => i);
    for (let i = 0; i < size; i++) {
      const j = i + Math.floor(this.rng() * (data.length - i));
      [indices[i], indices[j]] = [indices[j], indices[i]];
      result[i] = data[indices[i]];
    }
    return result;
  }
}

module.exports = { IsolationForest, makeRng, seedFromString };
