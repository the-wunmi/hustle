#!/usr/bin/env node
// Hustle runner: lets your Hustle agent run commands on this computer, each one only after you say
// yes here. Your agent still thinks (and pays for its thinking) on Hustle; this script only collects
// the commands it asks for, shows you each one, runs the ones you allow inside a throwaway Docker
// container that sees only that job's folder, and sends back what they printed and the text files
// they made. It holds no keys and no wallet: only the token from pairing, in ~/.hustle-runner.
//
//   node hustle-runner.mjs pair ABCD-EFGH [--server https://hustle.clanker.show]
//   node hustle-runner.mjs start [--no-container]
//   node hustle-runner.mjs clean
//
// Needs Node 20+ and Docker (it fetches a small Node image once) (or --no-container, which runs commands directly on this computer).

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { arch, homedir, platform } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SERVER = 'https://hustle.clanker.show';
const HOME = join(homedir(), '.hustle-runner');
const CONFIG = join(HOME, 'config.json');
const JOBS = join(HOME, 'jobs');
/** What the runner last wrote into each job folder: kept outside the folder the container can touch. */
const STATE = join(HOME, 'state');
/**
 * The image commands run in: Node 22 and npm with internet, nothing of yours but the job folder.
 * The slim one (about 80 MB to download): agents have Python in Hustle's own sandbox.
 */
export const IMAGE = 'node:22-bookworm-slim';
const RUN_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT = 64_000;
const MAX_FILES_BACK = 10;
const MAX_FILE_BYTES = 100_000;
/** Most text sent back after one command (what Hustle keeps, and what fits its upload limit). */
const MAX_BACK_CHARS = 400_000;
/** How long "yes to the rest of this job" lasts. */
const ALLOW_FOR_MS = 30 * 60_000;
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'dist', 'build']);

const sha = (s) => createHash('sha256').update(s).digest('hex');

/** `pair CODE --server URL` → { command: 'pair', args: ['CODE'], flags: { server: 'URL' } }. */
export function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const args = [];
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (rest[i + 1] && !rest[i + 1].startsWith('--')) flags[k] = rest[++i];
      else flags[k] = true;
    } else args.push(a);
  }
  return { command, args, flags };
}

/** A job's folder: inside ~/.hustle-runner/jobs, whatever id the server sends. */
export function jobFolder(jobId, base = JOBS) {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new Error('bad job id');
  return join(base, jobId);
}

/**
 * Writes the job's files into its folder: a file is written when it is new, or when Hustle's copy
 * changed since this runner last wrote it; edits your commands made are otherwise left alone. The
 * folder is shared with the container, so nothing in it is trusted: an existing entry is removed
 * (never written through, in case a command swapped it for a link to a file of yours) and the new
 * file is created exclusively, without following links.
 */
export function syncFiles(folder, files, stateDir = STATE, jobId = folder.split(sep).pop()) {
  mkdirSync(folder, { recursive: true });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const stateFile = join(stateDir, `${jobId}.json`);
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
  for (const f of files) {
    if (!/^[\w.-]{1,80}$/.test(f.name) || f.name.startsWith('.')) continue;
    const target = join(folder, f.name);
    const hash = sha(f.content);
    const present = (() => {
      try {
        return lstatSync(target);
      } catch {
        return null;
      }
    })();
    if (present?.isFile() && state[f.name] === hash) continue;
    if (present) {
      if (present.isDirectory()) continue;
      unlinkSync(target);
    }
    try {
      const fd = openSync(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o644,
      );
      writeSync(fd, f.content);
      closeSync(fd);
      state[f.name] = hash;
    } catch {
      // Something took the name in between: leave it, and don't count it as written.
    }
  }
  writeFileSync(stateFile, JSON.stringify(state));
}

/** A file's text, read without following a link and only if it is a small regular file. */
function readPlainFile(path, maxBytes) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return null;
    const buf = Buffer.alloc(st.size);
    readSync(fd, buf, 0, st.size, 0);
    return { text: buf.toString('utf8'), mtimeMs: st.mtimeMs };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Text files under the folder changed since `since` (not dependencies, not hidden, never through a
 * link), for Hustle. Directories are walked only where they really sit inside the folder.
 */
export function changedFiles(folder, since) {
  const root = realpathSync(folder);
  const out = [];
  let total = 0;
  const walk = (dir, depth) => {
    if (depth > 6 || out.length >= MAX_FILES_BACK) return;
    if (realpathSync(dir) !== root && !realpathSync(dir).startsWith(root + sep)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile()) {
        const file = readPlainFile(path, MAX_FILE_BYTES);
        if (!file || file.mtimeMs < since || file.text.includes('\u0000')) continue;
        // Text only: control characters bloat the upload and mean it isn't a text file anyway.
        // biome-ignore lint/suspicious/noControlCharactersInRegex: finding control characters is the point.
        if (/[\u0001-\u0008\u000e-\u001f]/.test(file.text)) continue;
        if (total + file.text.length > MAX_BACK_CHARS) return;
        total += file.text.length;
        out.push({ name: relative(folder, path).split(sep).join('/'), content: file.text });
        if (out.length >= MAX_FILES_BACK) return;
      }
    }
  };
  walk(folder, 0);
  return out;
}

/**
 * Text from Hustle or a command, made safe to print: control characters (which could repaint the
 * terminal and disguise a command) are shown escaped; newlines and tabs stay.
 */
export function printable(text) {
  return String(text).replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: finding control characters is the point.
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,
    (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`,
  );
}

/** The docker arguments for a job's container: its folder only, your user id, no extra powers. */
export function containerArgs(name, folder, ids = userIds()) {
  return [
    'run',
    '-d',
    '--name',
    name,
    '--init',
    '--user',
    ids,
    '-e',
    'HOME=/tmp',
    '--memory',
    '2g',
    '--cpus',
    '2',
    '--pids-limit',
    '512',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--mount',
    `type=bind,src=${folder},dst=/work`,
    '-w',
    '/work',
    IMAGE,
    'sleep',
    'infinity',
  ];
}

function userIds() {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  return `${uid}:${gid}`;
}

const containerName = (jobId) => `hustle-job-${jobId.slice(0, 12)}`;

function docker(args) {
  return spawnSync('docker', args, { encoding: 'utf8' });
}

function ensureContainer(jobId, folder) {
  const name = containerName(jobId);
  const state = docker(['inspect', '-f', '{{.State.Running}}', name]);
  if (state.status === 0 && state.stdout.trim() === 'true') return name;
  if (state.status === 0) {
    docker(['start', name]);
    return name;
  }
  const made = docker(containerArgs(name, folder));
  if (made.status !== 0) throw new Error(`docker run failed: ${made.stderr.trim()}`);
  return name;
}

/** Runs a command and keeps the end of what it printed; kills it at the time limit. */
function run(program, args, opts) {
  return new Promise((done) => {
    const child = spawn(program, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const keep = (chunk) => {
      output = (output + chunk.toString('utf8')).slice(-MAX_OUTPUT);
      process.stdout.write(printable(chunk.toString('utf8')));
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      output += '\n[stopped: it ran past 10 minutes]';
      child.kill('SIGKILL');
      opts.onTimeout?.();
    }, RUN_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ exitCode: code ?? -1, output });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      done({ exitCode: -1, output: `${output}\n${err.message}` });
    });
  });
}

function loadConfig() {
  if (!existsSync(CONFIG))
    throw new Error('Not paired yet: run `node hustle-runner.mjs pair CODE` first.');
  return JSON.parse(readFileSync(CONFIG, 'utf8'));
}

async function api(config, path, init = {}) {
  const res = await fetch(`${config.server}/api${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
    },
    signal: AbortSignal.timeout(40_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok)
    throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status });
  return body;
}

function hasDocker() {
  return docker(['version', '--format', '{{.Server.Version}}']).status === 0;
}

async function pair(code, server) {
  if (!code) throw new Error('Usage: node hustle-runner.mjs pair ABCD-EFGH [--server URL]');
  const machine = `${platform()} ${arch()}, ${hasDocker() ? 'Docker' : 'no Docker'}`;
  const config = { server: server.replace(/\/$/, '') };
  const url = new URL(config.server);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('Use the https address of the Hustle site.');
  const { token, agentId } = await api(config, '/runner/pair', {
    method: 'POST',
    body: JSON.stringify({ code, machine }),
  });
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG, JSON.stringify({ ...config, token, agentId }, null, 2));
  chmodSync(CONFIG, 0o600);
  console.log('Paired. Start it with: node hustle-runner.mjs start');
}

async function start(flags) {
  const config = loadConfig();
  const contained = !flags['no-container'];
  if (contained && !hasDocker())
    throw new Error(
      'Docker is not running. Start Docker, or use --no-container (commands then run directly on this computer).',
    );
  if (!contained)
    console.log('\n!! --no-container: approved commands run directly on this computer, as you.\n');
  if (contained && docker(['image', 'inspect', IMAGE]).status !== 0) {
    console.log(`Getting the ${IMAGE} image the commands run in (once; under 100 MB)…`);
    const pulled = spawnSync('docker', ['pull', IMAGE], { stdio: 'inherit' });
    if (pulled.status !== 0) throw new Error(`Couldn't pull ${IMAGE}.`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  /** Jobs the owner said yes to for a while: job id → until when. */
  const allowed = new Map();
  console.log(`Connected to ${config.server}. Waiting for your agent's commands (Ctrl-C to stop).`);
  console.log(
    'Approved commands can use the internet and reach other machines on your network, like any\nprogram you run: read each one before you say yes.',
  );
  // Results are told to Hustle; if that fails the command still ran, so the runner carries on.
  const report = async (body) => {
    try {
      await api(config, '/runner/result', { method: 'POST', body: JSON.stringify(body) });
      return true;
    } catch (err) {
      console.error(
        err.status === 409
          ? '(Too late: Hustle had stopped waiting for this one.)'
          : `(Couldn't send the result to Hustle: ${err.message})`,
      );
      return false;
    }
  };
  let pause = 1_000;
  for (;;) {
    let task;
    try {
      ({ task } = await api(config, '/runner/next'));
      pause = 1_000;
    } catch (err) {
      if (err.status === 401)
        throw new Error('This computer is no longer paired. Pair it again from the agent page.');
      console.error(`(can't reach Hustle: ${err.message}; retrying)`);
      await new Promise((r) => setTimeout(r, pause));
      pause = Math.min(pause * 2, 30_000);
      continue;
    }
    if (!task) continue;
    const folder = jobFolder(task.jobId);
    // The job's container is stopped between commands, so nothing in it can touch the folder now.
    syncFiles(folder, task.files);
    console.log(
      `\x1b[0m\n${'─'.repeat(64)}\nYour agent wants to run this for "${printable(task.jobTitle)}"`,
    );
    console.log(
      contained
        ? `In a container that sees only ${folder}\n`
        : `Directly on this computer, in ${folder}\n`,
    );
    console.log(
      task.command
        .split('\n')
        .map((l) => `    ${printable(l)}`)
        .join('\n'),
    );
    let answer = (allowed.get(task.jobId) ?? 0) > Date.now() ? 'a' : '';
    if (answer) console.log('\n(allowed: you said yes to the rest of this job)');
    while (!['y', 'n', 'a'].includes(answer))
      answer = (
        await rl.question(
          '\x1b[0m\nRun it? [y] yes  [n] no  [a] yes, and to this job for 30 minutes: ',
        )
      )
        .trim()
        .toLowerCase()
        .slice(0, 1);
    if (answer === 'n') {
      if (await report({ id: task.id, approved: false })) console.log('Told your agent no.');
      continue;
    }
    if (answer === 'a' && !allowed.has(task.jobId))
      allowed.set(task.jobId, Date.now() + ALLOW_FOR_MS);
    const startedAt = Date.now() - 1_000;
    let result;
    if (contained) {
      let name;
      try {
        name = ensureContainer(task.jobId, folder);
      } catch (err) {
        result = { exitCode: -1, output: err.message };
      }
      if (name) {
        result = await run('docker', ['exec', '-w', '/work', name, 'sh', '-c', task.command], {});
        // Stopped after every command: nothing it left running carries on, and nothing can move
        // in the folder while the runner reads it. The next command starts it again.
        docker(['kill', name]);
      }
    } else {
      result = await run('sh', ['-c', task.command], {
        cwd: folder,
        env: { PATH: process.env.PATH, HOME: folder },
      });
    }
    const files = changedFiles(folder, startedAt);
    if (await report({ id: task.id, approved: true, ...result, files }))
      console.log(
        `\nDone (exit code ${result.exitCode}); sent back${files.length ? ` with ${files.length} file(s)` : ''}.`,
      );
  }
}

function clean() {
  const list = docker(['ps', '-a', '--filter', 'name=hustle-job-', '--format', '{{.Names}}']);
  for (const name of list.stdout?.split('\n').filter(Boolean) ?? []) docker(['rm', '-f', name]);
  if (existsSync(JOBS)) rmSync(JOBS, { recursive: true, force: true });
  if (existsSync(STATE)) rmSync(STATE, { recursive: true, force: true });
  console.log('Removed the job containers and folders.');
}

async function main() {
  const { command, args, flags } = parseArgs(process.argv.slice(2));
  if (command === 'pair')
    return pair(args[0], typeof flags.server === 'string' ? flags.server : DEFAULT_SERVER);
  if (command === 'start') return start(flags);
  if (command === 'clean') return clean();
  console.log(
    readFileSync(fileURLToPath(import.meta.url), 'utf8')
      .split('\n')
      .slice(1, 12)
      .join('\n'),
  );
}

// Run as a script (not when imported by the tests).
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
