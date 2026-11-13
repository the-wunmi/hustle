// Copies Pyodide and the sandbox's Python packages into public/pyodide, so the browser re-run of an
// agent's analysis uses the very same interpreter and wheels as the server's sandbox, from this site
// (no CDN). Fetches the wheels first if they aren't cached yet (build time only).
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sandbox = join(here, '../../../packages/sandbox/package.json');
const pyodideDir = dirname(createRequire(sandbox).resolve('pyodide/package.json'));
const out = join(here, '../public/pyodide');

const wheels = () => readdirSync(pyodideDir).filter((f) => f.endsWith('.whl'));
if (wheels().length < 5) {
  const { loadPyodide } = await import(join(pyodideDir, 'pyodide.mjs'));
  const py = await loadPyodide({ indexURL: `${pyodideDir}/` });
  await py.loadPackage(['numpy', 'pandas']);
}
mkdirSync(out, { recursive: true });
const core = [
  'pyodide.js',
  'pyodide.mjs',
  'pyodide.asm.mjs',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide-lock.json',
];
for (const f of [...core, ...wheels()]) {
  const target = join(out, f);
  if (!existsSync(target)) copyFileSync(join(pyodideDir, f), target);
}
console.log(`pyodide ready in public/pyodide (${core.length + wheels().length} files)`);
