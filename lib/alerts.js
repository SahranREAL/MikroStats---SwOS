'use strict';

const config = require('../config');
const logger = require('./logger');

/**
 * Alert engine - infrastructure only, no delivery channel yet.
 *
 * Rules are plain objects evaluated on every poll; a firing rule calls every
 * registered notifier. Adding Discord / Telegram / webhook / SMTP later means
 * appending to `notifiers` - no other part of the app has to change (§38).
 *
 * Alerts are deduplicated by (rule, subject) and re-armed only after the
 * condition clears, so a flapping port cannot flood the log.
 */

const state = new Map(); // "rule:subject" -> { firing, since, lastNotifiedAt }

const notifiers = [
  {
    name: 'log',
    async notify(alert) {
      logger.warn(`ALERT [${alert.rule}] ${alert.subject}: ${alert.message}`);
    },
  },
];

const rules = [
  {
    id: 'switch_unreachable',
    subject: () => 'switch',
    enabled: true,
    check: (ctx) => (ctx.status === 'disconnected' ? 'switch unreachable (polling failing)' : null),
  },
  {
    id: 'switch_degraded',
    subject: () => 'switch',
    enabled: true,
    check: (ctx) => (ctx.status === 'degraded' ? 'switch is only partially reachable' : null),
  },
  {
    id: 'consecutive_errors',
    subject: () => 'switch',
    enabled: true,
    check: (ctx) => (ctx.consecutiveErrors >= 5 ? `${ctx.consecutiveErrors} consecutive poll failures` : null),
  },
  {
    id: 'port_down',
    subject: (ctx) => `port:${ctx.portIndex}`,
    enabled: true,
    check: (ctx) => (ctx.link === false ? 'link is down' : null),
  },
  {
    id: 'port_bandwidth',
    subject: (ctx) => `port:${ctx.portIndex}`,
    enabled: false, // opt-in, thresholds are deployment specific
    check: (ctx) => {
      const limit = Number(process.env.ALERT_PORT_BPS || 0);
      if (!limit) return null;
      if (ctx.inBps > limit) return `ingress ${Math.round(ctx.inBps / 1e6)} Mbps over threshold`;
      if (ctx.outBps > limit) return `egress ${Math.round(ctx.outBps / 1e6)} Mbps over threshold`;
      return null;
    },
  },
  {
    id: 'global_bandwidth',
    subject: () => 'switch',
    enabled: false,
    check: (ctx) => {
      const limit = Number(process.env.ALERT_GLOBAL_BPS || 0);
      if (!limit) return null;
      if (ctx.inBps > limit || ctx.outBps > limit) {
        return `aggregate ${Math.round(Math.max(ctx.inBps, ctx.outBps) / 1e6)} Mbps over threshold`;
      }
      return null;
    },
  },
];

async function evaluate(context) {
  const events = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const subject = rule.subject(context);
    const key = `${rule.id}:${subject}`;
    let message = null;
    try {
      message = rule.check(context);
    } catch (err) {
      logger.throttleError(`alert.${rule.id}`, `alert rule failed: ${err.message}`, 600000);
      continue;
    }
    const current = state.get(key);
    if (message) {
      if (current && current.firing) continue; // already reported, stay quiet
      const entry = { firing: true, since: Date.now(), message };
      state.set(key, entry);
      events.push({ rule: rule.id, subject, message, at: entry.since });
    } else if (current && current.firing) {
      state.set(key, { firing: false, since: Date.now(), message: null });
      events.push({ rule: rule.id, subject, message: 'resolved', at: Date.now(), resolved: true });
    }
  }

  for (const event of events) {
    for (const notifier of notifiers) {
      try {
        await notifier.notify(event);
      } catch (err) {
        logger.throttleError(`alert.notify.${notifier.name}`, `notifier failed: ${err.message}`, 300000);
      }
    }
  }
  return events;
}

function active() {
  const out = [];
  for (const [key, v] of state) {
    if (!v.firing) continue;
    const idx = key.indexOf(':');
    out.push({ rule: key.slice(0, idx), subject: key.slice(idx + 1), message: v.message, since: v.since });
  }
  return out;
}

function list() {
  return rules.map((r) => ({ id: r.id, enabled: r.enabled }));
}

function notifierNames() {
  return notifiers.map((n) => n.name);
}

module.exports = { evaluate, active, list, notifierNames, config };
