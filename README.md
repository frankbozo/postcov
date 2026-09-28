# postcov

Life after COVID. It's not the same. An anonymous board where people say what
changed for them, reply to each other, and tap "me too."

Built from the same engine as canyoutrumpthetrump.com: Node 22, Express, Postgres,
no framework, no build step. Posts publish instantly. A small tripwire holds anything
shaped like a threat, a Social Security number or a card number for review.

## Run it locally

```
npm install
cp .env.example .env     # fill in DATABASE_URL
npm run dev
```

## Deploy (Render + Neon)

1. Create a Postgres project on neon.tech and copy the connection string.
2. Push this repo to GitHub.
3. On render.com, New > Blueprint, pick the repo. `render.yaml` sets everything up.
4. In the Render service, Environment: paste the Neon string as `DATABASE_URL`, set
   `SITE_ORIGIN` to `https://postcov.com`. `ADMIN_KEY` is generated for you; copy it.
5. Settings > Custom Domains > add `postcov.com` and follow the DNS instructions in
   GoDaddy (a CNAME for www and an A record or ALIAS for the root).
6. Optional email alerts: set `RESEND_API_KEY` and `NOTIFY_TO`.

## Moderation

Sign in at `/admin` with `ADMIN_KEY`. Pending posts (tripwire hits only), held
comments and reports live there. Set `REVIEW_ALL=true` in Render to hold every
post for review instead.

## Bulk import

`POST /api/admin/import` with `{ "posts": [ { "headline", "body", "author", "desk" } ] }`
while signed in, or `npm run seed` against `seed.json`. `desk` is one of: general,
work, money, health, people, kids, miss, dontmiss.

## Layout

```
src/
  server.js    routes, moderation, admin
  db.js        schema and migrations
  lib.js       cookies, rate limits, scoring, content tripwire
  views.js     HTML shell and share metadata
  notify.js    email alerts via Resend
  seed.js      seed loader
public/
  app.js       the whole front end
  styles.css
test/          node --test
```
