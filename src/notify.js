/* ================================================================== *
 * Email notifications
 *
 * Sends you a mail when someone files a proposal, so pending items
 * don't sit unnoticed in /admin.
 *
 * Uses Resend's HTTP API directly — no npm dependency, no SMTP.
 * Entirely optional: with RESEND_API_KEY or NOTIFY_EMAIL unset, every
 * function here is a no-op and the site behaves exactly as before.
 *
 * Sending is fire-and-forget. A mail failure must never fail, slow or
 * break a submission — the post is already safely in Postgres by the
 * time we get here.
 * ================================================================== */

const API_KEY = process.env.RESEND_API_KEY || '';
const TO = process.env.NOTIFY_EMAIL || '';
const FROM = process.env.NOTIFY_FROM || 'postcov <onboarding@resend.dev>';
const ORIGIN = (process.env.SITE_ORIGIN || '').replace(/\/$/, '');

export const notifyEnabled = Boolean(API_KEY && TO);

/** One-line summary for the boot log, so misconfiguration is visible. */
export function notifyStatus() {
  if (notifyEnabled) return `[mail] submission alerts on -> ${TO}`;
  if (API_KEY && !TO) return '[mail] off: RESEND_API_KEY set but NOTIFY_EMAIL missing';
  if (TO && !API_KEY) return '[mail] off: NOTIFY_EMAIL set but RESEND_API_KEY missing';
  return '[mail] off: set RESEND_API_KEY and NOTIFY_EMAIL to get submission alerts';
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const trim = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n)}…` : String(s ?? ''));

async function send({ subject, html, text }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ from: FROM, to: [TO], subject, html, text }),
    // Resend is normally sub-second; never let it hang a request thread.
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    // Body carries Resend's reason (unverified domain, bad key, etc).
    const detail = await res.text().catch(() => '');
    throw new Error(`resend ${res.status}: ${trim(detail, 300)}`);
  }
}

/**
 * Mail yourself about a new post.
 * Call WITHOUT await — it resolves on its own and swallows its errors.
 *
 * @param {object} post   the row returned by the INSERT
 * @param {boolean} pending  true when it landed in the review queue
 */
export function notifySubmission(post, pending) {
  if (!notifyEnabled) return;

  const headline = trim(post.headline, 180);
  const body = trim([post.then_text && `Then: ${post.then_text}`, post.now_text && `Now: ${post.now_text}`, post.body].filter(Boolean).join('\n\n'), 900);
  const author = post.author || 'Anonymous';
  const desk = post.desk || 'general';

  const adminUrl = `${ORIGIN || ''}/admin`;
  const liveUrl = `${ORIGIN || ''}/p/${post.slug}`;
  const link = pending ? adminUrl : liveUrl;
  const action = pending ? 'Review it in the queue' : 'See it on the site';

  const subject = `${pending ? '[pending]' : '[live]'} ${trim(headline, 90)}`;

  const text = [
    pending
      ? 'A new post is waiting for review.'
      : 'A new post is live.',
    '',
    headline,
    '',
    body,
    '',
    `Filed by: ${author}   Desk: ${desk}`,
    `${action}: ${link}`,
  ].join('\n');

  const html = `
    <div style="font:16px/1.5 Georgia,serif;color:#1a1a1a;max-width:34em">
      <p style="font:12px/1.4 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:#8a0f0f;margin:0 0 1.2em">
        ${pending ? 'New post: awaiting review' : 'New post: live'}
      </p>
      <h1 style="font-size:22px;line-height:1.25;margin:0 0 .6em">${esc(headline)}</h1>
      ${body ? `<p style="margin:0 0 1.2em;color:#333">${esc(body)}</p>` : ''}
      <p style="font:12px/1.4 ui-monospace,monospace;color:#666;margin:0 0 1.6em">
        FILED BY ${esc(author.toUpperCase())} &middot; DESK ${esc(String(desk).toUpperCase())}
      </p>
      <p style="margin:0">
        <a href="${esc(link)}" style="display:inline-block;padding:.6em 1.1em;background:#1a1a1a;color:#fff;text-decoration:none;font:14px/1 ui-monospace,monospace">
          ${action}
        </a>
      </p>
    </div>`;

  send({ subject, html, text }).catch((e) => {
    console.warn('[mail] submission alert failed:', e.message);
  });
}

/** A new Afterwards subscriber. Call without await. */
export function notifySubscriber(email) {
  if (!notifyEnabled) return;
  send({
    subject: `[afterwards] new subscriber`,
    text: `${email} signed up for Afterwards.\n\nExport the list: ${ORIGIN || ''}/api/admin/subscribers?format=csv`,
    html: `<p style="font:16px/1.5 Georgia,serif">${esc(email)} signed up for Afterwards.</p>
      <p style="font:13px ui-monospace,monospace"><a href="${esc(ORIGIN || '')}/api/admin/subscribers?format=csv">Export the list</a></p>`,
  }).catch((e) => console.warn('[mail] subscriber alert failed:', e.message));
}
