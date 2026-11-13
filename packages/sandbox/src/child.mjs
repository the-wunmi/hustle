// One Python run, in its own Node process started by runner.ts with the permission model on: it may
// read Pyodide's files and this script, and nothing else (no file writes, no child processes, no
// worker threads, no native addons), with WebAssembly memory capped and no environment. That is the
// security boundary: Python code that gets past the import seal below reaches only a process that
// can't do anything. On a server the process also runs in a container with no network.
//
// Protocol: the request is JSON on stdin; this prints `READY` once Python is up, then one line of
// JSON with the result.
import { constants as fsConstants, readFileSync } from 'node:fs';
import { constants as osConstants } from 'node:os';

// Pyodide asks process.binding for constants, which the permission model refuses; serve them from
// the public modules instead, and let any other binding fail quietly.
const binding = process.binding;
process.binding = (name) => {
  if (name === 'constants') return { fs: fsConstants, os: osConstants };
  try {
    return binding.call(process, name);
  } catch {
    return {};
  }
};

const [pyodideDir, maxOutput] = [process.argv[2], Number(process.argv[3])];
const { code, files, packages } = JSON.parse(readFileSync(0, 'utf8'));
const out = { stdout: '', stderr: '', truncated: false };
// Raw capture: exactly the bytes the program wrote, partial last line included (the browser re-run
// captures the same way, so the two outputs can be compared byte for byte).
const sink = (key) => {
  const decoder = new TextDecoder();
  return {
    write: (bytes) => {
      if (out[key].length < maxOutput) {
        out[key] = `${out[key]}${decoder.decode(bytes, { stream: true })}`;
        if (out[key].length > maxOutput) {
          out[key] = out[key].slice(0, maxOutput);
          out.truncated = true;
        }
      } else out.truncated = true;
      return bytes.length;
    },
  };
};

const { loadPyodide } = await import(`${pyodideDir}/pyodide.mjs`);
// Fixed hash seed and time zone, so the same code prints the same thing here and in a browser re-run.
const py = await loadPyodide({
  jsglobals: {},
  env: { PYTHONHASHSEED: '0', TZ: 'UTC', HOME: '/home/pyodide' },
});
py.setStdout(sink('stdout'));
py.setStderr(sink('stderr'));
await py.loadPackage(packages, { messageCallback: () => {} });
py.FS.mkdirTree('/work');
for (const [name, text] of Object.entries(files)) py.FS.writeFile(`/work/${name}`, text);
// The seal: defence in depth only (the process boundary above is what holds). The globals user
// code starts with are exactly the browser re-run's: os, numpy and pandas.
await py.runPythonAsync(`
import os, numpy, pandas  # loaded before the seal: they import parts of urllib themselves
def _seal():
    import sys, random
    random.seed(0)
    numpy.random.seed(0)
    blocked = ('js', 'pyodide_js', 'pyodide', '_pyodide', '_pyodide_core', 'socket', '_socket', 'ssl',
               '_ssl', 'select', 'ctypes', '_ctypes', 'subprocess', 'multiprocessing', 'micropip',
               'urllib.request', 'http.client')
    hit = lambda name: any(name == b or name.startswith(b + '.') for b in blocked)
    for name in list(sys.modules):
        if hit(name):
            sys.modules.pop(name, None)
    class Blocked:
        def find_spec(self, name, path=None, target=None):
            if hit(name):
                raise ImportError(f"{name} is not available in the sandbox")
            return None
    sys.meta_path.insert(0, Blocked())
_seal()
del _seal
os.chdir('/work')
`);
process.stdout.write('READY\n');
const started = performance.now();
let error = null;
try {
  await py.runPythonAsync(code);
} catch (err) {
  const lines = String(err?.message ?? err)
    .trim()
    .split('\n');
  error = lines[lines.length - 1] ?? 'error';
  out.stderr = `${out.stderr}${String(err?.message ?? err)}`.slice(0, maxOutput);
}
try {
  // Output written without a final newline is still output.
  await py.runPythonAsync('import sys\nsys.stdout.flush()\nsys.stderr.flush()');
} catch {}
process.stdout.write(
  `${JSON.stringify({
    stdout: out.stdout,
    stderr: out.stderr,
    truncated: out.truncated,
    error,
    runMs: Math.round(performance.now() - started),
  })}\n`,
);
process.exit(0);
