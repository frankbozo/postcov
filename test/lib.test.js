import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

import {
  safeEqual, adminToken, readVoter, issueVoter, rateLimit, _resetRateLimits,
  clientIp, slugify, postId, isBlackMarked, hotScore, needsReview,
  escapeHtml, safeSourceUrl, clamp, REALITY_THRESHOLD, BLACK_MARK_MIN_VOTES,
} from '../src/lib.js';

/* ---------------- identity ---------------- */

test('safeEqual matches identical strings and rejects everything else', () => {
  assert.equal(safeEqual('hunter2', 'hunter2'), true);
  assert.equal(safeEqual('hunter2', 'hunter3'), false);
  assert.equal(safeEqual('short', 'muchlonger'), false, 'length mismatch must not throw');
  assert.equal(safeEqual('', ''), true);
  assert.equal(safeEqual(undefined, ''), true, 'nullish coerces to empty, not a crash');
  assert.equal(safeEqual('x', undefined), false);
});

test('adminToken is derived, stable, and never the key itself', () => {
  const key = 'a-real-admin-key';
  const t = adminToken(key);
  assert.equal(t, adminToken(key), 'same key must give the same token');
  assert.notEqual(t, key, 'the raw key must never be what lands in the cookie');
  assert.notEqual(t, adminToken('a-real-admin-kex'));
  assert.ok(t.length > 20);
});

// A minimal stand-in for the express req/res pair the cookie helpers touch.
const fakeRes = () => {
  const jar = {};
  return { jar, cookie: (name, value) => { jar[name] = value; } };
};

test('a voter cookie round-trips', () => {
  const res = fakeRes();
  const id = issueVoter(res);
  assert.equal(readVoter({ cookies: { voter: res.jar.voter } }), id);
});

test('a forged or tampered voter cookie is rejected', () => {
  const res = fakeRes();
  issueVoter(res);
  const [id, sig] = res.jar.voter.split('.');

  assert.equal(readVoter({ cookies: {} }), null, 'no cookie');
  assert.equal(readVoter({ cookies: { voter: id } }), null, 'no signature');
  assert.equal(readVoter({ cookies: { voter: `${id}.` } }), null, 'empty signature');
  assert.equal(readVoter({ cookies: { voter: `${id}.deadbeef` } }), null, 'wrong signature');
  assert.equal(
    readVoter({ cookies: { voter: `${crypto.randomUUID()}.${sig}` } }), null,
    'a real signature lifted onto a different id',
  );
});

test('the app refuses to boot in production without SESSION_SECRET', () => {
  const run = (env) => {
    try {
      execFileSync(process.execPath, ['-e', "import('./src/lib.js')"], {
        env: { ...process.env, SESSION_SECRET: '', ...env },
        stdio: 'pipe',
        encoding: 'utf8',
      });
      return null;
    } catch (e) {
      return String(e.stderr || '');
    }
  };

  const err = run({ NODE_ENV: 'production' });
  assert.ok(err, 'production with no secret must fail, not fall back');
  assert.match(err, /SESSION_SECRET/);

  assert.equal(run({ NODE_ENV: 'development' }), null, 'dev still boots with no setup');
});

/* ---------------- rate limiting ---------------- */

test('rateLimit lets the first N through and then refuses', () => {
  _resetRateLimits();
  const opts = { key: 'k', limit: 3, windowMs: 60_000 };
  assert.equal(rateLimit(opts).ok, true);
  assert.equal(rateLimit(opts).ok, true);
  assert.equal(rateLimit(opts).ok, true);
  const blocked = rateLimit(opts);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfter > 0);
});

test('rateLimit buckets are independent per key', () => {
  _resetRateLimits();
  assert.equal(rateLimit({ key: 'a', limit: 1, windowMs: 60_000 }).ok, true);
  assert.equal(rateLimit({ key: 'a', limit: 1, windowMs: 60_000 }).ok, false);
  assert.equal(rateLimit({ key: 'b', limit: 1, windowMs: 60_000 }).ok, true);
});

test('rateLimit reopens once the window has passed', () => {
  _resetRateLimits();
  const opts = { key: 'w', limit: 1, windowMs: 1 };
  assert.equal(rateLimit(opts).ok, true);
  assert.equal(rateLimit(opts).ok, false);
  const later = Date.now() + 50;
  while (Date.now() < later); // busy-wait: shorter than any sane test timeout
  assert.equal(rateLimit(opts).ok, true);
});

// The regression this guards: clientIp used to read the leftmost
// X-Forwarded-For entry, which the client writes. A fresh value per request
// bought a fresh bucket and made every limit in the app decorative.
test('clientIp ignores a client-supplied X-Forwarded-For', () => {
  const req = {
    ip: '203.0.113.9', // what express resolved via `trust proxy`
    headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' },
    socket: { remoteAddress: '10.0.0.1' },
  };
  assert.equal(clientIp(req), '203.0.113.9');

  const spoofed = { ...req, headers: { 'x-forwarded-for': `${Math.random()}` } };
  assert.equal(clientIp(spoofed), clientIp(req), 'the header must not move the bucket');
});

test('clientIp falls back when express gives nothing', () => {
  assert.equal(clientIp({ socket: { remoteAddress: '10.0.0.1' } }), '10.0.0.1');
  assert.equal(clientIp({}), 'unknown');
});

/* ---------------- identifiers ---------------- */

test('postId accepts real ids and rejects everything else', () => {
  assert.equal(postId('1'), '1');
  assert.equal(postId(42), '42');
  assert.equal(postId('9223372036854775807'), '9223372036854775807');

  for (const bad of [
    'abc', '1; DROP TABLE posts', '1.5', '-1', '', null, undefined,
    ' 1', '1 ', '0x10', '1e3', '9223372036854775808', '99999999999999999999',
  ]) {
    assert.equal(postId(bad), null, `${JSON.stringify(bad)} must not reach Postgres`);
  }
});

/* ---------------- scoring ---------------- */

test('a post below the vote floor is never black-marked', () => {
  assert.equal(isBlackMarked({ ups: 0, downs: BLACK_MARK_MIN_VOTES - 1 }), false);
  assert.equal(isBlackMarked({ ups: 0, downs: 0 }), false);
});

test('black mark fires above the floor and the ratio', () => {
  assert.equal(isBlackMarked({ ups: 2, downs: 8 }), true);
  assert.equal(isBlackMarked({ ups: 9, downs: 1 }), false);
  assert.equal(isBlackMarked({ ups: 7, downs: 3 }), false, 'exactly at the ratio is not over it');
});

test('hotScore prefers the newer of two equally-voted posts', () => {
  const older = { ups: 5, downs: 0, created_at: '2026-01-01T00:00:00Z' };
  const newer = { ups: 5, downs: 0, created_at: '2026-06-01T00:00:00Z' };
  assert.ok(hotScore(newer) > hotScore(older));
});

test('hotScore prefers the better-voted of two same-age posts', () => {
  const at = '2026-01-01T00:00:00Z';
  assert.ok(hotScore({ ups: 50, downs: 0, created_at: at }) > hotScore({ ups: 1, downs: 0, created_at: at }));
  assert.ok(hotScore({ ups: 1, downs: 0, created_at: at }) > hotScore({ ups: 0, downs: 9, created_at: at }));
});

/* ---------------- screening ---------------- */

test('needsReview catches threats and leaked identifiers', () => {
  assert.equal(needsReview('kill all the lawyers'), true);
  assert.equal(needsReview('death to parking meters'), true);
  assert.equal(needsReview('his ssn is 123-45-6789'), true);
  assert.equal(needsReview('card 4111 1111 1111 1111'), true);
});

test('needsReview leaves ordinary satire alone', () => {
  assert.equal(needsReview('The Department of Interior will be renamed.'), false);
  assert.equal(needsReview('A bill to make Tuesday illegal, effective 2026.'), false);
  assert.equal(needsReview(''), false);
});

/* ---------------- misc ---------------- */

test('escapeHtml neutralises every character that can break out of markup', () => {
  assert.equal(escapeHtml('<script>alert("x")</script>'),
    '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  assert.equal(escapeHtml("it's"), 'it&#39;s');
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
  assert.equal(escapeHtml(''), '');
  assert.equal(escapeHtml(undefined), '');
});

test('safeSourceUrl admits only http and https', () => {
  assert.equal(safeSourceUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(safeSourceUrl('http://example.com/'), 'http://example.com/');
  for (const bad of [
    'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd', 'not a url', '', 'vbscript:msgbox(1)',
  ]) {
    assert.equal(safeSourceUrl(bad), null, `${bad} must be refused`);
  }
});

test('slugify produces a url-safe, collision-resistant slug', () => {
  const s = slugify('The Department of Everything: Phase II!');
  assert.match(s, /^[a-z0-9-]+$/);
  assert.ok(s.startsWith('the-department-of-everything-phase-ii-'));
  assert.notEqual(slugify('same headline'), slugify('same headline'), 'suffix must vary');
  assert.match(slugify('!!!'), /^post-[0-9a-f]{6}$/, 'punctuation-only still yields a slug');
  assert.ok(slugify('x'.repeat(200)).length < 80);
});

test('clamp holds a value inside its bounds', () => {
  assert.equal(clamp(50, 0, 100), 50);
  assert.equal(clamp(-5, 0, 100), 0);
  assert.equal(clamp(500, 0, 100), 100);
});

test('the reality threshold is what the copy on the site promises', () => {
  assert.equal(REALITY_THRESHOLD, 3);
});
