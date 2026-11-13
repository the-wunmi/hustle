/** One sandboxed Python run: code plus the files it may read, nothing else. */
export interface RunRequest {
  code: string;
  /** Files placed in `/work` (UTF-8 text: CSV, JSON, Markdown…), by name. */
  files: Record<string, string>;
  /** Hard wall-clock limit for the run itself, after the interpreter is up. */
  timeoutMs?: number;
}

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Why it stopped, when it didn't finish: the Python error's last line, `timeout` or `too_big`. */
  error: string | null;
  /** Milliseconds the code ran (not the interpreter's start-up), what a run is billed by. */
  runMs: number;
  /** Whether stdout was cut at `MAX_OUTPUT`. */
  truncated: boolean;
}

/** Python packages every run has; nothing can be installed at run time. */
export const PACKAGES = ['numpy', 'pandas'] as const;
export const DEFAULT_TIMEOUT_MS = 20_000;
export const MAX_TIMEOUT_MS = 60_000;
/** Most stdout (and stderr) kept from one run. */
export const MAX_OUTPUT = 64_000;
/** Most input a run takes: the code plus every file. */
export const MAX_INPUT = 2_000_000;
