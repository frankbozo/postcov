import test from 'node:test';
import assert from 'node:assert/strict';

import { shell } from '../src/views.js';

test('shell renders a complete document', () => {
  const html = shell({ view: 'feed', origin: 'https://example.com' });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /data-view="feed"/);
  assert.match(html, /<script src="\/app\.js\?v=[^"]+" type="module">/);
});

test('a hostile headline cannot break out of the meta tags', () => {
  const html = shell({
    view: 'post',
    origin: 'https://example.com',
    meta: {
      title: '"><script>alert(1)</script>',
      description: "</title><img src=x onerror=alert(1)>'",
      url: 'https://example.com/p/"onload="alert(1)',
    },
  });
  // The payload text itself may well appear -- `onerror=alert(1)` is only
  // dangerous inside a tag. What must not appear is an actual tag, or a
  // quote that ends an attribute early.
  const head = html.slice(0, html.indexOf('</head>'));
  assert.ok(!head.includes('<script>'), 'no injected script element');
  assert.ok(!head.includes('<img'), 'no injected img element');
  assert.match(html, /&lt;script&gt;/, 'the payload survives, escaped');

  // Every attribute in <head> must be a balanced, quoted pair: an odd count
  // of quotes on a line is exactly what a break-out looks like.
  for (const line of head.split('\n')) {
    if (!line.includes('content=') && !line.includes('href=')) continue;
    assert.equal((line.match(/"/g) || []).length % 2, 0, `unbalanced quotes: ${line}`);
  }
});

// The bootstrap payload is user-influenced (a post slug) and lands inside a
// <script> element, where the parser ends the block at the first `</` it sees
// regardless of JSON quoting.
test('bootstrap data cannot close its own script tag', () => {
  const html = shell({
    view: 'post',
    bootstrap: { slug: '</script><script>alert(1)</script>' },
  });
  const tag = html.slice(html.indexOf('<script id="bootstrap"'));
  const block = tag.slice(0, tag.indexOf('</script>'));
  assert.ok(!block.includes('</script'), 'the payload must not terminate the block early');
  assert.ok(block.includes('\\u003c'), 'every < is escaped');

  // And it must still be the data the client expects to parse back out.
  const json = block.slice(block.indexOf('>') + 1);
  assert.equal(JSON.parse(json).slug, '</script><script>alert(1)</script>');
});

test('shell falls back to the site defaults when no meta is given', () => {
  const html = shell({ view: 'feed' });
  assert.match(html, /<title>postcov<\/title>/);
  assert.match(html, /og:site_name/);
});
