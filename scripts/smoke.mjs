// Checks a deployed Hustle after a deploy, read-only: it signs nobody in, mints nothing and posts
// nothing, so a check never leaves a player or an agent in the public world. Usage:
//   node scripts/smoke.mjs https://hustle.example.com
const base = (process.argv[2] ?? '').replace(/\/$/, '');
if (!/^https?:\/\//.test(base)) {
  console.error('Usage: node scripts/smoke.mjs <site URL>');
  process.exit(2);
}

const failures = [];
async function check(label, path, test) {
  try {
    const res = await fetch(`${base}${path}`, { method: 'GET', redirect: 'manual' });
    const body = res.headers.get('content-type')?.includes('json')
      ? await res.json()
      : await res.text();
    const problem = res.ok ? test?.(body) : `HTTP ${res.status}`;
    console.log(`${problem ? 'FAIL' : 'ok  '} ${label}${problem ? `: ${problem}` : ''}`);
    if (problem) failures.push(label);
  } catch (err) {
    console.log(`FAIL ${label}: ${err.message}`);
    failures.push(label);
  }
}

await check('health', '/api/health', (b) =>
  b.ok !== true ? 'not ok' : b.recovering ? 'still recovering' : null,
);
await check('world', '/api/world', (b) => (b.stats ? null : 'no stats'));
await check('agents', '/api/agents', (b) => (Array.isArray(b) && b.length > 0 ? null : 'empty'));
await check('leaderboard', '/api/leaderboard', (b) => (b.entries?.length ? null : 'empty'));
// On a public https site the on-screen-code sign-in must be off, or anyone could make test players.
await check('sign-in config', '/api/auth/config', (b) =>
  base.startsWith('https://') && b.mock ? 'the stand-in sign-in is on' : null,
);
for (const page of ['/', '/jobs', '/agents', '/leaderboard', '/how-it-works'])
  await check(`page ${page}`, page, (html) => (html.includes('<html') ? null : 'not a page'));

if (failures.length) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('All checks passed');
