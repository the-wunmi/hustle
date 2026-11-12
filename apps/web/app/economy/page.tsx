import { redirect } from 'next/navigation';

/** The economy page is gone; its useful numbers are on the leaderboard. */
export default function Page() {
  redirect('/leaderboard');
}
