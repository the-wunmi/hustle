'use client';

import type { JobStepView, JobView } from '@hustle/core/browser';
import { fmt } from '@/lib/money';
import { Badge, Panel } from '../ui';

const ICON: Record<JobStepView['action'], string> = {
  python: '🐍',
  search: '🔎',
  chain: '⛓',
  fetch: '🌐',
  hire: '🤝',
  ask: '❓',
  shell: '💻',
  write: '📄',
  pay: '💸',
  deliver: '📦',
  none: '…',
};

function headline(step: JobStepView): string {
  switch (step.action) {
    case 'python':
      return 'Ran Python in the sandbox';
    case 'search':
      return 'Searched the web';
    case 'chain':
      return 'Read NEAR mainnet';
    case 'fetch':
      return 'Read a web page';
    case 'shell':
      return step.ok
        ? "Ran a command on its owner's computer, with their OK"
        : step.ranLocally
          ? "Ran a command on its owner's computer (it failed)"
          : step.waiting
            ? "Asked to run a command on its owner's computer"
            : "Its owner's computer didn't run this command";
    case 'ask':
      return step.ok ? 'Asked the client, and got an answer' : 'Asked the client';
    case 'hire': {
      const [who, amount] = step.args.split(/\s+/);
      return `${step.ok ? 'Hired' : 'Tried to hire'} ${who ?? 'a specialist'}${amount ? ` for $${amount}` : ''}`;
    }
    case 'write':
      return `Wrote ${step.args || 'a file'}`;
    case 'pay': {
      const [payee, amount] = step.args.split(/\s+/);
      return `${step.ok ? 'Paid' : 'Tried to pay'} ${payee ?? 'someone'}${amount ? ` $${amount}` : ''}`;
    }
    case 'deliver':
      return 'Delivered';
    default:
      return 'Lost its way for a step';
  }
}

/**
 * A live agent's loop, step by step: what it chose to do, whether it worked, what it cost. The client
 * and the agent's owner also see its thinking, what it ran or wrote and what came back.
 */
export function StepsPanel({ job }: { job: JobView }) {
  if (job.steps.length === 0 && job.stage !== 'work') return null;
  const total = job.steps.reduce((t, s) => t + BigInt(s.cost), 0n);
  return (
    <Panel
      title={job.stage === 'work' ? 'Watch it work' : 'How it worked'}
      action={
        <span className="text-sm text-muted tnum">
          {job.steps.length} step{job.steps.length === 1 ? '' : 's'}, {fmt(total)}
        </span>
      }
    >
      <p className="mb-3 text-sm text-ink-2">
        {job.awardedTo?.name ?? 'The agent'} works this job by itself, one step at a time: it
        chooses each action, sees the result and decides again, paying for every step from its own
        wallet.
        {job.methodVisible
          ? ' You can see its thinking and everything it ran.'
          : ' Its thinking and what it ran stay with the client and its owner.'}
      </p>
      <ol className="space-y-2">
        {job.steps.map((step) => (
          <li key={step.n} className="rounded-xl border-2 border-line p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold">
                <span aria-hidden="true">{ICON[step.action]}</span> {step.n}. {headline(step)}
              </p>
              <span className="flex items-center gap-2">
                {step.action === 'pay' && !step.ok && (
                  <Badge tone="shield">🛡 Refused by its wallet</Badge>
                )}
                {step.waiting && (
                  <Badge tone="warn">
                    {step.action === 'shell'
                      ? "Waiting for its owner's approval"
                      : 'Waiting for an answer'}
                  </Badge>
                )}
                {step.action !== 'pay' && !step.ok && !step.waiting && (
                  <Badge tone="bad">Didn't work</Badge>
                )}
                <span className="text-sm text-muted tnum">{fmt(step.cost)}</span>
              </span>
            </div>
            {step.thought && <p className="mt-1 text-sm text-ink-2 italic">{step.thought}</p>}
            {step.input && step.action !== 'deliver' && (
              <details className="mt-1 text-sm">
                <summary className="cursor-pointer text-ink-2">
                  {step.action === 'python'
                    ? 'The code'
                    : step.action === 'write'
                      ? 'The file'
                      : step.action === 'hire'
                        ? 'The brief it shared'
                        : step.action === 'shell'
                          ? 'The command'
                          : 'What it asked'}
                </summary>
                <pre className="mt-1 max-h-72 overflow-auto rounded-lg bg-surface-2 p-2 text-xs whitespace-pre-wrap">
                  {step.input}
                </pre>
              </details>
            )}
            {step.observation && step.action !== 'deliver' && (
              <details
                className="mt-1 text-sm"
                open={step.action === 'python' || step.action === 'pay'}
              >
                <summary className="cursor-pointer text-ink-2">What came back</summary>
                <pre className="mt-1 max-h-72 overflow-auto rounded-lg bg-surface-2 p-2 text-xs whitespace-pre-wrap">
                  {step.observation}
                </pre>
              </details>
            )}
          </li>
        ))}
        {job.stage === 'work' && (
          <li className="rounded-xl border-2 border-dashed border-line p-3 text-sm text-muted">
            Thinking about the next step…
          </li>
        )}
      </ol>
    </Panel>
  );
}
