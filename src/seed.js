/**
 * Seed content.
 *
 * Two ways in:
 *   - automatically, on the server's first boot against an empty database
 *     (see autoSeed in db.js) — this is what happens on a fresh deploy
 *   - manually, with `npm run seed`, if you have a terminal and want to
 *     top up an existing site
 *
 * seed.json is an array of objects:
 *   [
 *     {
 *       "headline": "...",          // required, 10+ characters
 *       "body": "...",              // optional supporting text
 *       "author": "...",            // optional byline
 *       "desk": "general"           // general | economy | foreign | interior | ceremonial | justice
 *     }
 *   ]
 *
 * Re-running is safe either way: a headline already on file is skipped, not
 * duplicated. Seeded posts go straight to live, bypassing the review queue —
 * this is your own content, so that's the point.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { q } from './db.js';
import { slugify } from './lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SEED_FILE = path.join(__dirname, '..', 'seed.json');

/** Insert everything in `file` that isn't already on file. Returns the count added. */
export async function loadSeed(file = DEFAULT_SEED_FILE) {
  const rows = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!Array.isArray(rows)) throw new Error('seed.json must contain an array');
  return insertRows(rows);
}

/**
 * Insert an array of seed-shaped rows straight to live, skipping any
 * headline already on file. Shared by the seed file and the admin bulk
 * import. Returns the count added.
 */
export async function insertRows(rows) {
  let added = 0;
  for (const row of rows) {
    const headline = String(row.headline || row.now || '').trim().slice(0, 180);
    if (headline.length < 5) continue;

    const exists = await q('SELECT 1 FROM posts WHERE lower(headline) = lower($1)', [headline]);
    if (exists.rows.length) continue;

    await q(
      `INSERT INTO posts (slug, headline, body, author, desk, status, then_text, now_text, when_label, place)
       VALUES ($1,$2,$3,$4,$5,'live',$6,$7,$8,$9)`,
      [
        slugify(headline),
        headline,
        String(row.body || '').trim(),
        String(row.author || 'Anonymous').trim().slice(0, 40),
        String(row.desk || 'general').trim().slice(0, 32),
        String(row.then || '').trim().slice(0, 300),
        String(row.now || '').trim().slice(0, 300),
        String(row.when || '').trim().slice(0, 40),
        String(row.place || '').trim().slice(0, 60),
      ],
    );
    added += 1;
  }
  return added;
}

/* --- CLI entry point: `npm run seed` --- */

const isCli = process.argv[1] && process.argv[1].endsWith('seed.js');

if (isCli) {
  const { migrate, pool } = await import('./db.js');
  const file = process.argv[2] || DEFAULT_SEED_FILE;
  try {
    await migrate();
    const added = await loadSeed(file);
    console.log(
      added
        ? `Seeded ${added} proposal(s). Anything already on file was skipped.`
        : 'Nothing new to add — every proposal in seed.json is already on file.',
    );
  } catch (e) {
    console.error(`Could not seed from ${file}:`, e.message);
    process.exitCode = 1;
  }
  await pool.end();
}
