/**
 * Link load derivation.
 *
 * A link between A:p and B:q carries the bytes A transmits on p, which are the
 * bytes B receives on q. So:
 *
 *   a->b (forward) = OUT on A's port p
 *   b->a (reverse) = OUT on B's port q
 *
 * The displayed load is the larger of the two directions, divided by the link
 * capacity. Capacity comes from the stored link, else from the negotiated port
 * speed reported by the device (auto-detected), else it is unknown and the
 * colour falls back to "unknown".
 *
 * Colour thresholds (shared with the frontend):
 *   < 60%  ok      (green)
 *   60-85% warn    (orange)
 *   > 85% critical (red)
 *   down          (dashed red)
 */

export const THRESHOLD_WARN = 0.6;
export const THRESHOLD_CRIT = 0.85;

/** Rate class for a link, given its load ratio (null = unknown capacity). */
export function loadClass(ratio, linkUp) {
  if (linkUp === false) return 'down';
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return 'unknown';
  if (ratio > THRESHOLD_CRIT) return 'critical';
  if (ratio >= THRESHOLD_WARN) return 'warn';
  return 'ok';
}

/**
 * Build a lookup of live port counters:
 *   deviceId -> portIndex -> { inBps, outBps, link, speed, name }
 */
export function indexRates(samples) {
  const map = new Map();
  for (const [deviceId, sample] of samples) {
    if (!sample || !Array.isArray(sample.ports)) continue;
    const ports = new Map();
    for (const p of sample.ports) {
      ports.set(p.index, {
        inBps: p.inBps || 0,
        outBps: p.outBps || 0,
        link: p.link ?? null,
        speed: p.speed ?? null,
        name: p.name || null,
        rxBytes: p.rxBytes || 0,
        txBytes: p.txBytes || 0,
      });
    }
    map.set(deviceId, ports);
  }
  return map;
}

/** Best-known capacity for a link: explicit, else the negotiated port speed. */
function capacityFor(link, aPort, bPort) {
  if (Number.isFinite(link.capacityBps) && link.capacityBps > 0) return link.capacityBps;
  const speeds = [aPort?.speed, bPort?.speed].filter((s) => Number.isFinite(s) && s > 0);
  if (speeds.length === 0) return null;
  // A1 Gbit port linked to a 100 Mbit one can only carry 100 Mbit.
  return Math.min(...speeds);
}

/**
 * Compute every link's live rates.
 * @param {Array} links topology links
 * @param {Map<string, Map<number, object>>} rates from indexRates()
 * @returns {Array<{id, a, b, forwardBps, reverseBps, totalBps, capacityBps, ratio, klass, up}>}
 */
export function linkRates(links, rates) {
  const out = [];
  for (const link of links) {
    const aPorts = rates.get(link.a.device);
    const bPorts = rates.get(link.b.device);
    const aPort = aPorts ? aPorts.get(link.a.port) : undefined;
    const bPort = bPorts ? bPorts.get(link.b.port) : undefined;

    // A side missing entirely (device never polled) is not the same as "down":
    // we simply do not know yet.
    const known = Boolean(aPort && bPort);
    const forwardBps = known ? aPort.outBps : null;   // A -> B
    const reverseBps = known ? bPort.outBps : null;   // B -> A

    const capacityBps = known ? capacityFor(link, aPort, bPort) : (link.capacityBps || null);
    const totalBps = known ? forwardBps + reverseBps : null;

    // Link is down when either side reports link=false. `null` (unknown) is
    // treated as up: SwOS without link.b must not paint everything dashed.
    const up = !known
      ? null
      : !(aPort.link === false || bPort.link === false);

    const ratio = (capacityBps && totalBps !== null) ? totalBps / capacityBps : null;
    out.push({
      id: link.id,
      a: link.a,
      b: link.b,
      label: link.label || null,
      forwardBps,
      reverseBps,
      totalBps,
      capacityBps,
      ratio: ratio === null ? null : Math.min(ratio, 1.5),
      klass: loadClass(ratio, up),
      up,
      aName: aPort?.name || null,
      bName: bPort?.name || null,
    });
  }
  return out;
}

/** Compact SSE frame: only what the map view needs, deltas-friendly. */
export function compactLinks(rates) {
  return rates.map((l) => ({
    id: l.id,
    f: l.forwardBps,
    r: l.reverseBps,
    t: l.totalBps,
    c: l.capacityBps,
    k: l.klass,
    u: l.up,
  }));
}
