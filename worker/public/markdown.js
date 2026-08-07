// Renders the small markdown vocabulary packetDraft() actually emits (job-pipeline.mjs):
// #/##/### headers, "- " bullet lists, and blank-line-separated paragraphs. Nothing else --
// no tables/links/images/bold, since packetDraft() never produces them and handling syntax
// that never appears is speculative surface area. Founder-outreach drafts are plain prose with
// no markdown syntax, so running them through this is a safe no-op (renders as one paragraph).
const escapeHtml = (text) => text
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const HEADER_PATTERN = /^(#{1,3})\s+(.*)$/;
const BULLET_PATTERN = /^-\s+(.*)$/;

export const renderDraftMarkdown = (text) => {
  const lines = String(text ?? '').split('\n');
  const html = [];
  let listItems = null;

  const flushList = () => {
    if (listItems) {
      html.push(`<ul>${listItems.join('')}</ul>`);
      listItems = null;
    }
  };

  let paragraph = [];
  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${paragraph.join(' ')}</p>`);
      paragraph = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const headerMatch = line.match(HEADER_PATTERN);
    const bulletMatch = line.match(BULLET_PATTERN);

    if (headerMatch) {
      flushParagraph();
      flushList();
      const level = headerMatch[1].length;
      html.push(`<h${level}>${escapeHtml(headerMatch[2])}</h${level}>`);
    } else if (bulletMatch) {
      flushParagraph();
      listItems = listItems || [];
      listItems.push(`<li>${escapeHtml(bulletMatch[1])}</li>`);
    } else if (line === '') {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(escapeHtml(line));
    }
  }
  flushParagraph();
  flushList();

  return html.join('');
};
