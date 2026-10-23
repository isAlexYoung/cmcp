import fs from 'node:fs';

// Only explicit enables connect, including after Windows restarts. The BAT
// start entry explicitly enables all; missing/corrupt preferences never do so.
export function readTargetControls(file) {
  try {
    if (fs.statSync(file).size > 256 * 1024) throw Error('Control file too large');
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (data?.schema !== 1 || !Array.isArray(data.targets) || data.targets.length > 100) throw Error('Invalid controls');
    const controls = new Map();
    for (const t of data.targets) {
      if (typeof t?.name !== 'string' || !t.name || t.name.length > 512 || typeof t.enabled !== 'boolean' || typeof t.revision !== 'string' || !t.revision || controls.has(t.name)) throw Error('Invalid target control');
      controls.set(t.name, t);
    }
    return controls;
  } catch { return new Map(); }
}

export const targetRevision = (target, controls) => controls?.get(target.name)?.enabled === true ? controls.get(target.name).revision : null;

// Independent slots: a slow/offline VPS never blocks another target's stop or
// start. A cancelled setup must settle before that same slot can start again.
export function createTargetConnections({readTargets, readControls, create, status, onChange = () => {}, interval = 250, retryMs = 10000}) {
  const slots = new Map();
  let closed = false;
  const signature = (t, revision) => JSON.stringify([t.url, t.stamp, t.authMode, t.autoLogin===true, revision]);
  const snapshot = () => {
    const controls = readControls(), desired = new Map();
    for (const t of readTargets().slice(0, 100)) {
      if (!t?.name || !t?.url || desired.has(t.name)) continue;
      const revision = targetRevision(t, controls);
      if (revision !== null) desired.set(t.name, {target:t, revision, signature:signature(t, revision)});
      else status.set(t.name, 'stopped', '此云电脑已停止；其他云电脑不受影响', controls?.get(t.name)?.revision);
    }
    return desired;
  };
  function retire(slot) {
    if (slot.retiring) return;
    slot.retiring = true;
    slot.controller.abort();
    slot.cleanup = Promise.resolve().then(() => slot.value?.stop()).catch(() => {});
    onChange();
    Promise.allSettled([slot.pending, slot.cleanup]).then(() => {
      if (slots.get(slot.name) === slot) slots.delete(slot.name);
      onChange();
    });
  }
  function tick() {
    if (closed) return;
    const desired = snapshot();
    for (const [name, slot] of slots) if (slot.signature !== desired.get(name)?.signature) retire(slot);
    for (const [name, d] of desired) {
      const old = slots.get(name);
      if (old) {
        if (!old.retiring && old.failed && Date.now() >= old.retryAt) retire(old);
        else if (!old.retiring) old.value?.setup?.();
        continue;
      }
      if (slots.size >= 100) continue;
      const slot = {name, signature:d.signature, controller:new AbortController(), value:null};
      slots.set(name, slot);
      const current = () => !closed && !slot.controller.signal.aborted && slots.get(name) === slot && snapshot().get(name)?.signature === slot.signature;
      const guardedStatus = {set:(name, state, message) => { if (current()) status.set(name, state, message, d.revision); }};
      slot.pending = Promise.resolve().then(() => create(d.target, {signal:slot.controller.signal, current, status:guardedStatus})).then(async value => {
        if (!current()) { await value.stop(); return; }
        slot.value = value;
        onChange();
      }).catch(() => {
        if (current()) {
          slot.failed = true; slot.retryAt = Date.now() + retryMs;
          guardedStatus.set(name, 'offline', '无法连接此云电脑；其他连接不受影响，稍后重试');
        }
      });
    }
  }
  const timer = setInterval(tick, interval); timer.unref(); tick();
  return {
    tick,
    values:() => [...slots.values()].filter(s => !s.retiring && s.value).map(s => s.value),
    async close() { closed = true; clearInterval(timer); for (const slot of slots.values()) retire(slot); await Promise.allSettled([...slots.values()].flatMap(s => [s.pending, s.cleanup])); },
  };
}
