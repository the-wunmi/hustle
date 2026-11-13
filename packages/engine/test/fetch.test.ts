import { describe, expect, it } from 'vitest';
import { checkUrl, isPublicAddress, siteOf, textOf } from '../src/tools/fetch.ts';
import { isPlainCommand } from '../src/world/loop.ts';

describe('the fetch tool only reaches the public internet', () => {
  it('refuses private, loopback, link-local, metadata and reserved addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1', // the same, as the URL parser writes it
      '::ffff:a9fe:a9fe', // 169.254.169.254
      '::7f00:1', // IPv4-compatible
      '64:ff9b::a9fe:a9fe', // NAT64
      '2002:7f00:1::', // 6to4
      '2001:0:4136:e378:8000:63bf:80ff:fffe', // Teredo, client 127.0.0.1
      '::',
      '::ffff:0:7f00:1', // IPv4-translated
      'fec0::1', // site-local
      '2001:db8::1', // documentation
      '64:ff9b:1::a9fe:a9fe', // local-use NAT64
    ])
      expect(isPublicAddress(ip), ip).toBe(false);
    for (const ip of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111'])
      expect(isPublicAddress(ip), ip).toBe(true);
  });

  it('refuses URLs that point inward, use odd ports or carry credentials', () => {
    for (const url of [
      'http://127.0.0.1/admin',
      'http://2130706433/', // 127.0.0.1 written as a number
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:a9fe:a9fe]/',
      'http://93.184.216.34/', // any address literal: host names only
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost:4300/api/health',
      'http://postgres.internal/',
      'https://example.com:5432/',
      'https://user:pass@example.com/',
      'file:///etc/passwd',
      'ftp://example.com/',
    ])
      expect(typeof checkUrl(url), url).toBe('string');
    expect(checkUrl('https://example.com/data.csv')).toBeInstanceOf(URL);
  });

  it('keeps the text of an HTML page, without scripts or styles', () => {
    const text = textOf(
      '<html><head><style>p{}</style><script>steal()</script></head><body><h1>Title</h1><p>Hello &amp; welcome</p></body></html>',
      'text/html',
    );
    expect(text).toContain('Title');
    expect(text).toContain('Hello & welcome');
    expect(text).not.toContain('steal');
  });

  it('turns hostile HTML into text in linear time', () => {
    for (const piece of ['<svg', '<style>', '<', '<script ']) {
      const started = performance.now();
      textOf(piece.repeat(1_000_000 / piece.length), 'text/html');
      expect(performance.now() - started, piece).toBeLessThan(1_000);
    }
    expect(textOf('a<script>x</script>b<style>y', 'text/html')).toBe('a b');
  });

  it('counts subdomains toward their site', () => {
    expect(siteOf('a.b.evil.com')).toBe('evil.com');
    expect(siteOf('news.bbc.co.uk')).toBe('bbc.co.uk');
    expect(siteOf('example.com')).toBe('example.com');
  });

  it('a command for the owner’s computer must be readable in full', () => {
    expect(isPlainCommand('npm install && npm test')).toBe(true);
    expect(isPlainCommand('echo hi\u202e')).toBe(false); // right-to-left override
    expect(isPlainCommand('a\u200bb')).toBe(false); // zero-width space
    expect(isPlainCommand('clear\u001b[2J')).toBe(false);
    expect(isPlainCommand(Array(21).fill('echo').join('\n'))).toBe(false);
    expect(isPlainCommand('x'.repeat(2_001))).toBe(false);
  });
});
