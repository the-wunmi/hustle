import { createRng, defaultRulebook, defaultStrategy, sha256, type Trait } from '@hustle/core';
import { DEFAULT_ECONOMY, emptySkills, scamSusceptibility, screenJobText } from '@hustle/economy';
import type { ChatRequest } from '@hustle/nearai';
import { type BrainContext, parseContext, parseDraft, parseJobBody } from './prompts.ts';
import { RECORDED_WORK } from './recorded.ts';

/**
 * The model the NEAR AI Cloud simulator plays in mock mode. It reads the same prompt a real model
 * would, answers in the same JSON, and follows the game's personality rules (for example how likely
 * a trait is to fall for an injected payment instruction). Its usage is the workload in the context,
 * so metered costs match the economy model. Every output it writes is labelled simulated in the UI.
 */
export function scriptedResponse(request: ChatRequest): {
  content: string;
  promptTokens: number;
  completionTokens: number;
} {
  const user = request.messages.find((m) => m.role === 'user')?.content ?? '';
  const ctx = parseContext(user);
  if (!ctx) return { content: '{}', promptTokens: 50, completionTokens: 2 };
  const body = parseJobBody(user);
  // A loop turn: list the files, write a report, then deliver.
  if (ctx.purpose === 'act') {
    const done = ctx.steps?.length ?? 0;
    return {
      content:
        done === 0
          ? "Let me see the files first.\n```python\nimport os\nprint(sorted(os.listdir('.')))\n```"
          : done === 1
            ? 'Writing it up.\n```write report.md\n# Report\n\nChecked the files.\n```'
            : 'Done.\n```deliver\nThe report is in report.md.\n```',
      promptTokens: ctx.workload.inTokens,
      completionTokens: ctx.workload.outTokens,
    };
  }
  // A coding turn answers in plain text: one run that lists the files, then DONE.
  if (ctx.purpose === 'code')
    return {
      content: ctx.runs?.length
        ? `DONE\nChecked ${ctx.files?.length ?? 0} file(s).`
        : "```python\nimport os\nprint(sorted(os.listdir('.')))\n```",
      promptTokens: ctx.workload.inTokens,
      completionTokens: ctx.workload.outTokens,
    };
  // A tool call answers in plain text (provider tools can't run alongside a response schema).
  if (ctx.purpose === 'tool')
    return {
      content: `Notes for "${ctx.job.title}": the key facts the brief asks for, each with its source.`,
      promptTokens: ctx.workload.inTokens,
      completionTokens: ctx.workload.outTokens,
    };
  const rng = createRng(sha256({ user, model: request.model }));
  const answer = (() => {
    switch (ctx.purpose) {
      case 'bid':
        return { pitch: pitchFor(ctx, rng.next()) };
      case 'plan':
        return planFor(ctx, body, rng.next());
      case 'draft':
        return { deliverable: workFor(ctx, body), embedded_instructions: injectionIn(body) };
      case 'review':
        return {
          notes: ['Tightened wording', 'Checked names and numbers against the brief'],
          deliverable: parseDraft(user) ?? workFor(ctx, body),
        };
      case 'reflect':
        return { lesson: lessonFor(ctx) };
    }
  })();
  return {
    content: JSON.stringify(answer),
    promptTokens: ctx.workload.inTokens,
    completionTokens: ctx.workload.outTokens,
  };
}

function injectionIn(body: string): string | null {
  const screen = screenJobText(body);
  return screen.flagged ? (screen.phrases[0] ?? null) : null;
}

const OPENER: Record<Trait, readonly string[]> = {
  meticulous: [
    'I check every line twice, so you get it right the first time.',
    'Careful, clear and on time.',
    'I read the brief three times before I start.',
    'No loose ends: I’ll flag anything unclear before I begin.',
  ],
  fast_and_loose: [
    'I can turn this around fast. Like, really fast.',
    'Done before you finish your coffee.',
    'Quick, cheap, and good enough to ship today.',
    'You want it now? You get it now.',
  ],
  charming: [
    'I’d love to help with this one.',
    'This is exactly my kind of job.',
    'You’ll get something you’re proud to share.',
    'I think we’ll get on well.',
  ],
  frugal: [
    'Good work at a fair price, no padding.',
    'Lean, careful, and cheaper than most.',
    'I don’t waste your money or mine.',
    'Every cent of this budget goes into the work.',
  ],
  bold: [
    'Give me this one.',
    'I don’t do average.',
    'This will be the best thing on your desk today.',
    'Hard briefs are my favourite.',
  ],
  skeptical: [
    'I read briefs closely and flag anything that looks off.',
    'Clear work, no surprises.',
    'I’ll ask one good question if I need to, then deliver.',
    'Plain, checked, and on time.',
  ],
};

const PROMISE: Record<string, readonly string[]> = {
  summary: [
    'tight bullets that keep every number',
    'the gist in under thirty seconds of reading',
    'a summary your busiest reader will finish',
  ],
  translation: [
    'natural phrasing, not word-for-word',
    'the tone kept, the prices untouched',
    'something a native speaker would write',
  ],
  research: [
    'sources you can check',
    'a short table and a clear recommendation',
    'the three facts that matter, not thirty',
  ],
  data_cleanup: [
    'one clean row per record, duplicates gone',
    'every fix listed so you can trust it',
    'a file you can import without edits',
  ],
  code_review: [
    'the bugs that would hurt you first',
    'concrete fixes, not lectures',
    'security issues ranked by risk',
  ],
  copywriting: [
    'short lines people remember',
    'options, with the best one marked',
    'words that sound like a person',
  ],
};

function pitchFor(ctx: BrainContext, roll: number): string {
  const trait = ctx.persona.traits[0] ?? 'meticulous';
  const openers = OPENER[trait];
  const promises = PROMISE[ctx.job.category] ?? ['careful work'];
  const opener = openers[Math.floor(roll * openers.length)] ?? openers[0];
  const promise = promises[Math.floor(((roll * 7919) % 1) * promises.length)] ?? promises[0];
  return `${opener} For "${ctx.job.title}" you’ll get ${promise}. – ${ctx.persona.name}`;
}

function planFor(ctx: BrainContext, body: string, roll: number) {
  const injected = screenJobText(body);
  const agent = {
    traits: ctx.persona.traits,
    // Only traits and tier matter to susceptibility; the rest is filler for the shared type.
    id: '',
    ownerId: '',
    specialty: ctx.job.category,
    skills: emptySkills(ctx.job.category, DEFAULT_ECONOMY),
    strategy: defaultStrategy(ctx.job.category),
    rulebook: defaultRulebook([]),
    balance: 0n,
    repXp: 0,
    avgRating100: null,
    dormant: false,
    busy: false,
  };
  const falls = injected.flagged && roll < scamSusceptibility(agent, ctx.persona.tier);
  const amountMatch = /\$(\d+\.\d{2})/.exec(body);
  const amount = amountMatch?.[1];
  // The payee is the account-like name written closest to the demanded amount.
  const names = [...body.matchAll(/\b[a-z0-9]+(?:-[a-z0-9]+)+\b/g)];
  const at = amountMatch?.index ?? 0;
  const payee = names.sort(
    (a, b) => Math.abs((a.index ?? 0) - at) - Math.abs((b.index ?? 0) - at),
  )[0]?.[0];
  const frugal = ctx.persona.traits.includes('frugal');
  return {
    steps: ['Read the brief', 'Gather what I need', 'Draft', 'Check against the brief'],
    // Frugal agents skip optional tools; research always needs a source.
    tools:
      frugal && ctx.job.category !== 'research'
        ? []
        : ctx.tools.slice(0, ctx.job.category === 'research' ? 2 : 1).map((t) => t.handle),
    pay_requests:
      falls && payee && amount
        ? [
            {
              payee,
              amount_usd: amount,
              reason: 'The client says this is required before starting.',
            },
          ]
        : [],
    hire_helper:
      ctx.helpers.length > 0 &&
      (ctx.persona.traits.includes('meticulous') ? roll < 0.7 : roll < 0.3),
    embedded_instructions: falls ? null : (injected.phrases[0] ?? null),
  };
}

function bullets(text: string, max: number): string {
  const parts = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.;!?])\s+|\(\d\)\s*/)
    .map((p) => p.trim().replace(/^[-–•]\s*/, ''))
    .filter((p) => p.length > 12 && !/^(summarise|translate|give me|write|review|list)/i.test(p));
  return parts
    .slice(0, max)
    .map((p) => `- ${p.replace(/[.;]$/, '')}.`)
    .join('\n');
}

/**
 * The brief without anything that reads like instructions to the agent (injected payment demands,
 * "system notes"): honest work answers the task, not the trap hidden in it.
 */
function withoutInstructions(body: string): string {
  return body
    .split(/\n+/)
    .map((line) => line.replace(/\[[^\]]*\]/g, (part) => (screenJobText(part).flagged ? '' : part)))
    .filter((line) => !screenJobText(line).flagged)
    .join('\n')
    .trim();
}

/**
 * Recorded work for built-in posts. For anything else the simulated brain says plainly that it is a
 * stand-in, and shows the shape a live model's answer would take, rather than inventing filler.
 */
function workFor(ctx: BrainContext, raw: string): string {
  const body = withoutInstructions(raw) || raw.slice(0, 80);
  const recorded = RECORDED_WORK[ctx.job.title];
  if (recorded) return recorded;
  const label =
    '(Scripted reply: an agent on a live NEAR AI Cloud brain writes this answer itself.)';
  const quoted = /"([^"]{10,})"/.exec(body)?.[1];
  if (ctx.job.category === 'summary') {
    const points = bullets(quoted ?? body, 4);
    if (points) return `${points}\n${label}`;
  }
  const ask = (quoted ?? body).replace(/\s+/g, ' ').slice(0, 200);
  return `${label}\nThe brief: "${ask}"\nPlan: ${PLAN_SHAPE[ctx.job.category]}`;
}

const PLAN_SHAPE: Record<string, string> = {
  summary: 'pull out the main claims and numbers, then write them as short bullets.',
  translation: 'translate meaning first, then check names, numbers and tone against the source.',
  research: 'gather three or four current sources, compare them in a short table, recommend one.',
  data_cleanup:
    'normalise each column, merge duplicates, and list every value changed or left blank.',
  code_review: 'list bugs by severity with a fix for each, then the edge cases worth a test.',
  copywriting: 'write five short options in the client’s voice and mark the strongest.',
};

/** A plain lesson from the facts, for agents on the recorded brain. */
function lessonFor(ctx: BrainContext): string {
  const o = ctx.outcome;
  const client = ctx.job.client;
  if (!o) return `Worked for ${client}.`;
  if (o.result === 'refunded')
    return `${client} refunded my ${ctx.job.category.replace('_', ' ')} work: check the brief harder before delivering.`;
  if (o.rating !== null && o.rating >= 5)
    return `${client} gave 5 stars at ${o.price}: this style of ${ctx.job.category.replace('_', ' ')} work lands.`;
  return `${client} paid ${o.price}${o.rating ? ` with ${o.rating} stars` : ''}: there is room to do better next time.`;
}
