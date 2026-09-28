import crypto from 'node:crypto';

/* ------------------------------------------------------------------ *
 * Identity: a signed, httpOnly voter cookie.
 * Not bulletproof — nothing cookie-based is — but it stops the casual
 * refresh-and-vote-again, and it can't be forged without SESSION_SECRET.
 * ------------------------------------------------------------------ */

// A missing secret used to fall back to a fixed string that ships in this
// repo, which would make every voter cookie forgeable by anyone who can
// read it. In production that is a hole, not a convenience: refuse to boot.
// Outside production the fallback stays, so `npm run dev` needs no setup.
const DEV_SECRET = 'dev-only-insecure-secret';

function resolveSecret() {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv) return fromEnv;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'SESSION_SECRET is not set. Voter cookies would be signed with a public '
      + 'fallback secret and could be forged by anyone. Generate one with:\n'
      + '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  return DEV_SECRET;
}

const SECRET = resolveSecret();

const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url').slice(0, 24);

/**
 * Compare two strings without leaking their contents through timing.
 * Length is compared first and not disguised — only the bytes are secret.
 */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

export function readVoter(req) {
  const raw = req.cookies?.voter;
  if (!raw) return null;
  const [id, sig] = raw.split('.');
  if (!id || !sig || !safeEqual(sign(id), sig)) return null;
  return id;
}

export function issueVoter(res) {
  const id = crypto.randomUUID();
  res.cookie('voter', `${id}.${sign(id)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 365 * 24 * 60 * 60 * 1000,
  });
  return id;
}

export function voterOf(req, res) {
  return readVoter(req) || issueVoter(res);
}

/**
 * Derive the admin session cookie value from the admin key.
 *
 * The cookie used to be the admin key itself, which handed the live
 * credential to the browser on every request. An HMAC of it is just as
 * cheap to check and is useless if it leaks out of the cookie jar:
 * it cannot be replayed as the key against anything else.
 */
export const adminToken = (key) =>
  crypto.createHmac('sha256', SECRET).update(`admin:${key}`).digest('base64url');

/* ------------------------------------------------------------------ *
 * Rate limiting: in-memory token buckets, keyed by IP.
 * Single-instance only. If you ever scale past one dyno, move this to
 * the database or Redis — until then this is the right amount of code.
 * ------------------------------------------------------------------ */

const buckets = new Map();

export function rateLimit({ key, limit, windowMs }) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.reset) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return { ok: true, remaining: limit - 1 };
  }
  if (b.count >= limit) {
    return { ok: false, retryAfter: Math.ceil((b.reset - now) / 1000) };
  }
  b.count += 1;
  return { ok: true, remaining: limit - b.count };
}

// Keep the map from growing without bound.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
}, 60_000).unref?.();

// Exposed for tests, which need a clean slate between cases.
export const _resetRateLimits = () => buckets.clear();

/**
 * The address to rate-limit against.
 *
 * This used to read the leftmost X-Forwarded-For entry, which is the one
 * value in the chain the client controls: sending a fresh
 * `X-Forwarded-For: <anything>` per request bought a fresh bucket every
 * time and defeated every limit in the app. Express already resolves this
 * correctly from `trust proxy`, counting hops from the right, so the
 * spoofed prefix is skipped. Fall back only when there is no req.ip at all.
 */
export const clientIp = (req) => req.ip || req.socket?.remoteAddress || 'unknown';

/* ------------------------------------------------------------------ *
 * Slugs
 * ------------------------------------------------------------------ */

export function slugify(text) {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60)
    .replace(/-+$/, '');
  return `${base || 'post'}-${crypto.randomBytes(3).toString('hex')}`;
}

/* ------------------------------------------------------------------ *
 * Identifiers
 * ------------------------------------------------------------------ */

/**
 * Postgres BIGINT ids arrive as path segments. Anything non-numeric makes
 * the driver throw `invalid input syntax for type bigint`, which the error
 * handler turns into a 500 — a bad request reported as a server fault, and
 * a stack trace in the logs for every bot that probes /api/posts/foo/vote.
 * Screen them here and let the caller answer 404 instead.
 */
export function postId(raw) {
  const s = String(raw ?? '');
  if (!/^[0-9]{1,19}$/.test(s)) return null;
  // Beyond 2^63-1 the column cannot hold it, so it is not a real id either.
  return BigInt(s) <= 9223372036854775807n ? s : null;
}

/* ------------------------------------------------------------------ *
 * Scoring
 * ------------------------------------------------------------------ */

// Black mark needs a floor. Without one, a brand-new post with two
// downvotes gets marked and dies before anyone sees it.
export const BLACK_MARK_MIN_VOTES = 10;
export const BLACK_MARK_RATIO = 0.35;

export function isBlackMarked({ ups, downs }) {
  const total = ups + downs;
  if (total < BLACK_MARK_MIN_VOTES) return false;
  return downs / total > BLACK_MARK_RATIO;
}

// Reddit-style hot ranking: recency decays, magnitude is logarithmic.
export function hotScore({ ups, downs, created_at }) {
  const net = ups - downs;
  const order = Math.log10(Math.max(Math.abs(net), 1));
  const sign = net > 0 ? 1 : net < 0 ? -1 : 0;
  const seconds = new Date(created_at).getTime() / 1000 - 1700000000;
  return Number((sign * order + seconds / 45000).toFixed(7));
}

// How many independent people must flag a proposal before it's declared
// overtaken by reality. Low enough to happen, high enough to mean something.
export const REALITY_THRESHOLD = 3;

/* ------------------------------------------------------------------ *
 * Content screening
 *
 * This is a tripwire, not a censor: a hit routes the submission into the
 * moderation queue instead of rejecting it, so a human decides. Slurs and
 * violent-threat patterns are the only things it looks for — political
 * opinion, profanity and bad jokes are not its business.
 * ------------------------------------------------------------------ */

const TRIPWIRES = [
  /\bk[i1]ll\s+(all|every)\b/i,
  /\b(gas|lynch|hang|shoot|behead)\s+(the|all|every)\b/i,
  /\bdeath\s+to\s+\w+/i,
  /\b\d{3}-\d{2}-\d{4}\b/, // anything shaped like an SSN
  /\b(?:\d[ -]*?){13,16}\b/, // anything shaped like a card number
];

export function needsReview(text) {
  return TRIPWIRES.some((re) => re.test(text));
}

/* ------------------------------------------------------------------ *
 * Misc
 * ------------------------------------------------------------------ */

export const escapeHtml = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);

export function safeSourceUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
