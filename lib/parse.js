'use strict';

/**
 * Strict parser for the JavaScript-object-literal payloads returned by SwOS
 * endpoints (`/stats.b`, `/link.b`; older firmwares: `/!stats.b`), e.g.
 *
 *   {rb:[0x0001c4eb,0x0,...],rbh:[...],nm:["506f727431",...]}
 *
 * We deliberately do NOT use eval()/new Function(): the switch is a network
 * peer and its answer must never be executed. Only three constructs are
 * accepted - identifier keys, numbers (decimal or 0x hex) and flat arrays of
 * numbers/strings. Anything else throws.
 */

// SwOS keys are all lowercase (rb, rbh, nm, spd, lnk, p128...). Requiring that
// already rejects every mixed-case JavaScript object-internal name (toString,
// valueOf, hasOwnProperty, __proto__, ...). `constructor` is all lowercase, so
// it needs an explicit mention.
const KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const FORBIDDEN_KEYS = new Set(['constructor', '__proto__', 'prototype']);
const MAX_KEYS = 256;
const MAX_ARRAY = 4096;
const MAX_STRING = 128;
const MAX_INPUT = 4 * 1024 * 1024;

class ParseError extends Error {}

class Parser {
  constructor(input) {
    this.s = input;
    this.i = 0;
    this.n = input.length;
  }

  fail(msg) {
    throw new ParseError(`${msg} at offset ${this.i}`);
  }

  skipWs() {
    while (this.i < this.n) {
      const c = this.s.charCodeAt(this.i);
      if (c === 32 || c === 9 || c === 10 || c === 13) this.i++;
      else break;
    }
  }

  peek() {
    return this.i < this.n ? this.s[this.i] : '';
  }

  expect(ch) {
    this.skipWs();
    if (this.s[this.i] !== ch) this.fail(`expected '${ch}'`);
    this.i++;
  }

  parseObject() {
    this.expect('{');
    const out = Object.create(null);
    let count = 0;
    this.skipWs();
    if (this.peek() === '}') { this.i++; return out; }

    for (;;) {
      this.skipWs();
      if (++count > MAX_KEYS) this.fail('too many keys');
      const key = this.parseKey();
      this.expect(':');
      out[key] = this.parseValue();
      this.skipWs();
      const c = this.s[this.i];
      if (c === ',') { this.i++; continue; }
      if (c === '}') { this.i++; return out; }
      this.fail("expected ',' or '}'");
    }
  }

  parseKey() {
    const start = this.i;
    while (this.i < this.n && /[A-Za-z0-9_]/.test(this.s[this.i])) this.i++;
    const key = this.s.slice(start, this.i);
    if (!KEY_RE.test(key) || FORBIDDEN_KEYS.has(key)) this.fail('invalid key');
    return key;
  }

  parseValue() {
    this.skipWs();
    const c = this.peek();
    if (c === '[') return this.parseArray();
    if (c === '{') return this.parseObject();
    if (c === '"' || c === "'") return this.parseString();
    return this.parseNumber();
  }

  parseArray() {
    this.expect('[');
    const out = [];
    this.skipWs();
    if (this.peek() === ']') { this.i++; return out; }
    for (;;) {
      if (out.length >= MAX_ARRAY) this.fail('array too long');
      out.push(this.parseValue());
      this.skipWs();
      const c = this.s[this.i];
      if (c === ',') { this.i++; continue; }
      if (c === ']') { this.i++; return out; }
      this.fail("expected ',' or ']'");
    }
  }

  parseString() {
    const quote = this.s[this.i++];
    let out = '';
    while (this.i < this.n) {
      const c = this.s[this.i++];
      if (c === quote) return out;
      if (c === '\\') {
        const e = this.s[this.i++];
        if (e === undefined) this.fail('unterminated escape');
        out += e;
      } else {
        out += c;
      }
      if (out.length > MAX_STRING) this.fail('string too long');
    }
    this.fail('unterminated string');
    return '';
  }

  parseNumber() {
    const start = this.i;
    if (this.s[this.i] === '+' || this.s[this.i] === '-') this.i++;
    if (this.s[this.i] === '0' && (this.s[this.i + 1] === 'x' || this.s[this.i + 1] === 'X')) {
      this.i += 2;
      const hexStart = this.i;
      while (this.i < this.n && /[0-9a-fA-F]/.test(this.s[this.i])) this.i++;
      if (this.i === hexStart) this.fail('malformed hex literal');
      const v = Number.parseInt(this.s.slice(hexStart, this.i), 16);
      if (!Number.isFinite(v)) this.fail('hex literal out of range');
      return v;
    }
    while (this.i < this.n && /[0-9]/.test(this.s[this.i])) this.i++;
    if (this.i < this.n && this.s[this.i] === '.') {
      this.i++;
      while (this.i < this.n && /[0-9]/.test(this.s[this.i])) this.i++;
    }
    if (this.i < this.n && /[eE]/.test(this.s[this.i])) {
      this.i++;
      if (this.s[this.i] === '+' || this.s[this.i] === '-') this.i++;
      while (this.i < this.n && /[0-9]/.test(this.s[this.i])) this.i++;
    }
    const raw = this.s.slice(start, this.i);
    if (raw === '' || raw === '-' || raw === '+' || raw === '.') this.fail('malformed number');
    const v = Number(raw);
    if (!Number.isFinite(v)) this.fail('non-finite number');
    return v;
  }
}

/** Parse a SwOS payload into a plain object. Throws ParseError on anything unexpected. */
function parseSwos(input) {
  if (typeof input !== 'string') throw new ParseError('payload is not a string');
  if (input.length > MAX_INPUT) throw new ParseError('payload too large');
  const p = new Parser(input);
  const obj = p.parseObject();
  p.skipWs();
  if (p.i !== p.n) p.fail('trailing data after object');
  return obj;
}

/** SwOS sometimes wraps the object in a callback, e.g. `f({...});` - extract the object. */
function extractObject(input) {
  if (typeof input !== 'string') throw new ParseError('payload is not a string');
  const start = input.indexOf('{');
  if (start === -1) throw new ParseError('no object found in payload');
  return parseSwos(input.slice(start));
}

module.exports = { parseSwos, extractObject, ParseError };
