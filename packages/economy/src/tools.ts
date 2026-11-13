import { type Category, type Micro, usd } from '@hustle/core';

/**
 * A tool an agent can use during a job: real work done by a real service, paid from the agent's
 * wallet (the service's fee per use plus the thinking the tool takes). Tools are offered at the
 * planning step, run at the tools step, and what they return is the agent's notes for the draft.
 * Adding one means a spec here and a runner in the engine (`engine/src/tools`).
 */
export interface ToolSpec {
  /** Stable id: what the plan names and receipts record. */
  id: string;
  name: string;
  /** What it does, for the model's menu and the player. */
  description: string;
  /** Categories whose work it helps (and so where agents reach for it). */
  helps: readonly Category[];
  /** The fee per use before the live price is read (the engine replaces it at startup). */
  fee: Micro;
  /** The provider's service name in its price list (NEAR AI Cloud `GET /v1/services`), if priced there. */
  service?: string;
  /** Uses of the tool in one job (searches, sandbox runs…), each paying `fee`. */
  usesPerCall: number;
  /** Model calls one job's use of the tool makes, and the size of each. */
  modelCalls: number;
  inTokens: number;
  outTokens: number;
  /** Tokens of notes the draft then reads. */
  notesTokens: number;
  /**
   * A nice-to-have (web search outside research), which frugal agents skip. Tools that are how the
   * work gets done at all (reading the chain, analysing the files) are never skipped to save money.
   */
  optional?: boolean;
  /**
   * Needs an input the agent chooses (a URL), so only the agent loop offers it: the pipeline, and the
   * cost model that prices the pipeline, leave it out.
   */
  needsInput?: boolean;
}

export const TOOLS: readonly ToolSpec[] = [
  {
    id: 'web_search',
    name: 'Web search',
    description:
      'Searches the web (Brave, through NEAR AI) and notes the facts with their sources.',
    helps: ['research', 'copywriting', 'data_cleanup'],
    // NEAR AI's listed price (cloud-api.near.ai/v1/services, 2026-11-13); read live at startup.
    fee: usd('0.005'),
    service: 'web_search',
    // Measured live 2026-11-13 on a research job: 3 searches, 24,068 tokens in, 903 out.
    usesPerCall: 3,
    modelCalls: 1,
    inTokens: 24_200,
    outTokens: 900,
    notesTokens: 900,
    optional: true,
  },
  {
    id: 'chain_data',
    name: 'Chain data',
    description:
      'Reads NEAR mainnet for tokens named in the brief: metadata, total supply and the top holders, saved as files for analysis.',
    helps: ['research', 'data_cleanup'],
    // Public reads (NEAR RPC, FastNEAR): no fee and no model call; the draft reads the summary.
    fee: 0n,
    usesPerCall: 1,
    modelCalls: 0,
    inTokens: 0,
    outTokens: 0,
    notesTokens: 1_500,
  },
  {
    id: 'python',
    name: 'Python sandbox',
    description:
      "Writes and runs Python (numpy, pandas) on the job's files in an isolated sandbox, reads the output and tries again, up to three runs; anyone can re-run it.",
    helps: ['research', 'data_cleanup', 'code_review'],
    // Hustle's own sandbox: a flat price per run (no network, 20 s at most).
    fee: usd('0.001'),
    usesPerCall: 3,
    modelCalls: 3,
    // Measured live 2026-11-13: a first analysis program ran past 2,000 output tokens as JSON.
    inTokens: 3_500,
    outTokens: 2_000,
    notesTokens: 700,
  },
  {
    id: 'fetch',
    name: 'Read a web page',
    description:
      'Reads one public web page, API answer or dataset (text) and saves it as a file for analysis.',
    helps: ['research', 'data_cleanup', 'code_review', 'copywriting', 'summary', 'translation'],
    // Hustle reads it directly: no fee; the agent pays for reading what came back.
    fee: 0n,
    usesPerCall: 1,
    modelCalls: 0,
    inTokens: 0,
    outTokens: 0,
    notesTokens: 1_500,
    needsInput: true,
  },
];

export const toolById = (id: string): ToolSpec | undefined => TOOLS.find((t) => t.id === id);
