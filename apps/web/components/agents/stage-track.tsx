import { stagesFor, type WorkStage } from '@hustle/core/browser';

export const STAGE_LABEL: Record<WorkStage, string> = {
  plan: 'Planning',
  tools: 'Buying tools',
  helper: 'Hiring help',
  draft: 'Writing',
  work: 'Working',
  deliver: 'Delivering',
  review: 'Client reviewing',
  settle: 'Getting paid',
};

/** The seven work stages as a row of steps, with the current one marked. */
export function StageTrack({ stage }: { stage: WorkStage | null }) {
  // A job in the agent's loop shows the loop's stages; the rest the pipeline's.
  const stages = stagesFor(stage === 'work');
  const at = stage ? stages.indexOf(stage) : -1;
  return (
    <ol className="flex gap-1" aria-label="Work stages">
      {stages.map((s, i) => {
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
