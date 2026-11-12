import { redirect } from 'next/navigation';

/** Under the hood became the shorter How it works page; old links land on it. */
export default function Page() {
  redirect('/how-it-works');
}
