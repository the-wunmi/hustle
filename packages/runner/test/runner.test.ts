import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain script with no types, by design (no build, no dependencies).
import {
  changedFiles,
  containerArgs,
  jobFolder,
  parseArgs,
  printable,
  syncFiles,
} from '../hustle-runner.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'hustle-runner-'));
const JOB = '0b8e2f7c-1d2a-4e5f-9a8b-7c6d5e4f3a2b';

describe('the runner on an owner’s computer', () => {
  it('reads its command line', () => {
    expect(parseArgs(['pair', 'ABCD-EFGH', '--server', 'http://x'])).toEqual({
      command: 'pair',
      args: ['ABCD-EFGH'],
      flags: { server: 'http://x' },
    });
    expect(parseArgs(['start', '--no-container']).flags).toEqual({ 'no-container': true });
  });

  it('keeps every job inside its own folder, whatever id the server sends', () => {
    expect(jobFolder(JOB, '/base')).toBe(`/base/${JOB}`);
    for (const bad of ['../../etc', `${JOB}/..`, '', 'x'.repeat(36)])
      expect(() => jobFolder(bad, '/base'), bad).toThrow();
  });

  it('writes the job files once, never over the commands’ own edits, and refuses odd names', () => {
    const dir = tmp();
    const state = tmp();
    syncFiles(
      dir,
      [
        { name: 'sum.js', content: 'v1' },
        { name: '../evil.sh', content: 'x' },
        { name: '.bashrc', content: 'x' },
      ],
      state,
      'j',
    );
    expect(readFileSync(join(dir, 'sum.js'), 'utf8')).toBe('v1');
    writeFileSync(join(dir, 'sum.js'), 'edited by a command');
    syncFiles(dir, [{ name: 'sum.js', content: 'v1' }], state, 'j');
    expect(readFileSync(join(dir, 'sum.js'), 'utf8')).toBe('edited by a command');
    // Hustle's copy changed (the agent rewrote it): that wins.
    syncFiles(dir, [{ name: 'sum.js', content: 'v2' }], state, 'j');
    expect(readFileSync(join(dir, 'sum.js'), 'utf8')).toBe('v2');
    expect(() => readFileSync(join(dir, '..', 'evil.sh'))).toThrow();
  });

  it('sends back only text files the command changed, not dependencies or hidden files', () => {
    const dir = tmp();
    const old = Date.now() / 1000 - 3600;
    writeFileSync(join(dir, 'old.txt'), 'old');
    utimesSync(join(dir, 'old.txt'), old, old);
    mkdirSync(join(dir, 'node_modules/pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules/pkg/index.js'), 'dep');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/out.md'), 'result');
    writeFileSync(join(dir, '.env'), 'SECRET=1');
    writeFileSync(join(dir, 'bin.dat'), 'a\u0000b');
    const files = changedFiles(dir, Date.now() - 60_000);
    expect(files).toEqual([{ name: 'src/out.md', content: 'result' }]);
  });

  it('starts each job’s container with its folder only, the owner’s user id and no extra powers', () => {
    const args = containerArgs('hustle-job-x', '/jobs/x', '501:20');
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(at('--user')).toBe('501:20');
    expect(at('--cap-drop')).toBe('ALL');
    expect(at('--security-opt')).toBe('no-new-privileges');
    expect(at('--mount')).toBe('type=bind,src=/jobs/x,dst=/work');
    expect(args.filter((a: string) => a === '--mount' || a === '-v')).toHaveLength(1);
    expect(args).not.toContain('--privileged');
    expect(args).not.toContain('/var/run/docker.sock');
  });

  it('never writes or reads through a link a command planted in the job folder', () => {
    const dir = tmp();
    const state = tmp();
    const outside = join(tmp(), 'precious.txt');
    writeFileSync(outside, 'mine');
    syncFiles(dir, [{ name: 'notes.md', content: 'v1' }], state, 'j');
    // A command swaps the file for a link to a file of the owner's.
    unlinkSync(join(dir, 'notes.md'));
    symlinkSync(outside, join(dir, 'notes.md'));
    syncFiles(dir, [{ name: 'notes.md', content: 'v2 from Hustle' }], state, 'j');
    expect(readFileSync(outside, 'utf8')).toBe('mine');
    expect(readFileSync(join(dir, 'notes.md'), 'utf8')).toBe('v2 from Hustle');
    // A link to an outside file or folder is never sent back.
    symlinkSync(outside, join(dir, 'leak.txt'));
    symlinkSync(join(outside, '..'), join(dir, 'leakdir'));
    const names = changedFiles(dir, 0).map((f: { name: string }) => f.name);
    expect(names).not.toContain('leak.txt');
    expect(names.some((n: string) => n.startsWith('leakdir'))).toBe(false);
  });

  it('shows control characters escaped, so a command can’t disguise itself', () => {
    expect(printable('ls\u001b[2K\u001b[1Grm -rf ~')).toBe('ls\\x1b[2K\\x1b[1Grm -rf ~');
    expect(printable('line one\n\tline two')).toBe('line one\n\tline two');
  });
});
