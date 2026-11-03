import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { StatusBoard } from '../link-client.mjs';

function board() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-clients-'));
  const file = path.join(directory, 'link-status.json');
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8')).targets;
  return { value: new StatusBoard(file), read, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test('reported clients reach the status file', () => {
  const { value, read, cleanup } = board();
  try {
    value.set('A', 'connected', 'ok');
    value.clients('A', { desktop: true, cli: false });
    assert.deepEqual(read().A.clients, { desktop: true, cli: false });
  } finally { cleanup(); }
});

test('a state change keeps the last known clients, so a disconnect still names them', () => {
  const { value, read, cleanup } = board();
  try {
    value.set('A', 'connected', 'ok');
    value.clients('A', { desktop: false, cli: true });
    value.set('A', 'recovering', 'lost');
    assert.equal(read().A.state, 'recovering');
    assert.deepEqual(read().A.clients, { desktop: false, cli: true });
  } finally { cleanup(); }
});

test('clients for an unknown target are ignored and older status stays without them', () => {
  const { value, read, cleanup } = board();
  try {
    value.set('A', 'connected', 'ok');
    value.clients('B', { desktop: true, cli: true });
    assert.equal(read().B, undefined);
    assert.equal(read().A.clients, undefined);
  } finally { cleanup(); }
});
