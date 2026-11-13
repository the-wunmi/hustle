// Re-runs an agent's sandbox run in this browser, the way the server's sandbox ran it: a fresh
// Pyodide with the same packages, the files in /work, the same seed and time zone, the same seal on
// imports and the same raw output capture. This frame has an opaque origin, so even code that got
// past the seal can't act as the viewer: it can't read the page or its cookies, and the API won't
// answer it. Python runs in a worker, killed at the server's time limit, so it can't freeze the page.
const MAX_OUTPUT = 64000;
const BOOT_MS = 90000;
const RUN_MS = 20000;
const base = new URL('/pyodide/', location.href).href;

const SEAL = `
import os, numpy, pandas
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
`;

// The worker's code: boots Pyodide, runs one program, posts back what it wrote.
const WORKER = `
importScripts(${JSON.stringify(`${base}pyodide.js`)});
onmessage = async (event) => {
  const { code, files, seal, maxOutput } = event.data;
  let stdout = '';
  const decoder = new TextDecoder();
  const py = await loadPyodide({
    indexURL: ${JSON.stringify(base)},
    jsglobals: {},
    env: { PYTHONHASHSEED: '0', TZ: 'UTC', HOME: '/home/pyodide' },
  });
  py.setStdout({
    write: (bytes) => {
      if (stdout.length < maxOutput) stdout = (stdout + decoder.decode(bytes, { stream: true })).slice(0, maxOutput);
      return bytes.length;
    },
  });
  py.setStderr({ write: (bytes) => bytes.length });
  await py.loadPackage(['numpy', 'pandas'], { messageCallback: () => {} });
  py.FS.mkdirTree('/work');
  for (const [name, text] of Object.entries(files)) py.FS.writeFile('/work/' + name, text);
  await py.runPythonAsync(seal);
  postMessage({ ready: true });
  try {
    await py.runPythonAsync(code);
  } catch {
    // An error is part of the run being compared: the server recorded its output up to it too.
  }
  try {
    await py.runPythonAsync('import sys\\nsys.stdout.flush()\\nsys.stderr.flush()');
  } catch {}
  postMessage({ stdout });
};
`;

function run(code, files) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' })));
    const stop = (fn) => {
      clearTimeout(timer);
      worker.terminate();
      fn();
    };
    let timer = setTimeout(
      () => stop(() => reject(new Error('Python took too long to start'))),
      BOOT_MS,
    );
    worker.onmessage = (event) => {
      if (event.data.ready) {
        clearTimeout(timer);
        timer = setTimeout(
          () => stop(() => reject(new Error('the program ran past the time limit'))),
          RUN_MS,
        );
        return;
      }
      stop(() => resolve(event.data.stdout));
    };
    worker.onerror = (event) => stop(() => reject(new Error(event.message || 'the worker failed')));
    worker.postMessage({ code, files, seal: SEAL, maxOutput: MAX_OUTPUT });
  });
}

window.addEventListener('message', async (event) => {
  if (event.source !== window.parent) return;
  const { id, code, files } = event.data ?? {};
  if (typeof id !== 'string' || typeof code !== 'string' || typeof files !== 'object') return;
  try {
    window.parent.postMessage({ id, stdout: await run(code, files) }, '*');
  } catch (err) {
    window.parent.postMessage({ id, error: String(err?.message ?? err).slice(0, 200) }, '*');
  }
});
window.parent.postMessage({ ready: true }, '*');
