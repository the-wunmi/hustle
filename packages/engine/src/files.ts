import { DomainError, sha256Hex } from '@hustle/core';
import { jobFiles } from '@hustle/db';
import { asc, eq } from 'drizzle-orm';
import type { Engine } from './context.ts';

/** Most a single job file may hold (text). */
export const MAX_FILE_CHARS = 200_000;
/** Most files a client attaches to one task. */
export const MAX_CLIENT_FILES = 3;

export type JobFile = typeof jobFiles.$inferSelect;

/** A file name the sandbox can open as is: letters, digits, `._-`, a text extension. */
export const isFileName = (name: string): boolean =>
  /^[\w.-]{1,80}$/.test(name) && /\.(csv|json|txt|md|tsv|py)$/i.test(name) && !name.startsWith('.');

/** Files an agent may write as part of its work: any plain-text kind (served as downloads only). */
export const isAgentFileName = (name: string): boolean =>
  /^[\w.-]{1,80}$/.test(name) &&
  /\.(csv|json|txt|md|tsv|py|html|css|js|ts|sql|yaml|yml|xml|svg)$/i.test(name) &&
  !name.startsWith('.');
/** Most files, and characters in each, an agent writes for one job. */
export const MAX_AGENT_FILES = 10;
export const MAX_AGENT_FILE_CHARS = 100_000;

/** Keeps a file for a job, once per name (a re-run of the same tool doesn't change it). */
export async function saveJobFile(
  engine: Engine,
  jobId: string,
  name: string,
  content: string,
  source: string,
  opts: { replace?: boolean } = {},
): Promise<void> {
  const valid = source === 'agent' ? isAgentFileName(name) : isFileName(name);
  if (!valid) throw new DomainError('invalid', `Not a file name the sandbox can read: ${name}`);
  if (content.length > MAX_FILE_CHARS)
    throw new DomainError(
      'invalid',
      `${name} is too big (at most ${MAX_FILE_CHARS.toLocaleString()} characters)`,
    );
  const row = { jobId, name, content, sha256: sha256Hex(content), source };
  // An agent may rewrite its own file; anything else is kept as first saved.
  if (opts.replace)
    await engine.db
      .insert(jobFiles)
      .values(row)
      .onConflictDoUpdate({
        target: [jobFiles.jobId, jobFiles.name],
        set: { content, sha256: row.sha256, source },
      });
  else await engine.db.insert(jobFiles).values(row).onConflictDoNothing();
}

export const jobFilesOf = (engine: Engine, jobId: string): Promise<JobFile[]> =>
  engine.db
    .select()
    .from(jobFiles)
    .where(eq(jobFiles.jobId, jobId))
    .orderBy(asc(jobFiles.createdAt));
