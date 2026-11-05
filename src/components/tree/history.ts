/**
 * history.ts — ring buffer of wind-envelope samples so each joint can read the
 * envelope at (t - lag). Zero-filled semantics: before the first sample after a
 * reset, the envelope reads 0 (the air was calm before the event).
 */

export interface History {
  reset(): void;
  push(t: number, v: number): void;
  sample(t: number): number;
}

export function createHistory(size = 128): History {
  const ts = new Float64Array(size);
  const vs = new Float32Array(size);
  let head = 0;
  let count = 0;
  return {
    reset() {
      head = 0;
      count = 0;
    },
    push(t, v) {
      ts[head] = t;
      vs[head] = v;
      head = (head + 1) % size;
      if (count < size) count++;
    },
    sample(t) {
      if (count === 0) return 0;
      let i = (head - 1 + size) % size;
      if (t >= ts[i]) return vs[i];
      for (let n = 1; n < count; n++) {
        const j = (i - 1 + size) % size;
        if (t >= ts[j]) {
          const span = ts[i] - ts[j];
          const u = span > 0 ? (t - ts[j]) / span : 1;
          return vs[j] + (vs[i] - vs[j]) * u;
        }
        i = j;
      }
      // Older than everything we hold: calm if the buffer never wrapped.
      return count < size ? 0 : vs[i];
    },
  };
}
