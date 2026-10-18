'use strict';

const config = require('../config');
const logger = require('./logger');

/**
 * Minimal Server-Sent Events hub.
 *
 * SSE (not WebSocket) is deliberate: plain HTTP, no extra dependency, no
 * handshake state, and the browser reconnects on its own. The hub holds a hard
 * cap on clients so a runaway page reload loop cannot exhaust the Orange Pi.
 */
class SseHub {
  constructor() {
    this.clients = new Set();
    this.heartbeat = null;
    this.lastPayloadId = 0;
  }

  get size() { return this.clients.size; }

  attach(req, res) {
    if (this.clients.size >= config.sse.maxClients) {
      res.status(503).set('Retry-After', '10').end('too many stream clients');
      return null;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 5000\n\n');

    const client = { res };
    this.clients.add(client);

    const drop = () => {
      this.clients.delete(client);
      try { res.end(); } catch { /* already closed */ }
    };
    req.on('close', drop);
    req.on('error', drop);
    res.on('error', drop);

    this.ensureHeartbeat();
    return client;
  }

  ensureHeartbeat() {
    if (this.heartbeat || this.clients.size === 0) return;
    this.heartbeat = setInterval(() => {
      if (this.clients.size === 0) {
        clearInterval(this.heartbeat);
        this.heartbeat = null;
        return;
      }
      this.sendRaw(': ping\n\n');
    }, config.sse.heartbeatMs);
    if (this.heartbeat.unref) this.heartbeat.unref();
  }

  broadcast(type, data) {
    if (this.clients.size === 0) return;
    const id = ++this.lastPayloadId;
    let frame = `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    if (frame.length > 1 << 20) {
      // Never let a pathological payload stall the event loop.
      frame = `id: ${id}\nevent: error\ndata: {"message":"payload too large"}\n\n`;
    }
    this.sendRaw(frame);
  }

  sendRaw(frame) {
    for (const client of this.clients) {
      try {
        client.res.write(frame);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  closeAll() {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    for (const client of this.clients) {
      try { client.res.end(); } catch { /* ignore */ }
    }
    this.clients.clear();
    logger.debug('sse: closed all clients');
  }
}

module.exports = { SseHub };
