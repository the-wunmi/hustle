// Creates .env from .env.example on first setup and fills HUSTLE_SECRET with a random value, so the
// server secret lives in .env (never in the database next to the keys it seals).
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const envPath = new URL('../.env', import.meta.url);
const examplePath = new URL('../.env.example', import.meta.url);
let text = existsSync(envPath) ? readFileSync(envPath, 'utf8') : readFileSync(examplePath, 'utf8');
const hasValue = /^HUSTLE_SECRET=\S+/m.test(text);
if (!hasValue) {
  const line = `HUSTLE_SECRET=${randomBytes(32).toString('base64url')}`;
  text = /^HUSTLE_SECRET=/m.test(text)
    ? text.replace(/^HUSTLE_SECRET=.*$/m, line)
    : `${text.trimEnd()}\n${line}\n`;
}
writeFileSync(envPath, text);
console.log(hasValue ? '.env ready' : '.env ready (generated HUSTLE_SECRET)');
