import assert from 'node:assert/strict';
import test from 'node:test';
import { renderDraftMarkdown } from '../public/markdown.js';

test('renderDraftMarkdown renders headers at their level', () => {
  const html = renderDraftMarkdown('# Application packet — Engineer\n\n## Verified job evidence');
  assert.equal(html, '<h1>Application packet — Engineer</h1><h2>Verified job evidence</h2>');
});

test('renderDraftMarkdown groups consecutive bullet lines into one list', () => {
  const html = renderDraftMarkdown('- Source: https://example.com\n- Location: Remote');
  assert.equal(html, '<ul><li>Source: https://example.com</li><li>Location: Remote</li></ul>');
});

test('renderDraftMarkdown separates paragraphs on blank lines and joins wrapped lines with a space', () => {
  const html = renderDraftMarkdown('Hello hiring team,\n\nI am interested in the role.');
  assert.equal(html, '<p>Hello hiring team,</p><p>I am interested in the role.</p>');
});

test('renderDraftMarkdown HTML-escapes text content to prevent injected markup', () => {
  const html = renderDraftMarkdown('# <script>alert(1)</script>\n\n- "quoted" & <b>bold</b>');
  assert.equal(html, '<h1>&lt;script&gt;alert(1)&lt;/script&gt;</h1><ul><li>&quot;quoted&quot; &amp; &lt;b&gt;bold&lt;/b&gt;</li></ul>');
});

test('renderDraftMarkdown renders plain prose (founder-message case) as a single paragraph', () => {
  const html = renderDraftMarkdown('Hi Jane, loved your post on distributed systems. Would you be open to a quick chat?');
  assert.equal(html, '<p>Hi Jane, loved your post on distributed systems. Would you be open to a quick chat?</p>');
});

test('renderDraftMarkdown handles a full mixed document like packetDraft() produces', () => {
  const draft = '# Application packet — Backend Engineer\n\nStatus: needs_review\n\n## Candidate facts supplied for this draft\n\n- Built Node.js production systems.\n- Works with Docker and PostgreSQL.\n\n## Draft note\n\nHello hiring team,\n\nBest,\nNivish\n';
  const html = renderDraftMarkdown(draft);
  assert.equal(
    html,
    '<h1>Application packet — Backend Engineer</h1><p>Status: needs_review</p><h2>Candidate facts supplied for this draft</h2><ul><li>Built Node.js production systems.</li><li>Works with Docker and PostgreSQL.</li></ul><h2>Draft note</h2><p>Hello hiring team,</p><p>Best, Nivish</p>'
  );
});
