// Builds the app window: puts the MCP Apps SDK inside the HTML, because the window in Claude
// has no network access to load it. Output: server/src/window.html
//
//   node scripts/build.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SDK_VERSION = '2.0.3';
const CACHE = join(ROOT, '.sdk', `app-with-deps-${SDK_VERSION}.js`);

function sdk() {
  if (!existsSync(CACHE)) {
    mkdirSync(dirname(CACHE), { recursive: true });
    const t = mkdtempSync(join(tmpdir(), 'sdk-'));
    execFileSync('npm', ['pack', `@modelcontextprotocol/ext-apps@${SDK_VERSION}`, '--silent'], { cwd: t, stdio: ['ignore', 'pipe', 'inherit'] });
    execFileSync('tar', ['xzf', `modelcontextprotocol-ext-apps-${SDK_VERSION}.tgz`], { cwd: t });
    copyFileSync(join(t, 'package/dist/src/app-with-deps.js'), CACHE);
  }
  const code = readFileSync(CACHE, 'utf8');
  // turn the final "export{a as B,...}" into window.__mcpApps = {B: a, ...}
  const all = [...code.matchAll(/export\s*\{([^}]*)\};?\s*$/g)];
  if (!all.length) throw new Error('SDK has no trailing export; check the version');
  const last = all[all.length - 1];
  const pairs = last[1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [local, , name] = s.split(/\s+/);
    return `${(name ?? local).trim()}:${local.trim()}`;
  });
  return code.slice(0, last.index) + 'window.__mcpApps={' + pairs.join(',') + '};';
}

const src = readFileSync(join(ROOT, 'app', 'window.src.html'), 'utf8');
if (!src.includes('/*SDK*/')) throw new Error('window.src.html has no /*SDK*/ marker');
// the SDK gets its own block scope so its minified top-level names cannot clash with the app's
const out = src.replace('/*SDK*/', () => '{' + sdk() + '}');
writeFileSync(join(ROOT, 'server', 'src', 'window.html'), out);
console.log(`window.html: ${(out.length / 1024).toFixed(0)} KB`);
