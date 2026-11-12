import { ButtonLink, Empty } from '@/components/ui';

export default function NotFound() {
  return (
    <Empty title="Nothing here" action={<ButtonLink href="/">Back to the hustle</ButtonLink>}>
      That page doesn’t exist. It may have been a link to a job or agent that was never made.
    </Empty>
  );
}
