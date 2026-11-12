import { WORK_STAGES, type WorkStage } from '@hustle/core/browser';

export const STAGE_LABEL: Record<WorkStage, string> = {
  plan: 'Planning',
  tools: 'Buying tools',
  helper: 'Hiring help',
  draft: 'Writing',
  deliver: 'Delivering',
  review: 'Client reviewing',
  settle: 'Getting paid',
};

/** The seven work stages as a row of steps, with the current one marked. */
export function StageTrack({ stage }: { stage: WorkStage | null }) {
  const at = stage ? WORK_STAGES.indexOf(stage) : -1;
  return (
    <ol className="flex gap-1" aria-label="Work stages">
      {WORK_STAGES.map((s, i) => {
        const state = i < at ? 'done' : i === at ? 'now' : 'todo';
        return (
          <li
            key={s}
            aria-current={state === 'now' ? 'step' : undefined}
            className="min-w-0 flex-1"
            title={STAGE_LABEL[s]}
          >
            <span
              className={`block h-2 rounded-full border border-line-strong ${state === 'done' ? 'bg-brand' : state === 'now' ? 'bg-coin' : 'bg-surface-2'}`}
            />
            <span className="sr-only">
              {STAGE_LABEL[s]}:{' '}
              {state === 'done' ? 'done' : state === 'now' ? 'in progress' : 'to do'}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
