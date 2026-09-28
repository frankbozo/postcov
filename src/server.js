import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { q, pool, migrate, autoSeed } from './db.js';
import {
  voterOf, readVoter, rateLimit, clientIp, slugify, hotScore, isBlackMarked,
  needsReview, safeSourceUrl, clamp, REALITY_THRESHOLD, postId, adminToken, safeEqual,
} from './lib.js';
import { shell } from './views.js';
import { notifySubmission, notifyStatus, notifySubscriber } from './notify.js';
import { loadSeed, insertRows } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());

// Baseline security headers. Hand-rolled rather than pulling in helmet: the
// set that matters for a server-rendered page with no inline script and no
// third-party frames is short, and a dependency here would be most of a
// megabyte to set six headers.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // Google Fonts is the only third-party origin the page touches. The
  // bootstrap payload rides in a JSON script tag, not inline JS, so
  // script-src needs no 'unsafe-inline'.
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      // No inline <script> anywhere and no on* attributes in the rendered
      // markup, so this needs no 'unsafe-inline' — which is the half of CSP
      // that actually stops an injected payload from running.
      "script-src 'self'",
      // 'unsafe-inline' here is for the handful of style="" attributes in
      // app.js, not a stylesheet. Drop it the day those move into
      // styles.css; until then it buys an attacker nothing that script-src
      // does not already deny.
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      // data: and blob: are the share-card canvas writing its own PNG.
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "object-src 'none'",
    ].join('; '),
  );
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

// Posts publish instantly. Anything the content screen trips on still
// waits for review. Set REVIEW_ALL=true to hold every submission instead.
const REQUIRE_APPROVAL = process.env.REVIEW_ALL === 'true';
const ORIGIN = (process.env.SITE_ORIGIN || '').replace(/\/$/, '');
const ADMIN_KEY = process.env.ADMIN_KEY || '';

/* ================================================================== *
 * Helpers
 * ================================================================== */

const plausibility = (p) => (p.plaus_n > 0 ? Math.round(p.plaus_sum / p.plaus_n) : null);

function shapePost(p, mine = {}) {
  return {
    id: String(p.id),
    slug: p.slug,
    headline: p.headline,
    body: p.body,
    author: p.author,
    desk: p.desk,
    ups: p.ups,
    downs: p.downs,
    net: p.ups - p.downs,
    commentCount: p.comment_count,
    realityCount: p.reality_count,
    overtaken: Boolean(p.overtaken_at),
    overtakenAt: p.overtaken_at,
    plausibility: plausibility(p),
    plausibilityVotes: p.plaus_n,
    blackMarked: isBlackMarked(p),
    createdAt: p.created_at,
    then: p.then_text || '',
    now: p.now_text || '',
    when: p.when_label || '',
    place: p.place || '',
    myVote: mine.vote ?? 0,
    myPlausibility: mine.plaus ?? null,
    iFlagged: mine.reality ?? false,
  };
}

// Fetch the current viewer's own interactions for a set of posts in one trip.
async function myState(voter, postIds) {
  if (!voter || postIds.length === 0) return {};
  const [v, p, r] = await Promise.all([
    q('SELECT post_id, value FROM votes WHERE voter = $1 AND post_id = ANY($2)', [voter, postIds]),
    q('SELECT post_id, score FROM plausibility WHERE voter = $1 AND post_id = ANY($2)', [voter, postIds]),
    q('SELECT post_id FROM reality_checks WHERE voter = $1 AND post_id = ANY($2)', [voter, postIds]),
  ]);
  const out = {};
  const slot = (id) => (out[id] ||= {});
  for (const row of v.rows) slot(row.post_id).vote = row.value;
  for (const row of p.rows) slot(row.post_id).plaus = row.score;
  for (const row of r.rows) slot(row.post_id).reality = true;
  return out;
}

const wantsJson = (req) => req.accepts(['html', 'json']) === 'json';

/**
 * Resolve a path id to a post that is actually on the wire.
 *
 * The write routes used to take :id straight from the path, so a known or
 * guessed id could be voted on, rated, reality-checked or commented on while
 * the post was still in the moderation queue, already rejected, or held back
 * by a scheduled publish_at. Votes cast that way counted the moment the post
 * went live. Returns the id when the post is public, null otherwise.
 */
async function livePostId(raw) {
  const id = postId(raw);
  if (!id) return null;
  const r = await q(
    `SELECT id FROM posts WHERE id = $1 AND status = 'live' AND publish_at <= NOW()`,
    [id],
  );
  return r.rows.length ? id : null;
}

/* ================================================================== *
 * API — reading
 * ================================================================== */

app.get('/api/posts', async (req, res, next) => {
  try {
    const sort = ['hot', 'new', 'top'].includes(req.query.sort) ? req.query.sort : 'hot';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = 25;
    const voter = readVoter(req);
    const desk = String(req.query.desk || '').trim().slice(0, 32);
    const deskSql = desk ? ` AND desk = '${desk.replace(/[^a-z]/g, '')}'` : '';

    // "hot" needs the whole live set to rank, so keep the live set modest;
    // the other two sort in SQL and page properly.
    let rows;
    if (sort === 'hot') {
      const all = await q(
        `SELECT * FROM posts WHERE status = 'live' AND publish_at <= NOW()${deskSql} ORDER BY created_at DESC LIMIT 500`,
      );
      rows = all.rows
        .sort((a, b) => hotScore(b) - hotScore(a))
        .slice((page - 1) * perPage, page * perPage);
    } else {
      const order = sort === 'new' ? 'created_at DESC' : '(ups - downs) DESC, created_at DESC';
      const r = await q(
        `SELECT * FROM posts WHERE status = 'live' AND publish_at <= NOW()${deskSql} ORDER BY ${order} LIMIT $1 OFFSET $2`,
        [perPage, (page - 1) * perPage],
      );
      rows = r.rows;
    }

    const mine = await myState(voter, rows.map((r) => r.id));
    const total = await q(`SELECT COUNT(*)::int AS n FROM posts WHERE status = 'live' AND publish_at <= NOW()${deskSql}`);

    res.json({
      posts: rows.map((p) => shapePost(p, mine[p.id] || {})),
      page,
      hasMore: page * perPage < total.rows[0].n,
      total: total.rows[0].n,
    });
  } catch (e) { next(e); }
});

app.get('/api/reality', async (req, res, next) => {
  try {
    const voter = readVoter(req);
    const r = await q(
      `SELECT * FROM posts WHERE status = 'live' AND publish_at <= NOW() AND overtaken_at IS NOT NULL
       ORDER BY overtaken_at DESC LIMIT 100`,
    );
    const mine = await myState(voter, r.rows.map((x) => x.id));
    const withSources = await Promise.all(
      r.rows.map(async (p) => {
        const s = await q(
          `SELECT source_url, note FROM reality_checks
           WHERE post_id = $1 AND status <> 'rejected' ORDER BY created_at LIMIT 5`,
          [p.id],
        );
        return { ...shapePost(p, mine[p.id] || {}), sources: s.rows };
      }),
    );
    res.json({ posts: withSources });
  } catch (e) { next(e); }
});

app.get('/api/posts/:slug', async (req, res, next) => {
  try {
    const voter = readVoter(req);
    const r = await q(`SELECT * FROM posts WHERE slug = $1 AND status = 'live' AND publish_at <= NOW()`, [req.params.slug]);
    if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
    const p = r.rows[0];
    const mine = await myState(voter, [p.id]);
    const [comments, sources] = await Promise.all([
      q(`SELECT id, author, body, created_at FROM comments
         WHERE post_id = $1 AND status = 'live' ORDER BY created_at ASC LIMIT 500`, [p.id]),
      q(`SELECT source_url, note, created_at FROM reality_checks
         WHERE post_id = $1 AND status <> 'rejected' ORDER BY created_at LIMIT 20`, [p.id]),
    ]);
    res.json({
      post: shapePost(p, mine[p.id] || {}),
      comments: comments.rows.map((c) => ({ ...c, id: String(c.id) })),
      sources: sources.rows,
    });
  } catch (e) { next(e); }
});

/* ================================================================== *
 * API — writing
 * ================================================================== */

app.post('/api/posts', async (req, res, next) => {
  try {
    const gate = rateLimit({ key: `submit:${clientIp(req)}`, limit: 10, windowMs: 60 * 60 * 1000 });
    if (!gate.ok) {
      return res.status(429).json({
        error: 'rate_limited',
        message: `You've posted ten times this hour. Try again in ${Math.ceil(gate.retryAfter / 60)} minutes.`,
      });
    }

    const voter = voterOf(req, res);
    const thenText = String(req.body.then || '').trim();
    const nowText = String(req.body.now || '').trim();
    const body = String(req.body.body || '').trim();
    const author = String(req.body.author || '').trim().slice(0, 40) || 'Anonymous';
    const desk = String(req.body.desk || 'general').trim().slice(0, 32);
    const whenLabel = String(req.body.when || '').trim().slice(0, 40);
    const place = String(req.body.place || '').trim().slice(0, 60);
    // The "now" line doubles as the headline: it's what lists and share
    // previews show, and what the duplicate check compares.
    const headline = nowText.slice(0, 180);

    if (thenText.length < 5) {
      return res.status(400).json({ error: 'too_short', message: 'Say a little about then.' });
    }
    if (nowText.length < 5) {
      return res.status(400).json({ error: 'too_short', message: 'Say a little about now.' });
    }
    if (thenText.length > 300 || nowText.length > 300) {
      return res.status(400).json({ error: 'too_long', message: 'Keep then and now under 300 characters each. The longer version goes in the box below.' });
    }
    if (body.length > 2000) {
      return res.status(400).json({ error: 'too_long', message: 'Keep the longer account under 2000 characters.' });
    }

    const dupe = await q(`SELECT slug FROM posts WHERE lower(headline) = lower($1) LIMIT 1`, [headline]);
    if (dupe.rows.length) {
      return res.status(409).json({
        error: 'duplicate',
        message: 'Someone already posted that exact line.',
        slug: dupe.rows[0].slug,
      });
    }

    const flagged = needsReview(`${thenText}\n${nowText}\n${body}`);
    const status = REQUIRE_APPROVAL || flagged ? 'pending' : 'live';

    const r = await q(
      `INSERT INTO posts (slug, headline, body, author, desk, status, submitter, then_text, now_text, when_label, place)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [slugify(headline), headline, body, author, desk, status, voter, thenText, nowText, whenLabel, place],
    );

    // Mail the desk. Deliberately not awaited: delivery must not delay
    // the response, and a mail failure must not fail the submission.
    notifySubmission(r.rows[0], status === 'pending');

    res.status(201).json({
      post: shapePost(r.rows[0]),
      pending: status === 'pending',
      message: status === 'pending'
        ? 'Posted. It gets a quick look before it goes up.'
        : 'Posted.',
    });
  } catch (e) { next(e); }
});

app.post('/api/posts/:id/vote', async (req, res, next) => {
  try {
    const gate = rateLimit({ key: `vote:${clientIp(req)}`, limit: 120, windowMs: 60 * 1000 });
    if (!gate.ok) return res.status(429).json({ error: 'rate_limited' });

    const voter = voterOf(req, res);
    const dir = Number(req.body.dir);
    if (![1, -1, 0].includes(dir)) return res.status(400).json({ error: 'bad_direction' });

    const id = await livePostId(req.params.id);
    if (!id) return res.status(404).json({ error: 'not_found' });

    const prev = await q(`SELECT value FROM votes WHERE post_id = $1 AND voter = $2`, [id, voter]);
    const old = prev.rows[0]?.value ?? 0;
    const next = dir === old ? 0 : dir; // clicking the same arrow twice clears it

    if (next === 0) {
      await q(`DELETE FROM votes WHERE post_id = $1 AND voter = $2`, [id, voter]);
    } else {
      await q(
        `INSERT INTO votes (post_id, voter, value) VALUES ($1,$2,$3)
         ON CONFLICT (post_id, voter) DO UPDATE SET value = EXCLUDED.value`,
        [id, voter, next],
      );
    }

    // Recount from the source of truth rather than incrementing, so a
    // retried request can never double-count.
    const r = await q(
      `UPDATE posts SET
         ups   = (SELECT COUNT(*) FROM votes WHERE post_id = $1 AND value = 1),
         downs = (SELECT COUNT(*) FROM votes WHERE post_id = $1 AND value = -1)
       WHERE id = $1 RETURNING *`,
      [id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
    res.json({ post: shapePost(r.rows[0], { vote: next }) });
  } catch (e) { next(e); }
});

// Reality Check — "this already happened", with a source.
app.post('/api/posts/:id/reality', async (req, res, next) => {
  try {
    const gate = rateLimit({ key: `reality:${clientIp(req)}`, limit: 20, windowMs: 60 * 60 * 1000 });
    if (!gate.ok) return res.status(429).json({ error: 'rate_limited' });

    const voter = voterOf(req, res);
    const url = safeSourceUrl(String(req.body.source_url || '').trim());
    const note = String(req.body.note || '').trim().slice(0, 300);

    if (!url) {
      return res.status(400).json({
        error: 'bad_source',
        message: 'A reality check needs a link to the real story. That is the whole point.',
      });
    }

    const id = await livePostId(req.params.id);
    if (!id) return res.status(404).json({ error: 'not_found' });

    await q(
      `INSERT INTO reality_checks (post_id, voter, source_url, note)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (post_id, voter) DO UPDATE SET source_url = EXCLUDED.source_url, note = EXCLUDED.note`,
      [id, voter, url, note],
    );

    const r = await q(
      `UPDATE posts SET
         reality_count = (SELECT COUNT(*) FROM reality_checks WHERE post_id = $1 AND status <> 'rejected'),
         overtaken_at = CASE
           WHEN overtaken_at IS NOT NULL THEN overtaken_at
           WHEN (SELECT COUNT(*) FROM reality_checks WHERE post_id = $1 AND status <> 'rejected') >= $2
             THEN NOW()
           ELSE NULL END
       WHERE id = $1 RETURNING *`,
      [id, REALITY_THRESHOLD],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'not_found' });

    const post = shapePost(r.rows[0], { reality: true });
    res.json({
      post,
      message: post.overtaken
        ? 'Confirmed. Reality got there first.'
        : `Logged. ${REALITY_THRESHOLD - post.realityCount} more and this moves to Came True.`,
    });
  } catch (e) { next(e); }
});

// Afterwards: newsletter signup. Stores the address, tells the desk.
app.post('/api/subscribe', async (req, res, next) => {
  try {
    const gate = rateLimit({ key: `subscribe:${clientIp(req)}`, limit: 5, windowMs: 60 * 60 * 1000 });
    if (!gate.ok) return res.status(429).json({ error: 'rate_limited' });
    const email = String(req.body.email || '').trim().toLowerCase().slice(0, 254);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'bad_email', message: 'That does not look like an email address.' });
    }
    const r = await q(`INSERT INTO subscribers (email) VALUES ($1) ON CONFLICT DO NOTHING RETURNING email`, [email]);
    if (r.rows.length) notifySubscriber(email);
    res.json({ ok: true, message: r.rows.length ? "You're on the list." : "You're already on the list." });
  } catch (e) { next(e); }
});

app.get('/api/admin/subscribers', requireAdmin, async (req, res, next) => {
  try {
    const r = await q(`SELECT email, created_at FROM subscribers ORDER BY created_at DESC`);
    if (req.query.format === 'csv') {
      res.type('text/csv').send('email,created_at\n' + r.rows.map((x) => `${x.email},${x.created_at.toISOString()}`).join('\n'));
      return;
    }
    res.json({ subscribers: r.rows });
  } catch (e) { next(e); }
});

// Plausibility Index — how likely is this, really?
app.post('/api/posts/:id/plausibility', async (req, res, next) => {
  try {
    const gate = rateLimit({ key: `plaus:${clientIp(req)}`, limit: 120, windowMs: 60 * 1000 });
    if (!gate.ok) return res.status(429).json({ error: 'rate_limited' });

    const voter = voterOf(req, res);
    // Validate before clamping rather than after. clamp() only happens to
    // pass NaN through untouched, so the old order was correct by accident.
    const raw = Number(req.body.score);
    if (!Number.isFinite(raw)) return res.status(400).json({ error: 'bad_score' });
    const score = clamp(Math.round(raw), 0, 100);

    const id = await livePostId(req.params.id);
    if (!id) return res.status(404).json({ error: 'not_found' });

    await q(
      `INSERT INTO plausibility (post_id, voter, score) VALUES ($1,$2,$3)
       ON CONFLICT (post_id, voter) DO UPDATE SET score = EXCLUDED.score`,
      [id, voter, score],
    );

    const r = await q(
      `UPDATE posts SET
         plaus_sum = (SELECT COALESCE(SUM(score),0) FROM plausibility WHERE post_id = $1),
         plaus_n   = (SELECT COUNT(*) FROM plausibility WHERE post_id = $1)
       WHERE id = $1 RETURNING *`,
      [id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
    res.json({ post: shapePost(r.rows[0], { plaus: score }) });
  } catch (e) { next(e); }
});

app.post('/api/posts/:id/comments', async (req, res, next) => {
  try {
    const gate = rateLimit({ key: `comment:${clientIp(req)}`, limit: 20, windowMs: 10 * 60 * 1000 });
    if (!gate.ok) {
      return res.status(429).json({ error: 'rate_limited', message: 'Slow down a moment.' });
    }

    const voter = voterOf(req, res);
    const body = String(req.body.body || '').trim();
    const author = String(req.body.author || '').trim().slice(0, 40) || 'Anonymous';
    if (body.length < 2) return res.status(400).json({ error: 'too_short' });
    if (body.length > 1000) return res.status(400).json({ error: 'too_long' });

    const id = await livePostId(req.params.id);
    if (!id) return res.status(404).json({ error: 'not_found' });

    const status = needsReview(body) ? 'pending' : 'live';
    const r = await q(
      `INSERT INTO comments (post_id, author, body, status, submitter)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, author, body, created_at`,
      [id, author, body, status, voter],
    );
    await q(
      `UPDATE posts SET comment_count =
        (SELECT COUNT(*) FROM comments WHERE post_id = $1 AND status = 'live') WHERE id = $1`,
      [id],
    );

    res.status(201).json({
      comment: status === 'live' ? { ...r.rows[0], id: String(r.rows[0].id) } : null,
      pending: status === 'pending',
    });
  } catch (e) { next(e); }
});

app.post('/api/report', async (req, res, next) => {
  try {
    const gate = rateLimit({ key: `report:${clientIp(req)}`, limit: 15, windowMs: 60 * 60 * 1000 });
    if (!gate.ok) return res.status(429).json({ error: 'rate_limited' });

    const voter = voterOf(req, res);
    // Named apart from the imported postId() validator, which this used to
    // shadow. Both ids are screened now: an unparseable one used to reach
    // Postgres and come back as a 500.
    const reportedPost = req.body.post_id ? postId(req.body.post_id) : null;
    const reportedComment = req.body.comment_id ? postId(req.body.comment_id) : null;
    if (!reportedPost && !reportedComment) return res.status(400).json({ error: 'nothing_reported' });

    await q(
      `INSERT INTO reports (post_id, comment_id, reason, reporter) VALUES ($1,$2,$3,$4)`,
      [reportedPost, reportedComment, String(req.body.reason || '').slice(0, 300), voter],
    );
    if (reportedPost) {
      await q(
        `UPDATE posts SET report_count =
          (SELECT COUNT(*) FROM reports WHERE post_id = $1) WHERE id = $1`,
        [reportedPost],
      );
    }
    res.json({ ok: true, message: 'Reported. Someone will look at it.' });
  } catch (e) { next(e); }
});

/* ================================================================== *
 * Admin
 * ================================================================== */

// The cookie carries a key-derived token, never the key itself. The header
// still takes the raw key, so scripted admin calls keep working unchanged.
const ADMIN_COOKIE = ADMIN_KEY ? adminToken(ADMIN_KEY) : '';

function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) return res.status(503).json({ error: 'admin_disabled', message: 'ADMIN_KEY is not set.' });
  const header = req.get('x-admin-key');
  const cookie = req.cookies?.admin;
  // safeEqual, not ===, so response time does not narrow the key down
  // one character at a time.
  const ok = (header && safeEqual(header, ADMIN_KEY)) || (cookie && safeEqual(cookie, ADMIN_COOKIE));
  if (!ok) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.post('/api/admin/login', (req, res) => {
  // This endpoint had no limiter at all, which left ADMIN_KEY open to an
  // unbounded online guessing loop. Ten tries an hour per address.
  const gate = rateLimit({ key: `adminlogin:${clientIp(req)}`, limit: 10, windowMs: 60 * 60 * 1000 });
  if (!gate.ok) {
    return res.status(429).json({
      error: 'rate_limited',
      message: `Too many attempts. Try again in ${Math.ceil(gate.retryAfter / 60)} minutes.`,
    });
  }

  if (!ADMIN_KEY || !safeEqual(String(req.body.key ?? ''), ADMIN_KEY)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  res.cookie('admin', ADMIN_COOKIE, {
    httpOnly: true, sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 12 * 60 * 60 * 1000,
  });
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => { res.clearCookie('admin'); res.json({ ok: true }); });

app.get('/api/admin/queue', requireAdmin, async (req, res, next) => {
  try {
    const [posts, comments, reports] = await Promise.all([
      q(`SELECT * FROM posts WHERE status = 'pending' ORDER BY created_at ASC LIMIT 200`),
      q(`SELECT c.*, p.slug, p.headline FROM comments c JOIN posts p ON p.id = c.post_id
         WHERE c.status = 'pending' ORDER BY c.created_at ASC LIMIT 200`),
      q(`SELECT r.*, p.slug, p.headline FROM reports r LEFT JOIN posts p ON p.id = r.post_id
         ORDER BY r.created_at DESC LIMIT 100`),
    ]);
    res.json({
      posts: posts.rows.map((p) => shapePost(p)),
      comments: comments.rows.map((c) => ({ ...c, id: String(c.id), post_id: String(c.post_id) })),
      reports: reports.rows.map((r) => ({ ...r, id: String(r.id) })),
      liveCount: (await q(`SELECT COUNT(*)::int AS n FROM posts WHERE status = 'live' AND publish_at <= NOW()`)).rows[0].n,
      // Not-yet-overtaken live posts, for the "mark as came true" picker.
      live: (await q(
        `SELECT id, headline FROM posts WHERE status = 'live' AND overtaken_at IS NULL ORDER BY created_at DESC LIMIT 500`,
      )).rows.map((p) => ({ id: String(p.id), headline: p.headline })),
    });
  } catch (e) { next(e); }
});

/**
 * Desk override for the reality check: mark a post as come true with one
 * source, no three-reader threshold. body: { source_url, note }
 */
app.post('/api/admin/posts/:id/overtake', requireAdmin, async (req, res, next) => {
  try {
    const id = postId(req.params.id);
    const url = safeSourceUrl(String(req.body.source_url || '').trim());
    const note = String(req.body.note || '').trim().slice(0, 300);
    if (!id) return res.status(404).json({ error: 'not_found' });
    if (!url) return res.status(400).json({ error: 'bad_source', message: 'Needs a link to the real story.' });
    await q(
      `INSERT INTO reality_checks (post_id, voter, source_url, note, status)
       VALUES ($1,'desk',$2,$3,'confirmed')
       ON CONFLICT (post_id, voter) DO UPDATE SET source_url = EXCLUDED.source_url, note = EXCLUDED.note`,
      [id, url, note],
    );
    const r = await q(
      `UPDATE posts SET
         reality_count = (SELECT COUNT(*) FROM reality_checks WHERE post_id = $1 AND status <> 'rejected'),
         overtaken_at = COALESCE(overtaken_at, NOW())
       WHERE id = $1 RETURNING *`,
      [id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
    res.json({ post: shapePost(r.rows[0]) });
  } catch (e) { next(e); }
});

app.post('/api/admin/posts/:id/:action', requireAdmin, async (req, res, next) => {
  try {
    const { action } = req.params;
    const id = postId(req.params.id);
    if (!id) return res.status(404).json({ error: 'not_found' });
    if (action === 'approve') await q(`UPDATE posts SET status = 'live' WHERE id = $1`, [id]);
    else if (action === 'reject') await q(`UPDATE posts SET status = 'rejected' WHERE id = $1`, [id]);
    else if (action === 'delete') await q(`DELETE FROM posts WHERE id = $1`, [id]);
    else return res.status(400).json({ error: 'unknown_action' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ *
 * Scheduled release
 *
 * A live post is public only once its publish_at has passed, so a batch
 * of posts can be dripped out over a window instead of landing at once.
 * No cron, no background worker: visibility is decided by the query at
 * read time, so it stays correct even when the instance has been asleep.
 * ------------------------------------------------------------------ */

// What is queued but not yet public.
app.get('/api/admin/schedule', requireAdmin, async (req, res, next) => {
  try {
    const r = await q(
      `SELECT id, slug, headline, publish_at FROM posts
        WHERE status = 'live' AND publish_at > NOW()
        ORDER BY publish_at ASC`,
    );
    res.json({
      pending: r.rows.length,
      posts: r.rows.map((p) => ({
        id: String(p.id),
        slug: p.slug,
        headline: p.headline,
        publishAt: p.publish_at,
        inMinutes: Math.round((new Date(p.publish_at) - Date.now()) / 60000),
      })),
    });
  } catch (e) { next(e); }
});

/**
 * Spread currently-public posts across a future window.
 *
 * body: {
 *   hours      how long the drip runs           (default 24)
 *   keepLive   newest N stay visible now        (default 1)
 *   startIn    minutes before the first release (default 0)
 *   retime     also move created_at to match    (default true)
 *   jitter     +/- 20% wobble between slots     (default true)
 * }
 *
 * retime matters: the byline reads "filed 3h ago" off created_at, so
 * without it a post released tomorrow would surface already looking a
 * day stale. Votes, comments and reality checks are untouched either way.
 */
app.post('/api/admin/schedule/spread', requireAdmin, async (req, res, next) => {
  try {
    // num() keeps a garbage value from turning into NaN dates downstream.
    const num = (v, dflt, lo, hi) => {
      const n = Number(v ?? dflt);
      return clamp(Number.isFinite(n) ? n : dflt, lo, hi);
    };
    const hours = num(req.body.hours, 24, 0.1, 24 * 14);
    const keepLive = num(req.body.keepLive, 1, 0, 100);
    const startIn = num(req.body.startIn, 0, 0, 60 * 24);
    const retime = req.body.retime !== false;
    const jitter = req.body.jitter !== false;

    // Newest first, so keepLive holds back the freshest posts.
    const all = await q(
      `SELECT id, slug, headline FROM posts
        WHERE status = 'live' AND publish_at <= NOW()
        ORDER BY created_at DESC`,
    );
    const queue = all.rows.slice(keepLive).reverse(); // oldest releases first
    if (!queue.length) {
      return res.json({ scheduled: 0, kept: all.rows.length, posts: [] });
    }

    const windowMs = hours * 3600 * 1000;
    const step = windowMs / queue.length;
    const now = Date.now() + startIn * 60 * 1000;

    const out = [];
    for (let i = 0; i < queue.length; i++) {
      const wobble = jitter ? (Math.random() - 0.5) * step * 0.4 : 0;
      // i + 1: the first release is one slot in, never instantly, and the
      // last lands at the end of the window even after wobble.
      const at = new Date(
        Math.min(now + windowMs, Math.max(now + 60000, now + step * (i + 1) + wobble)),
      );
      const p = queue[i];
      await q(
        retime
          ? `UPDATE posts SET publish_at = $2, created_at = $2 WHERE id = $1`
          : `UPDATE posts SET publish_at = $2 WHERE id = $1`,
        [p.id, at],
      );
      out.push({ id: String(p.id), headline: p.headline, publishAt: at });
    }

    console.log(`[schedule] ${out.length} post(s) spread over ${hours}h`);
    res.json({ scheduled: out.length, kept: keepLive, hours, posts: out });
  } catch (e) { next(e); }
});

/**
 * Bulk import. body: { posts: [ { headline, body, author, desk } ] }
 * Same shape as seed.json, same rules: straight to live, duplicate
 * headlines skipped, no submit rate limit since this is the desk's own
 * content. Capped at 100 rows a call.
 */
app.post('/api/admin/import', requireAdmin, async (req, res, next) => {
  try {
    const rows = Array.isArray(req.body.posts) ? req.body.posts.slice(0, 100) : null;
    if (!rows) return res.status(400).json({ error: 'bad_request', message: 'Send { posts: [...] }.' });
    const added = await insertRows(rows);
    res.json({ added, skipped: rows.length - added });
  } catch (e) { next(e); }
});

// Undo: make everything public again right now.
app.post('/api/admin/schedule/clear', requireAdmin, async (req, res, next) => {
  try {
    const r = await q(
      `UPDATE posts SET publish_at = NOW() WHERE publish_at > NOW() RETURNING id`,
    );
    res.json({ released: r.rows.length });
  } catch (e) { next(e); }
});

app.post('/api/admin/comments/:id/:action', requireAdmin, async (req, res, next) => {
  try {
    const { action } = req.params;
    const id = postId(req.params.id);
    if (!id) return res.status(404).json({ error: 'not_found' });
    if (action === 'approve') await q(`UPDATE comments SET status = 'live' WHERE id = $1`, [id]);
    else if (action === 'delete') await q(`DELETE FROM comments WHERE id = $1`, [id]);
    else return res.status(400).json({ error: 'unknown_action' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ================================================================== *
 * Pages — server-rendered shells, so share cards have real metadata
 * ================================================================== */

app.get('/', (req, res) => res.send(shell({ view: 'feed', origin: ORIGIN })));
app.get('/submit', (req, res) => res.send(shell({ view: 'submit', origin: ORIGIN })));
app.get('/about', (req, res) => res.send(shell({ view: 'about', origin: ORIGIN })));
app.get('/terms', (req, res) => res.send(shell({ view: 'terms', origin: ORIGIN })));
app.get('/admin', (req, res) => res.send(shell({ view: 'admin', origin: ORIGIN })));

app.get('/p/:slug', async (req, res, next) => {
  try {
    const r = await q(`SELECT * FROM posts WHERE slug = $1 AND status = 'live' AND publish_at <= NOW()`, [req.params.slug]);
    if (!r.rows.length) return res.status(404).send(shell({ view: 'notfound', origin: ORIGIN }));
    const p = r.rows[0];
    res.send(shell({
      view: 'post',
      origin: ORIGIN,
      meta: {
        title: `${p.headline} — postcov`,
        description: `${p.body || 'Life after COVID. It\'s not the same.'}`.trim().slice(0, 200),
        url: `${ORIGIN}/p/${p.slug}`,
      },
      bootstrap: { slug: p.slug },
    }));
  } catch (e) { next(e); }
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use((req, res) => {
  if (wantsJson(req)) return res.status(404).json({ error: 'not_found' });
  res.status(404).send(shell({ view: 'notfound', origin: ORIGIN }));
});

app.use((err, req, res, _next) => {
  console.error(err);
  if (wantsJson(req)) return res.status(500).json({ error: 'server_error' });
  res.status(500).send(shell({ view: 'error', origin: ORIGIN }));
});

/* ================================================================== */

const PORT = process.env.PORT || 3000;

/**
 * Shut down without dropping requests.
 *
 * A deploy sends SIGTERM and then waits. Without a handler the process died
 * on the spot: in-flight votes and submissions were cut mid-response and the
 * Postgres pool was left for the server to time out. Stop accepting new
 * connections, let the open ones finish, then drain the pool.
 */
function shutdownOn(server) {
  let closing = false;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      if (closing) return; // a second signal during drain should not re-enter
      closing = true;
      console.log(`[www] ${signal} — finishing in-flight requests`);

      // Don't hang a deploy forever on one stuck connection.
      const hardStop = setTimeout(() => {
        console.warn('[www] drain timed out, exiting anyway');
        process.exit(1);
      }, 10_000);
      hardStop.unref?.();

      server.close(async () => {
        try {
          await pool.end();
        } catch (e) {
          console.warn('[db] pool did not close cleanly:', e.message);
        }
        clearTimeout(hardStop);
        process.exit(0);
      });
    });
  }
}

const boot = async () => {
  await migrate();
  // First boot against an empty database loads seed.json for you, so a
  // fresh deploy is never a blank site and never needs shell access.
  await autoSeed(() => loadSeed());
  console.log(notifyStatus());
  const server = app.listen(PORT, () => console.log(`[www] listening on :${PORT}`));
  shutdownOn(server);
};

boot().catch((e) => { console.error('[boot] failed', e); process.exit(1); });
