import {createHash, randomUUID} from 'node:crypto';

// Per target and authenticated session, in memory only. Query never executes.
// Retention is bounded; an expired/missing result is always uncertain, never replayed.
export class RequestRecovery {
  constructor({limit = 256, byteLimit = 64 * 1024 * 1024, ttl = 10 * 60000, now = Date.now} = {}) {
    Object.assign(this, {limit, byteLimit, ttl, now});
    this.reset();
  }
  reset() { this.epoch = randomUUID(); this.entries = new Map(); this.bytes = 0; }
  prune() {
    for (const [id, entry] of this.entries) {
      if (entry.state !== 'running' && entry.expires <= this.now()) {
        this.bytes -= entry.bytes; this.entries.delete(id);
      }
    }
  }
  reply(id, state, payload = {}) {
    return {t: 'res', id, ...payload, recovery: {protocol: 1, epoch: this.epoch, state}};
  }
  async handle(id, message, action, forward) {
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) return this.reply(id, 'invalid');
    this.prune();
    const found = this.entries.get(id);
    if (action === 'query') return found
      ? this.reply(id, found.state, found.payload)
      : this.reply(id, 'missing');
    if (action !== 'execute') return this.reply(id, 'invalid');
    const fingerprint = createHash('sha256').update(JSON.stringify(message)).digest('hex');
    if (found) {
      if (found.fingerprint !== fingerprint) return this.reply(id, 'conflict');
      // A duplicate receives status/result without dispatching another operation.
      return this.reply(id, found.state, found.payload);
    }
    if (this.entries.size >= this.limit) return this.reply(id, 'not_sent', {error: '恢复记录暂满，请稍后重试'});
    const epoch = this.epoch;
    const entry = {fingerprint, state: 'running', bytes: 0, payload: {}, expires: Infinity};
    this.entries.set(id, entry); // Reserve synchronously before invoking the tool.
    let payload;
    try { payload = {msg: await forward(message)}; }
    catch { payload = {error: '本机操作未返回可确认的结果；请检查执行状态，勿直接重复操作。'}; }
    if (this.epoch !== epoch) return this.reply(id, 'missing');
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    if (bytes <= this.byteLimit - this.bytes) {
      entry.payload = payload; entry.bytes = bytes; this.bytes += bytes; entry.state = 'done';
    } else {
      // Keep a tombstone to prevent re-execution even when the result cannot fit.
      entry.state = 'unavailable';
    }
    entry.expires = this.now() + this.ttl;
    return this.reply(id, 'done', payload);
  }
}
