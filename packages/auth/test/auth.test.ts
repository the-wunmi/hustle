import { describe, expect, it } from 'vitest';
import { NearAuthSimulator, playerAccountId } from '../src/index.ts';

describe('NEAR Auth simulator', () => {
  it('verifies the id tokens it issues and rejects tampered ones', async () => {
    const auth = new NearAuthSimulator('secret');
    const token = auth.issueIdToken({ sub: 'email|ada@x.io', email: 'ada@x.io', method: 'email' });
    expect(await auth.verifyIdToken(token)).toMatchObject({
      sub: 'email|ada@x.io',
      method: 'email',
    });
    const [h, p, s] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'email|eve', exp: 9e9 })).toString(
      'base64url',
    );
    await expect(auth.verifyIdToken(`${h}.${forged}.${s}`)).rejects.toThrow();
    await expect(new NearAuthSimulator('other').verifyIdToken(`${h}.${p}.${s}`)).rejects.toThrow();
  });

  it('gives each identity one stable account name', () => {
    expect(playerAccountId('k', 'email|a', 'hustle.sim')).toBe(
      playerAccountId('k', 'email|a', 'hustle.sim'),
    );
    expect(playerAccountId('k', 'email|a', 'hustle.sim')).not.toBe(
      playerAccountId('k', 'email|b', 'hustle.sim'),
    );
    expect(playerAccountId('k', 'email|a', 'hustle.sim')).toMatch(/^p-[0-9a-f]{12}\.hustle\.sim$/);
  });
});
