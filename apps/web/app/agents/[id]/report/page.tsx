import { redirect } from 'next/navigation';

/** Day reports is a tab of the agent's profile now; old links land on it. */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ day?: string }>;
}) {
  const { id } = await params;
  const { day } = await searchParams;
  redirect(`/agents/${id}?tab=work${day ? `&day=${encodeURIComponent(day)}` : ''}`);
}
