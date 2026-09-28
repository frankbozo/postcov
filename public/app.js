/* =================================================================
   postcov — client
   No framework, no build step. Renders into #app based on data-view.
   ================================================================= */

const app = document.getElementById('app');
const VIEW = app.dataset.view;
const BOOT = JSON.parse(document.getElementById('bootstrap').textContent || '{}');

/* ---------- tiny helpers ---------- */

const h = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content;
};

const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || data.error || 'Request failed'), { data, status: res.status });
  return data;
}

function ago(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 2592000) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
}

const longDate = () =>
  new Date().toLocaleDateString('en-CA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

/* ---------- shared chrome ---------- */

const PROMPTS = [
  { value: 'general', label: 'Anything' },
  { value: 'work', label: 'Work' },
  { value: 'money', label: 'Money' },
  { value: 'health', label: 'Health' },
  { value: 'people', label: 'Relationships' },
  { value: 'kids', label: 'Kids and school' },
  { value: 'miss', label: 'Things I miss' },
  { value: 'dontmiss', label: "Things I don't" },
];
const promptLabel = (v) => (PROMPTS.find((p) => p.value === v) || PROMPTS[0]).label;

function chrome(current, inner) {
  return `
<header class="masthead">
  <div class="wrap masthead__inner">
    <h1 class="masthead__title"><a href="/">post<span>cov</span></a></h1>
    <p class="masthead__tag">Life after COVID. It's not the same.</p>
  </div>
  <div class="wrap">
    <nav class="sections" aria-label="Sections">
      <a href="/" ${current === 'feed' ? 'aria-current="page"' : ''}>Stories</a>
      <a href="/submit" ${current === 'submit' ? 'aria-current="page"' : ''}>Tell yours</a>
      <span class="spacer"></span>
      <a href="/about" ${current === 'about' ? 'aria-current="page"' : ''}>About</a>
    </nav>
  </div>
</header>
<main id="main"><div class="wrap">${inner}</div></main>
<footer>
  <div class="wrap">
    <div class="links mono">
      <a href="/about">About</a><a href="/terms">Terms &amp; Privacy</a><a href="/submit">Tell yours</a>
    </div>
    <p class="disclaimer">
      Everything here is someone's own experience, posted anonymously. Nothing is medical advice.
    </p>
    <p class="disclaimer">
      If you're struggling: in Canada call or text <strong>988</strong>. In the US, <strong>988</strong> too.
      Long COVID support: <a href="https://www.longcovidweb.ca" rel="noopener">longcovidweb.ca</a>.
    </p>
    <p class="made">Made in Canada &#127809;</p>
  </div>
</footer>`;
}

function render(current, inner) {
  app.innerHTML = chrome(current, inner);
}

/* ---------- post rendering ---------- */

function itemMarkup(p) {
  return `
<li class="item" data-id="${p.id}" data-slug="${esc(p.slug)}">
  <h2 class="item__head"><a href="/p/${esc(p.slug)}">${esc(p.headline)}</a></h2>
  ${p.body ? `<p class="item__lede">${esc(p.body.slice(0, 260))}${p.body.length > 260 ? '&hellip;' : ''}</p>` : ''}
  <div class="item__meta">
    <button class="metoo vote-up" aria-pressed="${p.myVote === 1}">
      <span class="metoo__label">Me too</span><span class="metoo__n num">${Math.max(0, p.ups)}</span>
    </button>
    <span class="sep">&middot;</span>
    <span>${esc(p.author)}</span>
    <span class="sep">&middot;</span>
    <span>${promptLabel(p.desk)}</span>
    <span class="sep">&middot;</span>
    <span>${ago(p.createdAt)}</span>
    <span class="sep">&middot;</span>
    <a href="/p/${esc(p.slug)}">${p.commentCount} ${p.commentCount === 1 ? 'reply' : 'replies'}</a>
    <span class="sep">&middot;</span>
    <button class="share-link" type="button">Share</button>
  </div>
</li>`;
}

/* ---------- interactions wired by delegation ---------- */

function wireVoting(root) {
  root.addEventListener('click', async (e) => {
    const li = e.target.closest('[data-id]');
    if (!li) return;

    const share = e.target.closest('.share-link');
    if (share) {
      const url = `${location.origin}/p/${li.dataset.slug}`;
      const title = li.querySelector('.item__head a, .article__head')?.textContent || '';
      try {
        if (navigator.share) await navigator.share({ title, url });
        else { await navigator.clipboard.writeText(url); flash('Link copied.', true); }
      } catch { /* user dismissed the share sheet */ }
      return;
    }

    const up = e.target.closest('.vote-up');
    if (!up) return;
    try {
      const { post } = await api(`/api/posts/${li.dataset.id}/vote`, { method: 'POST', body: { dir: 1 } });
      li.querySelector('.metoo__n').textContent = String(Math.max(0, post.ups));
      up.setAttribute('aria-pressed', String(post.myVote === 1));
    } catch (err) {
      flash(err.message);
    }
  });
}

let flashTimer;
function flash(message, ok = false) {
  document.querySelector('.flash')?.remove();
  const el = h(`<div class="notice ${ok ? 'notice--ok' : ''} flash">${esc(message)}</div>`).firstElementChild;
  document.querySelector('main .wrap').prepend(el);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.remove(), 6000);
  el.scrollIntoView({ block: 'nearest' });
}

/* =================================================================
   Views
   ================================================================= */

async function viewFeed() {
  let sort = new URLSearchParams(location.search).get('sort') || 'hot';
  if (!['hot', 'new', 'top'].includes(sort)) sort = 'hot';

  render('feed', `
    <div class="article">
      <div class="article__body">
        <p>
          Something changed in 2020 and it never changed back. Work, money, friends, health,
          how the days feel. Say what's different for you. Read what's different for other people.
        </p>
      </div>
      <a class="btn" href="/submit">Tell your story</a>
    </div>
    <div class="sorts">
      <button data-sort="hot" aria-pressed="${sort === 'hot'}">Talked about</button>
      <button data-sort="new" aria-pressed="${sort === 'new'}">Newest</button>
      <button data-sort="top" aria-pressed="${sort === 'top'}">Most "me too"</button>
      <span class="count" id="count"></span>
    </div>
    <ul class="feed" id="feed"></ul>
    <p class="loading" id="loading">Loading&hellip;</p>
  `);

  const feed = document.getElementById('feed');
  wireVoting(feed);

  document.querySelector('.sorts').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sort]');
    if (b) location.search = `?sort=${b.dataset.sort}`;
  });

  try {
    const data = await api(`/api/posts?sort=${sort}`);
    document.getElementById('loading').remove();
    document.getElementById('count').textContent = `${data.total} ${data.total === 1 ? 'story' : 'stories'}`;

    if (!data.posts.length) {
      feed.replaceWith(h(`
        <div class="empty">
          <h2>Nobody has posted yet.</h2>
          <p>Go first. It can be two sentences.</p>
          <a class="btn" href="/submit">Tell your story</a>
        </div>`));
      return;
    }
    feed.innerHTML = data.posts.map(itemMarkup).join('');
  } catch (err) {
    document.getElementById('loading').textContent = 'Could not load stories. Refresh to try again.';
  }
}

async function viewPost() {
  render('post', '<p class="loading">Loading&hellip;</p>');
  let data;
  try {
    data = await api(`/api/posts/${encodeURIComponent(BOOT.slug)}`);
  } catch {
    render('post', '<div class="empty"><h2>No such story.</h2><p>It may have been removed.</p><a class="btn btn--quiet" href="/">Back to stories</a></div>');
    return;
  }

  const p = data.post;

  render('post', `
  <article class="article" data-id="${p.id}" data-slug="${esc(p.slug)}">
    <p class="article__slug mono">
      ${promptLabel(p.desk)} &middot; ${esc(p.author)} &middot; ${ago(p.createdAt)}
    </p>
    <h2 class="article__head">${esc(p.headline)}</h2>
    <div class="article__body">${p.body ? esc(p.body).split('\n').filter(Boolean).map((x) => `<p>${x}</p>`).join('') : ''}</div>

    <div class="actionbar">
      <button class="metoo vote-up" aria-pressed="${p.myVote === 1}">
        <span class="metoo__label">Me too</span><span class="metoo__n num">${Math.max(0, p.ups)}</span>
      </button>
      <button class="btn btn--quiet share-link" type="button">Share</button>
      <button class="btn btn--quiet" id="report">Report</button>
    </div>

    <section class="comments">
      <h2>${data.comments.length} ${data.comments.length === 1 ? 'reply' : 'replies'}</h2>
      <div id="comment-list">${data.comments.map(commentMarkup).join('') || '<p class="empty-line">No replies yet. Say something back.</p>'}</div>
      <form class="form" id="comment-form" style="margin-top:1.5rem">
        <div class="field">
          <label for="c-body">Reply</label>
          <textarea id="c-body" name="body" required maxlength="1000" placeholder="Same for you? Different? Say so."></textarea>
        </div>
        <div class="field">
          <label for="c-author">Name <span class="hint">(optional, use any name you like)</span></label>
          <input type="text" id="c-author" name="author" maxlength="40" placeholder="Anonymous">
        </div>
        <button class="btn" type="submit">Post reply</button>
      </form>
    </section>
  </article>
  `);

  const article = document.querySelector('.article');
  wireVoting(article);

  document.getElementById('comment-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button');
    btn.disabled = true;
    try {
      const r = await api(`/api/posts/${p.id}/comments`, {
        method: 'POST',
        body: { body: f.body.value, author: f.author.value },
      });
      if (r.pending) {
        flash('Held for a quick look before it goes up.', true);
      } else {
        const list = document.getElementById('comment-list');
        if (list.querySelector('.empty-line')) list.innerHTML = '';
        list.insertAdjacentHTML('beforeend', commentMarkup(r.comment));
      }
      f.reset();
    } catch (err) { flash(err.message); }
    btn.disabled = false;
  });

  document.getElementById('report').addEventListener('click', async () => {
    const reason = prompt('What is wrong with this post?');
    if (reason === null) return;
    try {
      const r = await api('/api/report', { method: 'POST', body: { post_id: p.id, reason } });
      flash(r.message, true);
    } catch (err) { flash(err.message); }
  });
}

function commentMarkup(c) {
  return `<div class="comment">
    <p class="comment__meta mono">${esc(c.author)} &middot; ${ago(c.created_at)}</p>
    <p class="comment__body">${esc(c.body)}</p>
  </div>`;
}

/* ---------- submit ---------- */

function viewSubmit() {
  const preset = new URLSearchParams(location.search).get('about') || 'general';
  render('submit', `
    <div class="article">
      <p class="article__slug mono">Your story</p>
      <h2 class="article__head">What's different now?</h2>
      <p class="article__body">
        Doesn't have to be polished. Doesn't have to be long. Nobody will know it's you.
      </p>
    </div>
    <form class="form" id="submit-form">
      <div class="field">
        <label for="desk">It's about</label>
        <select id="desk" name="desk">
          ${PROMPTS.map((o) => `<option value="${o.value}" ${o.value === preset ? 'selected' : ''}>${o.label}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label for="headline">In one line</label>
        <input type="text" id="headline" name="headline" required minlength="10" maxlength="180"
               placeholder="I still don't go into the office and I'm not sure I ever will">
      </div>
      <div class="field">
        <label for="body">The rest of it</label>
        <textarea id="body" name="body" maxlength="1200"
                  placeholder="What it was like before, what it's like now, and what you make of that."></textarea>
      </div>
      <div class="field">
        <label for="author">Name <span class="hint">(optional, use any name you like)</span></label>
        <input type="text" id="author" name="author" maxlength="40" placeholder="Anonymous">
      </div>
      <p class="notice">
        Goes up as soon as you post it. Please don't include anyone's real name but your own.
      </p>
      <button class="btn" type="submit">Post it</button>
    </form>
  `);

  document.getElementById('submit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button');
    btn.disabled = true;
    try {
      const r = await api('/api/posts', {
        method: 'POST',
        body: {
          headline: f.headline.value, body: f.body.value,
          author: f.author.value, desk: f.desk.value,
        },
      });
      if (r.pending) {
        f.reset();
        flash(r.message, true);
      } else {
        location.href = `/p/${r.post.slug}`;
      }
    } catch (err) {
      flash(err.message);
      if (err.data?.slug) flash(`Someone already posted that exact line: /p/${err.data.slug}`);
    }
    btn.disabled = false;
  });
}

/* ---------- static pages ---------- */

function viewAbout() {
  render('about', `
    <div class="article">
      <p class="article__slug mono">About</p>
      <h2 class="article__head">Why this exists</h2>
      <div class="article__body">
        <p>
          Everyone agrees the pandemic ended. Fewer people agree that things went back to normal.
          Some of us work differently, spend differently, see friends less, trust less, or feel
          tired in a way that doesn't have a name yet. It's rarely said out loud because there's
          nowhere obvious to say it.
        </p>
        <p>This is somewhere to say it.</p>
        <p>
          <strong>Post</strong> what changed for you. <strong>Reply</strong> to other people's.
          Tap <strong>Me too</strong> when something lands. No accounts, no real names.
        </p>
        <p>
          Nothing here is medical advice, and nothing here is a study. It's people comparing notes.
          Questions or takedowns: <a href="mailto:ryan@hypnoticmindscapes.com">ryan@hypnoticmindscapes.com</a>.
        </p>
      </div>
    </div>`);
}

function viewTerms() {
  render('terms', `
    <div class="article">
      <p class="article__slug mono">Legal</p>
      <h2 class="article__head">Terms &amp; Privacy</h2>
      <div class="article__body">
        <p><strong>What this site is.</strong> A public board where people post their own experience
        of life after the pandemic, anonymously. Posts are personal accounts, not facts, and not advice.</p>

        <p><strong>What you may not post.</strong> Other people's real names or identifying details.
        Threats or calls for violence. Content sexualising minors. Personal information such as
        addresses, phone numbers, ID or account numbers. Spam and advertising.</p>

        <p><strong>Moderation.</strong> Posts publish immediately. Anything can be removed at any
        time for any reason. Reported items are reviewed by a human.</p>

        <p><strong>Takedowns.</strong> If something here names you or infringes your rights, write to
        the address below with a link and what is wrong with it. Removals are handled promptly.</p>

        <p class="mono" style="text-transform:none;letter-spacing:0;font-size:.9rem">
          ryan@hypnoticmindscapes.com
        </p>

        <p><strong>Privacy.</strong> The site sets one cookie: a random identifier so your "me too"
        sticks and you can't tap it twice. No accounts, no email addresses, no tracking or advertising
        pixels. Server logs hold IP addresses briefly for rate limiting.</p>
      </div>
    </div>`);
}

function viewNotFound() {
  render('notfound', `
    <div class="empty">
      <h2>No such page.</h2>
      <a class="btn btn--quiet" href="/">Back to stories</a>
    </div>`);
}

function viewError() {
  render('error', `
    <div class="empty">
      <h2>Something broke on our end.</h2>
      <p>Not your fault. Try again in a moment.</p>
      <a class="btn btn--quiet" href="/">Back to stories</a>
    </div>`);
}

/* ---------- admin ---------- */

async function viewAdmin() {
  const load = async () => {
    try { return await api('/api/admin/queue'); }
    catch { return null; }
  };

  let data = await load();

  if (!data) {
    render('admin', `
      <div class="article"><h2 class="article__head">Moderation</h2></div>
      <form class="form" id="login">
        <div class="field">
          <label for="key">Admin key</label>
          <input type="password" id="key" name="key" required autocomplete="current-password">
        </div>
        <button class="btn" type="submit">Sign in</button>
      </form>`);
    document.getElementById('login').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/admin/login', { method: 'POST', body: { key: e.target.key.value } });
        location.reload();
      } catch { flash('Wrong key.'); }
    });
    return;
  }

  const draw = () => {
    render('admin', `
      <div class="article">
        <p class="article__slug mono">${data.liveCount} live &middot; ${data.posts.length} pending &middot; ${data.reports.length} reports</p>
        <h2 class="article__head">Moderation</h2>
      </div>
      <div class="tabs" role="tablist">
        <button role="tab" aria-selected="true" data-tab="posts">Pending posts (${data.posts.length})</button>
        <button role="tab" aria-selected="false" data-tab="comments">Comments (${data.comments.length})</button>
        <button role="tab" aria-selected="false" data-tab="reports">Reports (${data.reports.length})</button>
      </div>
      <div id="panel"></div>`);

    const panel = document.getElementById('panel');
    const panels = {
      posts: () => data.posts.length
        ? data.posts.map((p) => `
          <div class="queue-item" data-id="${p.id}" data-kind="post">
            <h3>${esc(p.headline)}</h3>
            <p class="mono" style="color:var(--muted)">${esc(p.author)} &middot; ${esc(p.desk)} &middot; ${ago(p.createdAt)}</p>
            ${p.body ? `<p>${esc(p.body)}</p>` : ''}
            <div class="actions">
              <button class="btn" data-act="approve">Approve</button>
              <button class="btn btn--quiet" data-act="reject">Reject</button>
              <button class="btn btn--quiet" data-act="delete">Delete</button>
            </div>
          </div>`).join('')
        : '<p class="empty-line">Nothing waiting.</p>',
      comments: () => data.comments.length
        ? data.comments.map((c) => `
          <div class="queue-item" data-id="${c.id}" data-kind="comment">
            <h3>On &ldquo;${esc(c.headline)}&rdquo;</h3>
            <p>${esc(c.body)}</p>
            <p class="mono" style="color:var(--muted)">${esc(c.author)} &middot; ${ago(c.created_at)}</p>
            <div class="actions">
              <button class="btn" data-act="approve">Approve</button>
              <button class="btn btn--quiet" data-act="delete">Delete</button>
            </div>
          </div>`).join('')
        : '<p class="empty-line">Nothing held.</p>',
      reports: () => data.reports.length
        ? data.reports.map((r) => `
          <div class="queue-item">
            <h3>${r.slug ? `<a href="/p/${esc(r.slug)}">${esc(r.headline)}</a>` : 'Comment report'}</h3>
            <p>${esc(r.reason) || '<em>No reason given.</em>'}</p>
            <p class="mono" style="color:var(--muted)">${ago(r.created_at)}</p>
          </div>`).join('')
        : '<p class="empty-line">No reports.</p>',
    };

    panel.innerHTML = panels.posts();

    document.querySelector('.tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      document.querySelectorAll('[role=tab]').forEach((t) => t.setAttribute('aria-selected', String(t === b)));
      panel.innerHTML = panels[b.dataset.tab]();
    });

    panel.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const item = b.closest('[data-id]');
      const kind = item.dataset.kind === 'post' ? 'posts' : 'comments';
      b.disabled = true;
      try {
        await api(`/api/admin/${kind}/${item.dataset.id}/${b.dataset.act}`, { method: 'POST' });
        item.remove();
      } catch (err) { flash(err.message); b.disabled = false; }
    });
  };

  draw();
}

/* ---------- dispatch ---------- */

const VIEWS = {
  feed: viewFeed,
  post: viewPost,
  submit: viewSubmit,
  about: viewAbout,
  terms: viewTerms,
  admin: viewAdmin,
  notfound: viewNotFound,
  error: viewError,
};

(VIEWS[VIEW] || viewNotFound)();
