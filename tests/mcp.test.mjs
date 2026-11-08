import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { register } from 'node:module';
register('./loader.mjs', import.meta.url);
const { default: worker, Mailbox } = await import('../server/src/index.js');

// in-memory Durable Object storage, enough for Mailbox
class Storage {
  m = new Map();
  async get(k) { return this.m.get(k); }
  async put(k, v) { this.m.set(k, structuredClone(v)); }
  async delete(k) { for (const x of [].concat(k)) this.m.delete(x); }
  async list({ prefix }) { return new Map([...this.m].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1))); }
  async setAlarm() {}
  async deleteAll() { this.m.clear(); }
}
const boxes = new Map();
const env = { MAILBOX: { idFromName: (n) => n, get: (id) => { if (!boxes.has(id)) boxes.set(id, new Mailbox({ storage: new Storage() }, {})); return boxes.get(id); } } };
const rpc = async (method, params, id = 1) => {
  const r = await worker.fetch(new Request('https://x.test/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }), env);
  return r.json();
};
const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
const S = 'abcdef0123456789abcdef01';

test('initialize advertises the app extension', async () => {
  const r = await rpc('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(r.result.serverInfo.name, 'studying');
  assert.ok(r.result.capabilities.extensions['io.modelcontextprotocol/ui']);
  assert.match(r.result.instructions, /study_guide/);
});

test('every tool has a title and annotations; study_open links the window', async () => {
  const { tools } = (await rpc('tools/list')).result;
  for (const t of tools) {
    assert.ok(t.title, t.name);
    assert.equal(typeof t.annotations?.readOnlyHint, 'boolean', t.name);
  }
  const open = tools.find((t) => t.name === 'study_open');
  assert.match(open._meta.ui.resourceUri, /^ui:\/\/studying\/window-/);
  assert.deepEqual(tools.find((t) => t.name === 'study_pull')._meta.ui.visibility, ['app']);
});

test('window resource is the built app with the SDK inlined', async () => {
  const { tools } = (await rpc('tools/list')).result;
  const uri = tools.find((t) => t.name === 'study_open')._meta.ui.resourceUri;
  const r = (await rpc('resources/read', { uri })).result.contents[0];
  assert.equal(r.mimeType, 'text/html;profile=mcp-app');
  assert.ok(!r.text.includes('/*SDK*/'));
  assert.match(r.text, /window\.__mcpApps\s*=/);
  // an old cached version still resolves
  assert.ok((await rpc('resources/read', { uri: 'ui://studying/window-0.0.1.html' })).result);
  assert.ok((await rpc('resources/read', { uri: 'ui://other/x.html' })).error);
});

test('push, progress and pull round trip', async () => {
  const p = await call('study_push', { session: S, kind: 'deck', title: 'D', payload: { kind: 'deck', cards: [{ id: '1', front: 'a', back: 'b' }] } });
  assert.equal(p.structuredContent.seq, 1);
  await call('study_progress', { session: S, job: 'Making cards', step: 1, total: 3 });
  const r = (await call('study_pull', { session: S, after: 0 })).structuredContent;
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].kind, 'deck');
  assert.equal(r.progress.job, 'Making cards');
  assert.equal((await call('study_pull', { session: S, after: 1 })).structuredContent.messages.length, 0);
});

test('mailbox keeps the newest 20 messages', async () => {
  const s = 'keep20keep20keep20';
  for (let i = 0; i < 25; i++) await call('study_push', { session: s, kind: 'notice', payload: { text: String(i) } });
  const r = (await call('study_pull', { session: s, after: 0 })).structuredContent;
  assert.equal(r.messages.length, 20);
  assert.equal(r.messages[0].payload.text, '5');
});

test('bad input comes back as a tool error, not a crash', async () => {
  assert.equal((await call('study_push', { session: 'short', kind: 'deck' })).isError, true);
  assert.equal((await call('study_push', { session: S, kind: 'nope' })).isError, true);
  assert.equal((await call('study_guide', { topic: 'nope' })).isError, true);
  assert.equal((await call('nope', {})).isError, true);
});

test('every guide topic returns text', async () => {
  const { GUIDE_TOPICS } = await import('../server/src/guides.js');
  for (const t of GUIDE_TOPICS) {
    const r = await call('study_guide', { topic: t });
    assert.ok(r.content[0].text.length > 200, t);
  }
});

test('pages and routes', async () => {
  const get = (p) => worker.fetch(new Request('https://x.test' + p), env);
  assert.match(await (await get('/')).text(), /https:\/\/x\.test\/mcp/);
  assert.equal((await get('/privacy')).status, 200);
  assert.equal((await get('/icon.svg')).headers.get('content-type'), 'image/svg+xml');
  assert.equal((await get('/nope')).status, 404);
  const bad = await worker.fetch(new Request('https://x.test/mcp', { method: 'POST', body: '{' }), env);
  assert.equal(bad.status, 400);
});

test('window script is a valid module', () => {
  const html = readFileSync(new URL('../server/src/window.html', import.meta.url), 'utf8');
  const js = html.match(/<script type="module">([\s\S]*)<\/script>/)[1];
  const dir = mkdtempSync(join(tmpdir(), 'studying-'));
  const file = join(dir, 'window.mjs');
  writeFileSync(file, js);
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('worker exports only handlers and classes (workerd rejects anything else)', async () => {
  const mod = await import('../server/src/index.js');
  for (const [k, v] of Object.entries(mod)) assert.ok(k === 'default' || typeof v === 'function', `export ${k} is not allowed in a Worker`);
});

test('cleanup after two hours keeps the sequence number', async () => {
  const s = 'alarmalarmalarm1';
  await call('study_push', { session: s, kind: 'notice', payload: { text: 'a' } });
  await call('study_push', { session: s, kind: 'notice', payload: { text: 'b' } });
  await env.MAILBOX.get(s).alarm();
  const r = await call('study_push', { session: s, kind: 'notice', payload: { text: 'c' } });
  assert.equal(r.structuredContent.seq, 3);
  const p = (await call('study_pull', { session: s, after: 2 })).structuredContent;
  assert.deepEqual(p.messages.map((m) => m.payload.text), ['c']);
});

test('big pushes are refused by UTF-8 size and pulls are split', async () => {
  const s = 'bigbigbigbigbig1';
  const r = await call('study_push', { session: s, kind: 'document', payload: { markdown: 'č'.repeat(500_000) } });
  assert.equal(r.isError, true);
  for (let i = 0; i < 3; i++) await call('study_push', { session: s, kind: 'document', payload: { markdown: 'x'.repeat(500_000) } });
  const p = (await call('study_pull', { session: s, after: 0 })).structuredContent;
  assert.equal(p.messages.length, 2);
  assert.equal(p.more, true);
});
