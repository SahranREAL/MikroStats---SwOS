'use strict';

/**
 * Fixed-capacity ring buffer backed by typed arrays.
 * Storage is allocated once and never grows: memory use is constant, whatever
 * the uptime. This is what keeps a months-long run flat in RAM (§13/§31).
 */
class RingBuffer {
  /**
   * @param {number} capacity maximum number of points
   * @param {number} fields number of numeric series stored per point
   */
  constructor(capacity, fields = 1) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new Error('invalid capacity');
    if (!Number.isInteger(fields) || fields <= 0) throw new Error('invalid fields');
    this.capacity = capacity;
    this.fields = fields;
    this.ts = new Float64Array(capacity);
    this.data = new Float64Array(capacity * fields);
    this.count = 0;   // total points ever pushed
    this.head = 0;    // index of the next write slot
  }

  get size() { return Math.min(this.count, this.capacity); }

  /** Absolute index (0 = oldest retained) -> physical slot. */
  slot(abs) {
    const oldest = this.count > this.capacity ? this.count - this.capacity : 0;
    const rel = abs - oldest;
    if (rel < 0 || rel >= this.size) return -1;
    return (this.head - this.size + rel + this.capacity) % this.capacity;
  }

  push(ts, values) {
    const slot = this.head;
    this.ts[slot] = ts;
    const base = slot * this.fields;
    for (let f = 0; f < this.fields; f++) {
      const v = values[f];
      this.data[base + f] = typeof v === 'number' && Number.isFinite(v) ? v : 0;
    }
    this.head = (this.head + 1) % this.capacity;
    this.count++;
  }

  /** Latest value of one field (0 when empty). */
  last(field) {
    if (this.size === 0) return 0;
    const slot = this.slot(this.count - 1);
    return slot < 0 ? 0 : this.data[slot * this.fields + field];
  }

  /**
   * Copy the retained window into plain arrays.
   * @param {number} sinceMs only points with ts >= sinceMs (0 = all)
   */
  toArrays(sinceMs = 0) {
    const size = this.size;
    const oldest = this.count > this.capacity ? this.count - this.capacity : 0;
    const t = [];
    // Written by index, not push(): pre-sizing with new Array(n) would leave
    // holes and serialise as nulls.
    const series = [];
    for (let f = 0; f < this.fields; f++) series.push(new Array(size));

    let w = 0;
    for (let i = 0; i < size; i++) {
      const slot = this.slot(oldest + i);
      const ts = this.ts[slot];
      if (ts < sinceMs) continue;
      t[w] = Math.round(ts);
      const base = slot * this.fields;
      for (let f = 0; f < this.fields; f++) series[f][w] = this.data[base + f];
      w++;
    }
    for (const s of series) s.length = w;
    return { t, ...Object.fromEntries(series.map((s, i) => [`f${i}`, s])) };
  }

  clear() {
    this.ts.fill(0);
    this.data.fill(0);
    this.count = 0;
    this.head = 0;
  }
}

module.exports = { RingBuffer };
