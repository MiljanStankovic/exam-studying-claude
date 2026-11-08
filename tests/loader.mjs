// Lets Node import the Worker: stubs 'cloudflare:workers' and loads .html files as text.
import { readFile } from 'node:fs/promises';
export async function resolve(spec, ctx, next) {
  if (spec === 'cloudflare:workers') return { url: 'stub:cloudflare-workers', shortCircuit: true };
  return next(spec, ctx);
}
export async function load(url, ctx, next) {
  if (url === 'stub:cloudflare-workers')
    return { format: 'module', shortCircuit: true, source: 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }' };
  if (url.endsWith('.html'))
    return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(await readFile(new URL(url), 'utf8'))};` };
  return next(url, ctx);
}
