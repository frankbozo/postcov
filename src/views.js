import { escapeHtml } from './lib.js';

// Bump on every deploy that touches public/ so browsers drop their cached copy.
const ASSET_VERSION = '2026-09-28a';

const DEFAULT_TITLE = 'postcov';
const DEFAULT_DESC =
  "Life after COVID. It's not the same. People saying what changed, anonymously.";

export function shell({ view, origin = '', meta = {}, bootstrap = {} }) {
  const title = meta.title || DEFAULT_TITLE;
  const description = meta.description || DEFAULT_DESC;
  const url = meta.url || origin || '';
  const image = `${origin}/og-default.png`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${escapeHtml(url)}">

<meta property="og:site_name" content="postcov">
<meta property="og:type" content="article">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(url)}">
<meta property="og:image" content="${escapeHtml(image)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${escapeHtml(image)}">

<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/styles.css?v=${ASSET_VERSION}">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div id="app" data-view="${escapeHtml(view)}"></div>
<script id="bootstrap" type="application/json">${JSON.stringify(bootstrap).replace(/</g, '\\u003c')}</script>
<script src="/app.js?v=${ASSET_VERSION}" type="module"></script>
</body>
</html>`;
}
