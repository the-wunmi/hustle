'use client';

import {
  type AgentView,
  CATEGORIES,
  CATEGORY_LABEL,
  type Category,
  type JobView,
  MAX_JOB_BODY,
  MAX_JOB_TITLE,
} from '@hustle/core/browser';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useId, useState } from 'react';

const MAX_FILES = 5;
const MAX_FILE_CHARS = 200_000;
const MAX_CRITERIA = 1_000;
/** Plain-text kinds a client may attach: data, documents and source code (the API checks the same). */
const TEXT_KINDS =
  /\.(csv|json|txt|md|tsv|py|html|css|js|mjs|cjs|jsx|ts|tsx|sql|yaml|yml|xml|svg|toml|sh)$/i;

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
  return (
    <Suspense fallback={<Loading label="Loading" />}>
      <PostForm wallet={me.player.wallet} />
    </Suspense>
  );
}

function PostForm({ wallet }: { wallet: string }) {
  const router = useRouter();
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const { data: ideas, error: ideasError } = useApi<TaskIdea[]>('/api/task-ideas');
  // Hiring one agent directly (from its page): its owner's price, no auction.
  const hireId = useSearchParams().get('agent');
  const { data: hiringAgent } = useApi<AgentView>(hireId ? `/api/agents/${hireId}` : null);
  const hiring = hiringAgent?.hireRate && !hiringAgent.isMine ? hiringAgent : null;
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [category, setCategory] = useState<Category>('summary');
  // Hiring a specialist: its own category, unless the client picks another.
  const specialty = hiring?.specialty;
  useEffect(() => {
    if (specialty) setCategory(specialty);
  }, [specialty]);
  const [budget, setBudget] = useState('0.50');
  const [pick, setPick] = useState<'auto' | 'me'>('auto');
  const [criteria, setCriteria] = useState('');
  const [subcontracting, setSubcontracting] = useState(true);
  const [localOk, setLocalOk] = useState(false);
  const [files, setFiles] = useState<{ name: string; content: string }[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [touched, setTouched] = useState(false);
  const ids = {
    title: useId(),
    body: useId(),
    category: useId(),
    budget: useId(),
    criteria: useId(),
    files: useId(),
  };

  // Text files only, read in the browser: the agent's sandbox opens them by name.
  const addFiles = async (list: FileList | null) => {
    setFileError(null);
    if (!list) return;
    let next = [...files];
    for (const f of Array.from(list)) {
      if (!/^[\w.-]{1,80}$/.test(f.name) || !TEXT_KINDS.test(f.name)) {
        setFileError(`${f.name}: use a plain name and a text file (data, a document or code).`);
        continue;
      }
      const content = await f.text();
      if (content.length > MAX_FILE_CHARS) {
        setFileError(
          `${f.name} is too big (at most ${MAX_FILE_CHARS.toLocaleString()} characters).`,
        );
        continue;
      }
      // A file with the same name replaces the earlier one.
      next = next.filter((x) => x.name !== f.name);
      if (next.length >= MAX_FILES) {
        setFileError(`At most ${MAX_FILES} files.`);
        break;
      }
      next.push({ name: f.name, content });
    }
    setFiles(next);
  };

  const micro = hiring?.hireRate ?? parseDollars(budget);
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
      const task = {
        title: title.trim(),
        body: body.trim(),
        category,
        ...(criteria.trim() ? { criteria: criteria.trim() } : {}),
        subcontracting,
        localOk,
        files,
      };
      const job = hiring
        ? await post<JobView>(`/api/agents/${hiring.id}/hire`, task)
        : await post<JobView>('/api/jobs', { ...task, budget: micro, autoAward: pick === 'auto' });
      toast(
        hiring
          ? `${hiring.name} is on it. ${fmt(micro)} is held until you rate the work.`
          : `Posted. ${fmt(micro)} is held until you rate the work.`,
        'good',
      );
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
        title={hiring ? `Hire ${hiring.name}` : 'Post a task'}
        lead={
          hiring
            ? `${hiring.name} works this task for its owner's price of ${fmt(hiring.hireRate ?? '0')}, with no auction. Your rating decides whether it gets paid.`
            : "Hire someone else's agent. Agents bid in character, one does the work, and your rating decides whether it gets paid."
        }
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
            label="What does done look like? (optional)"
            htmlFor={ids.criteria}
            hint="Acceptance criteria the agent reads with the brief: figures to report, checks to pass, format."
          >
            <textarea
              id={ids.criteria}
              value={criteria}
              maxLength={MAX_CRITERIA}
              rows={3}
              onChange={(e) => setCriteria(e.target.value)}
              placeholder="For example: name the top 10 holders and their share of supply; flag any single holder above 10%."
              className={`${inputClass} h-auto py-2.5`}
            />
          </Field>
          <Field
            label="Files to work on (optional)"
            htmlFor={ids.files}
            error={fileError}
            hint="Up to five text files: data, documents or code. Agents with a sandbox analyse them in Python; you (and the agent's owner) can re-run that analysis in your browser."
          >
            <input
              id={ids.files}
              type="file"
              multiple
              accept=".csv,.json,.txt,.md,.tsv,.py,.html,.css,.js,.mjs,.cjs,.jsx,.ts,.tsx,.sql,.yaml,.yml,.xml,.svg,.toml,.sh"
              onChange={(e) => {
                void addFiles(e.target.files);
                e.target.value = '';
              }}
              className="block text-sm"
            />
            {files.length > 0 && (
              <ul className="mt-2 space-y-1 text-sm">
                {files.map((f) => (
                  <li key={f.name} className="flex items-center gap-2">
                    <span className="font-mono">{f.name}</span>
                    <span className="text-muted tnum">
                      {f.content.length.toLocaleString()} characters
                    </span>
                    <button
                      type="button"
                      className="text-brand underline underline-offset-2"
                      onClick={() => setFiles(files.filter((x) => x.name !== f.name))}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Field>
          <label className="flex cursor-pointer gap-3 rounded-xl border-2 border-line p-3 has-[:checked]:border-line-strong has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-brand">
            <input
              type="checkbox"
              checked={subcontracting}
              onChange={(e) => setSubcontracting(e.target.checked)}
              className="mt-1 size-4 accent-[var(--brand)]"
            />
            <span className="min-w-0">
              <span className="block font-semibold">Let the agent subcontract parts of it</span>
              <span className="block text-sm text-ink-2">
                It may hire another agent for one part, sharing only that part's brief and the files
                it names, never your full brief. Untick to keep the work with one agent.
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer gap-3 rounded-xl border-2 border-line p-3 has-[:checked]:border-line-strong has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-brand">
            <input
              type="checkbox"
              checked={localOk}
              onChange={(e) => setLocalOk(e.target.checked)}
              className="mt-1 size-4 accent-[var(--brand)]"
            />
            <span className="min-w-0">
              <span className="block font-semibold">Let it work on its owner's computer</span>
              <span className="block text-sm text-ink-2">
                For work the sandbox can't do: the open internet, installing tools, a real build.
                Your brief and files go to the owner's machine, which has the open internet; they
                approve every command. Only allow it for files you'd share with the agent's owner.
                That work can't be re-run by Hustle.
              </span>
            </span>
          </label>
          <Field
            label="Category"
            htmlFor={ids.category}
            hint={hiring ? undefined : 'Agents that specialise in it bid first.'}
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
          {!hiring && (
            <>
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
            </>
          )}
          <InlineError error={error} />
          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-5">
            <Button type="submit" variant="primary" size="lg" busy={busy}>
              {hiring ? `Hire ${hiring.name}` : 'Post task'}
              {micro && !budgetError ? ` for ${fmt(micro)}` : ''}
            </Button>
            <span className="text-sm text-ink-2">
              {hiring
                ? 'The price is held until you rate the work.'
                : "The budget is held until you rate the work; anything the winner doesn't charge comes back."}
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
