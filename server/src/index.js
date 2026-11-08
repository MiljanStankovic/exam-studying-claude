// Studying: MCP server with an app window (MCP App) for Claude.
//
// The server shows the window and carries messages between the window and Claude.
// It keeps no user files: the user's materials, decks, tests and memory live in their own
// storage (Google Drive, MEGA, ...), which Claude reaches through the user's own connectors.
// A per-window mailbox (Durable Object) holds pushed results until the window picks them up
// and empties itself after two hours of silence.
//
// Protocol: MCP over HTTP (JSON-RPC in the POST body, JSON response), stateless between calls.

import { DurableObject } from 'cloudflare:workers';
import WINDOW_HTML from './window.html';
import LANDING_HTML from './landing.html';
import PRIVACY_HTML from './privacy.html';
import { GUIDES, GUIDE_TOPICS } from './guides.js';

const VERSION = '0.1.0';
// the window's address changes whenever its content changes, so apps that cache windows by
// address (the Claude desktop and mobile apps do) always load the current one
const hash = (str) => { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); };
const WINDOW_URI = `ui://studying/window-${VERSION}-${hash(WINDOW_HTML)}.html`;
const WINDOW_MIME = 'text/html;profile=mcp-app';
const SESSION_RE = /^[A-Za-z0-9_-]{12,64}$/;
const KINDS = ['files', 'subjects', 'deck', 'test', 'mindmap', 'document', 'results', 'setup_status', 'notice', 'plan'];
const MAX_PAYLOAD = 900_000; // UTF-8 bytes of JSON per push (Durable Object values max out at 2 MB)
const LIMIT_PER_HOUR = 600; // pushes and progress updates per window session per hour
const PULL_LIMIT_PER_HOUR = 3000; // window reads per session per hour (two windows polling every 2.5 s fit)
const PULL_BUDGET = 1_200_000; // bytes of messages returned by one pull

const INSTRUCTIONS =
  'Studying is a study app with a window in the chat. You are its brain: you make study materials, tests and ' +
  'plans from the user\'s own materials, grade answers and keep a memory per subject. The server stores nothing: ' +
  'all files live in the user\'s own storage (Google Drive, MEGA or another connector), which you reach with that ' +
  'storage connector\'s tools. Before any job, call study_guide with topic "overview" once per conversation and ' +
  'follow it. Requests from the window arrive as chat messages starting with "Studying:" and ending with ' +
  '"(session: <id>)": pass that id to study_push and study_progress. To open the app, call study_open. ' +
  'Answer the user in their language; the app UI is English.';

const ann = (title, readOnly, extra = {}) => ({ title, readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false, ...extra });

const TOOLS = [
  {
    name: 'study_open',
    title: 'Open Studying',
    description:
      'Opens the Studying app window. view: setup | home | files | create | study | test | results | document. ' +
      'Pass session to reopen the same window session (keeps its mailbox). Pass data to show content right away ' +
      '(same shape as study_push: {kind, title, payload}). Use view "setup" the first time, when the user has no ' +
      'Studying workspace in their storage yet.',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['setup', 'home', 'files', 'create', 'study', 'test', 'results', 'document'], default: 'home' },
        session: { type: 'string', description: 'existing window session id, if any' },
        data: { type: 'object', description: '{kind, title, payload} to show on open' },
      },
    },
    annotations: ann('Open Studying', true),
    _meta: { ui: { resourceUri: WINDOW_URI } },
  },
  {
    name: 'study_push',
    title: 'Show in Studying',
    description:
      'Sends a result to an open Studying window: kind is one of ' + KINDS.join(', ') + '. ' +
      'payload follows the "formats" guide (deck, test, mindmap, document {markdown}, files {path, items}, ' +
      'subjects [..], results, setup_status {ok, storage, reason?}, notice {text}). The window shows it within ' +
      'a few seconds. session comes from the window\'s message "(session: <id>)".',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        kind: { type: 'string', enum: KINDS },
        title: { type: 'string' },
        payload: { description: 'the content, as in the formats guide' },
      },
      required: ['session', 'kind', 'payload'],
    },
    annotations: ann('Show in Studying', false),
  },
  {
    name: 'study_progress',
    title: 'Report progress',
    description:
      'Updates the progress bar in the window while you work on a job. First call: step 0 with total = number of ' +
      'planned steps and labels for all steps. Then one call as each step starts, with step = its 0-based index ' +
      '(the number of steps already finished). Last call: done true (or error); always send it. ' +
      'The window estimates the remaining time from these updates.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        job: { type: 'string', description: 'short job name, e.g. "Flashcards: Chapter 3"' },
        step: { type: 'integer', minimum: 0 },
        total: { type: 'integer', minimum: 1 },
        label: { type: 'string', description: 'what this step does' },
        steps: { type: 'array', items: { type: 'string' }, description: 'all step labels, on the first call' },
        done: { type: 'boolean' },
        error: { type: 'string' },
      },
      required: ['session', 'job', 'step', 'total'],
    },
    annotations: ann('Report progress', false),
  },
  {
    name: 'study_guide',
    title: 'Studying guide',
    description:
      'Returns a Studying playbook. Topics: ' + GUIDE_TOPICS.join(', ') + '. Read "overview" first in each ' +
      'conversation, then the ones a job needs.',
    inputSchema: { type: 'object', properties: { topic: { type: 'string', enum: GUIDE_TOPICS } }, required: ['topic'] },
    annotations: ann('Studying guide', true),
  },
  {
    name: 'study_pull',
    title: 'Window mailbox',
    description: 'Used by the Studying window to pick up results. Not for the model.',
    inputSchema: { type: 'object', properties: { session: { type: 'string' }, after: { type: 'integer' } }, required: ['session'] },
    annotations: ann('Window mailbox', true),
    _meta: { ui: { visibility: ['app'] } },
  },
];

// ---------- mailbox (one Durable Object per window session) ----------

export class Mailbox extends DurableObject {
  async #touch(key = 'rate', limit = LIMIT_PER_HOUR) {
    const now = Date.now();
    const hour = Math.floor(now / 3_600_000);
    const rate = (await this.ctx.storage.get(key)) ?? { hour, n: 0 };
    if (rate.hour !== hour) { rate.hour = hour; rate.n = 0; }
    rate.n += 1;
    await this.ctx.storage.put(key, rate);
    await this.ctx.storage.setAlarm(now + 2 * 3_600_000);
    if (rate.n > limit) throw Object.assign(new Error('Too many requests for this window; try again in an hour.'), { code: -32029 });
  }
  async push(msg) {
    await this.#touch();
    const seq = ((await this.ctx.storage.get('seq')) ?? 0) + 1;
    await this.ctx.storage.put('seq', seq);
    await this.ctx.storage.put(`m:${String(seq).padStart(8, '0')}`, { ...msg, seq, ts: Date.now() });
    // keep the newest 20 messages
    const all = await this.ctx.storage.list({ prefix: 'm:' });
    const keys = [...all.keys()];
    if (keys.length > 20) await this.ctx.storage.delete(keys.slice(0, keys.length - 20));
    return seq;
  }
  async progress(p) {
    await this.#touch();
    await this.ctx.storage.put('progress', { ...p, ts: Date.now() });
  }
  async pull(after) {
    await this.#touch('pullrate', PULL_LIMIT_PER_HOUR);
    const all = await this.ctx.storage.list({ prefix: 'm:' });
    // oldest first, within a size budget; the window asks again for the rest
    const messages = [];
    let size = 0;
    for (const m of all.values()) {
      if (m.seq <= after) continue;
      const n = m.size ?? 0;
      if (messages.length && size + n > PULL_BUDGET) break;
      messages.push(m); size += n;
    }
    const seq = (await this.ctx.storage.get('seq')) ?? 0;
    const more = messages.length > 0 && messages[messages.length - 1].seq < seq;
    return { messages, more, progress: (await this.ctx.storage.get('progress')) ?? null, seq };
  }
  // after two hours of silence: drop messages and progress, keep the sequence number so an
  // open window never mistakes new messages for ones it has already seen
  async alarm() {
    const seq = (await this.ctx.storage.get('seq')) ?? 0;
    await this.ctx.storage.deleteAll();
    if (seq) await this.ctx.storage.put('seq', seq);
  }
}

function box(env, session) {
  if (!SESSION_RE.test(String(session ?? ''))) throw Object.assign(new Error('Missing or invalid session id. Use the id from the window message "(session: <id>)", or open the window with study_open.'), { code: -32602 });
  return env.MAILBOX.get(env.MAILBOX.idFromName(session));
}

const clip = (s, n) => (s == null ? undefined : String(s).slice(0, n));

async function callTool(env, name, a) {
  switch (name) {
    case 'study_open': {
      const view = a.view ?? 'home';
      const out = { view, version: VERSION };
      if (a.session && SESSION_RE.test(a.session)) out.session = a.session;
      if (a.data && typeof a.data === 'object') out.data = a.data;
      out.message = 'The Studying window is open. It will tell you its session id in its first message or in the model context.';
      return out;
    }
    case 'study_push': {
      if (!KINDS.includes(a.kind)) throw Object.assign(new Error(`kind must be one of ${KINDS.join(', ')}`), { code: -32602 });
      const size = new TextEncoder().encode(JSON.stringify(a.payload ?? null)).length;
      if (size > MAX_PAYLOAD) throw Object.assign(new Error(`Payload is ${size} bytes; the limit is ${MAX_PAYLOAD}. Split it (e.g. one deck per chapter).`), { code: -32602 });
      const seq = await box(env, a.session).push({ kind: a.kind, title: clip(a.title, 200), payload: a.payload ?? null, size });
      return { delivered: true, seq, note: 'The window shows it within a few seconds if it is open. If the user closed it, call study_open with data.' };
    }
    case 'study_progress': {
      const p = {
        job: clip(a.job, 120), step: Number(a.step) || 0, total: Math.max(1, Number(a.total) || 1), label: clip(a.label, 200),
        steps: Array.isArray(a.steps) ? a.steps.slice(0, 30).map((s) => clip(s, 120)) : undefined, done: !!a.done, error: clip(a.error, 300),
      };
      await box(env, a.session).progress(p);
      return { ok: true };
    }
    case 'study_guide': {
      const g = GUIDES[a.topic];
      if (!g) throw Object.assign(new Error(`Unknown topic. Topics: ${GUIDE_TOPICS.join(', ')}`), { code: -32602 });
      return { topic: a.topic, guide: g };
    }
    case 'study_pull':
      return await box(env, a.session).pull(Number(a.after) || 0);
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  }
}

// ---------- MCP (JSON-RPC) ----------

async function handle(env, origin, msg) {
  const { id, method, params = {} } = msg;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: params.protocolVersion || '2025-06-18',
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, extensions: { 'io.modelcontextprotocol/ui': {} } },
        serverInfo: { name: 'studying', title: 'Studying', version: VERSION, websiteUrl: origin,
          icons: [{ src: `${origin}/icon.svg`, mimeType: 'image/svg+xml', sizes: ['any'] }] },
        instructions: INSTRUCTIONS,
      });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS });
    case 'tools/call': {
      // tool failures go back as tool results (isError), so Claude reads the reason and can fix the call
      let res;
      try { res = await callTool(env, params.name, params.arguments ?? {}); }
      catch (e) { return ok({ content: [{ type: 'text', text: String(e.message ?? e) }], isError: true }); }
      // the window reads structuredContent; keep the text copy short for pulls
      const text = params.name === 'study_guide' ? res.guide
        : params.name === 'study_pull' ? `${res.messages.length} message(s), seq ${res.seq}` : JSON.stringify(res);
      return ok({ content: [{ type: 'text', text }], structuredContent: res });
    }
    case 'resources/list':
      return ok({ resources: [{ uri: WINDOW_URI, name: 'Studying', description: 'The Studying app window', mimeType: WINDOW_MIME }] });
    case 'resources/templates/list': return ok({ resourceTemplates: [] });
    case 'prompts/list': return ok({ prompts: [] });
    case 'resources/read':
      // any older window version maps to the current one, so a cached tool list never breaks
      if (!/^ui:\/\/studying\/window(-[\w.-]+)?\.html$/.test(String(params.uri ?? '')))
        return { jsonrpc: '2.0', id, error: { code: -32002, message: 'Resource not found' } };
      return ok({ contents: [{ uri: params.uri, mimeType: WINDOW_MIME, text: WINDOW_HTML, _meta: { ui: { prefersBorder: false } } }] });
    default:
      if (id === undefined) return null; // notification
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method ${method} is not supported` } };
  }
}

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="6" y="12" width="52" height="40" rx="6" fill="#fbfaf6" stroke="#2d3a52" stroke-width="3"/><line x1="16" y1="12" x2="16" y2="52" stroke="#c0392b" stroke-width="3"/><line x1="22" y1="26" x2="48" y2="26" stroke="#2d3a52" stroke-width="3" stroke-linecap="round"/><line x1="22" y1="36" x2="42" y2="36" stroke="#2d3a52" stroke-width="3" stroke-linecap="round"/></svg>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const html = (body) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } });
    if (request.method === 'GET') {
      if (url.pathname === '/') return html(LANDING_HTML.replaceAll('__ORIGIN__', url.origin).replaceAll('__VERSION__', VERSION));
      if (url.pathname === '/privacy') return html(PRIVACY_HTML);
      if (url.pathname === '/icon.svg' || url.pathname === '/favicon.ico')
        return new Response(ICON_SVG, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' } });
      if (url.pathname === '/health') return Response.json({ ok: true, version: VERSION });
    }
    if (url.pathname !== '/mcp' && url.pathname !== '/mcp/') return new Response('Not found', { status: 404 });
    if (request.method === 'GET') return new Response(null, { status: 405, headers: { allow: 'POST' } });
    if (request.method === 'DELETE') return new Response(null, { status: 204 });
    if (request.method !== 'POST') return new Response(null, { status: 405 });

    let body;
    try { body = await request.json(); } catch { return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }, { status: 400 }); }
    const msgs = Array.isArray(body) ? body : [body];
    const out = [];
    for (const m of msgs.slice(0, 20)) {
      try {
        const r = await handle(env, url.origin, m);
        if (r) out.push(r);
      } catch (e) {
        out.push({ jsonrpc: '2.0', id: m?.id ?? null, error: { code: e.code ?? -32603, message: String(e.message ?? e) } });
      }
    }
    if (!out.length) return new Response(null, { status: 202 });
    return Response.json(Array.isArray(body) ? out : out[0], { headers: { 'cache-control': 'no-store' } });
  },
};
