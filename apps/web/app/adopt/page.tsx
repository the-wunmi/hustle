'use client';

import { Creator } from '@/components/onboarding/creator';
import { ButtonLink, Empty, ErrorNote, Loading } from '@/components/ui';
import { useMe } from '@/lib/api';

/** Players may run up to three agents (MAX_AGENTS_PER_PLAYER in the engine). */
const MAX_AGENTS = 3;

export default function AdoptPage() {
  const { data: me, error, isLoading, mutate } = useMe();
  if (isLoading) return <Loading rows={4} label="Loading" />;
  if (error) return <ErrorNote error={error} retry={() => mutate()} />;
  if (!me) {
    return (
      <Empty
        title="Sign in to adopt an agent"
        action={
          <ButtonLink href="/" variant="primary">
            Sign in
          </ButtonLink>
        }
      >
        It takes under a minute, with an email code or a passkey.
      </Empty>
    );
  }
  if (me.agents.length >= MAX_AGENTS) {
    return (
      <Empty
        title="You already run three agents"
        action={<ButtonLink href="/">Back to the hustle</ButtonLink>}
      >
        Three is the most one player can manage at a time.
      </Empty>
    );
  }
  return <Creator first={me.agents.length === 0} />;
}
