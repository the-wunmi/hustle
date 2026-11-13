// Fetches the sandbox's Python packages into Pyodide's local cache (node_modules/pyodide), once, at
// build time; the sandbox never downloads anything when it runs. Pyodide checks each wheel's sha256
// against its lock file.
import { loadPyodide } from 'pyodide';

const py = await loadPyodide();
await py.loadPackage(['numpy', 'pandas']);
console.log('sandbox wheels cached');
