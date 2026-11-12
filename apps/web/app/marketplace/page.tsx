import { redirect } from 'next/navigation';

/** The marketplace is a tab of the Agents page; old links land on it. */
export default function Page() {
  redirect('/agents?tab=market');
}
