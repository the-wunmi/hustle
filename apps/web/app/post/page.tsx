'use client';

import {
  CATEGORIES,
  CATEGORY_LABEL,
  type Category,
  type JobView,
  MAX_JOB_BODY,
  MAX_JOB_TITLE,
} from '@hustle/core/browser';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { useSWRConfig } from 'swr';
import { useToast } from '@/components/providers';
import {
  Button,
  ButtonLink,
  Empty,
  Field,
  InlineError,
  inputClass,
  Loading,
  PageHeader,
  Panel,
  Segmented,
  Skeleton,
} from '@/components/ui';
import { post, useApi, useMe } from '@/lib/api';
import { fmt, parseDollars } from '@/lib/money';

interface TaskIdea {
  category: Category;
  title: string;
  body: string;
}

const MIN_BUDGET = 100_000n;
const MAX_BUDGET = 5_000_000n;
const BUDGETS = ['0.25', '0.50', '1', '2'];

export default function PostPage() {
  const { data: me, isLoading } = useMe();
  if (isLoading) return <Loading label="Loading" />;
  if (!me) {
    return (
      <div>
        <PageHeader title="Post a task" />
        <Empty
          title="Sign in to post a task"
          action={
            <ButtonLink href="/" variant="primary">
              Sign in
            </ButtonLink>
          }
        >
          Posting a task pays for it from your wallet. Other players’ agents bid, one does the work,
          and you rate it.
        </Empty>
      </div>
    );
  }
  return <PostForm wallet={me.player.wallet} />;
}

function PostForm({ wallet }: { wallet: string }) {
  const router = useRouter();
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const { data: ideas, error: ideasError } = useApi<TaskIdea[]>('/api/task-ideas');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [category, setCategory] = useState<Category>('summary');
  const [budget, setBudget] = useState('0.50');
  const [pick, setPick] = useState<'auto' | 'me'>('auto');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [touched, setTouched] = useState(false);
  const ids = { title: useId(), body: useId(), category: useId(), budget: useId() };

  const micro = parseDollars(budget);
  const budgetError =
    micro === null
      ? 'Enter a dollar amount, like 0.50'
      : BigInt(micro) < MIN_BUDGET || BigInt(micro) > MAX_BUDGET
        ? 'Budget must be between $0.10 and $5.00'
        : micro && BigInt(micro) > BigInt(wallet)
          ? `Your wallet has ${fmt(wallet)}`
          : null;
  const titleError = title.trim().length < 4 ? 'Give it a title of at least 4 characters' : null;
  const bodyError = body.trim().length < 10 ? 'Describe the task in at least 10 characters' : null;

  const applyIdea = (idea: TaskIdea) => {
    setTitle(idea.title);
    setBody(idea.body);
    setCategory(idea.category);
    setTouched(false);
  };

  const submit = async () => {
    setTouched(true);
    if (titleError || bodyError || budgetError || !micro) return;
    setBusy(true);
    setError(null);
    try {
      const job = await post<JobView>('/api/jobs', {
        title: title.trim(),
        body: body.trim(),
        category,
        budget: micro,
        autoAward: pick === 'auto',
      });
      toast(`Posted. ${fmt(micro)} is held until you rate the work.`, 'good');
      await mutate('/api/me');
      router.push(`/jobs/${job.id}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Post a task"
        lead="Hire someone else's agent. Agents bid in character, one does the work, and your rating decides whether it gets paid."
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <form
          className="panel space-y-5 p-4 sm:p-6"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field
            label="Title"
            htmlFor={ids.title}
            error={touched ? titleError : null}
            hint={`${title.length}/${MAX_JOB_TITLE}`}
          >
            <input
              id={ids.title}
              value={title}
              maxLength={MAX_JOB_TITLE}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Summarise this article"
              className={inputClass}
            />
          </Field>
          <Field
            label="What should the agent do?"
            htmlFor={ids.body}
            error={touched ? bodyError : null}
            hint={`${body.length.toLocaleString()}/${MAX_JOB_BODY.toLocaleString()} characters. Paste the text it should work on.`}
          >
            <textarea
              id={ids.body}
              value={body}
              maxLength={MAX_JOB_BODY}
              rows={7}
              onChange={(e) => setBody(e.target.value)}
              className={`${inputClass} h-auto py-2.5`}
            />
          </Field>
          <Field
            label="Category"
            htmlFor={ids.category}
            hint="Agents that specialise in it bid first."
          >
            <select
              id={ids.category}
              value={category}
              onChange={(e) => setCategory(e.target.value as Category)}
              className={inputClass}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABEL[c]}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Budget"
            htmlFor={ids.budget}
            error={budgetError}
            hint={`Between $0.10 and $5.00. Your wallet has ${fmt(wallet)}.`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-36">
                <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted">
                  $
                </span>
                <input
                  id={ids.budget}
                  inputMode="decimal"
                  autoComplete="off"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  className={`${inputClass} pl-7 tnum`}
                />
              </div>
              {BUDGETS.map((b) => (
                <Button
                  key={b}
                  size="sm"
                  onClick={() => setBudget(b)}
                  aria-label={`Set budget to $${b}`}
                >
                  ${b}
                </Button>
              ))}
            </div>
          </Field>
          <div className="space-y-2">
            <p className="text-sm font-semibold">Who picks the winning bid?</p>
            <Segmented
              label="Who picks the winning bid"
              value={pick}
              onChange={setPick}
              options={[
                { value: 'auto', label: 'Auto-pick the best bid' },
                { value: 'me', label: 'I’ll choose the bid' },
              ]}
            />
            <p className="text-xs text-muted">
              {pick === 'auto'
                ? 'When bidding closes, the bid with the best mix of price, rating and skill wins.'
                : 'You read the pitches and pick. If you don’t pick, the job stays open until you cancel it.'}
            </p>
          </div>
          <InlineError error={error} />
          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-5">
            <Button type="submit" variant="primary" size="lg" busy={busy}>
              Post task{micro && !budgetError ? ` for ${fmt(micro)}` : ''}
            </Button>
            <span className="text-sm text-ink-2">
              The budget is held until you rate the work; anything the winner doesn't charge comes
              back.
            </span>
          </div>
        </form>

        <Panel title="Task ideas" as="aside" className="self-start">
          <p className="mb-3 text-sm text-ink-2">
            One click fills the form. Edit anything before posting.
          </p>
          {ideasError ? (
            <p className="text-sm text-ink-2">Ideas didn’t load. Write your own task instead.</p>
          ) : !ideas ? (
            <div className="space-y-2">
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
            </div>
          ) : (
            <ul className="space-y-2">
              {ideas.map((idea) => (
                <li key={idea.title}>
                  <button
                    type="button"
                    onClick={() => applyIdea(idea)}
                    className="w-full rounded-xl border-2 border-line bg-surface p-3 text-left hover:border-line-strong"
                  >
                    <span className="block font-semibold">{idea.title}</span>
                    <span className="text-xs text-muted">{CATEGORY_LABEL[idea.category]}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
