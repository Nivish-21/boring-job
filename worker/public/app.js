const queue = document.querySelector('#queue');
const template = document.querySelector('#item-template');
const refreshButton = document.querySelector('#refresh');

const formatDate = (value) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

const showMessage = (message, type = 'info') => {
  queue.replaceChildren();
  const panel = document.createElement('section');
  panel.className = `message message-${type}`;
  panel.textContent = message;
  queue.append(panel);
};

const decide = async (item, action, button) => {
  const reason = action === 'reject' ? window.prompt('Optional rejection reason:') : null;
  button.disabled = true;
  try {
    const response = await fetch(`/api/review/items/${item.id}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, approval_id: item.approval_id, actor: 'local-dashboard', reason })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Could not record the decision');
    await loadQueue();
  } catch (error) {
    button.disabled = false;
    window.alert(error.message);
  }
};

const renderItem = (item) => {
  const fragment = template.content.cloneNode(true);
  const article = fragment.querySelector('.review-item');
  fragment.querySelector('.item-meta').textContent = `${item.kind} · queued ${formatDate(item.created_at)}`;
  fragment.querySelector('h2').textContent = item.title;
  fragment.querySelector('.status').textContent = item.status;
  fragment.querySelector('.status').classList.add(`status-${item.status}`);
  fragment.querySelector('.summary').textContent = item.summary;
  fragment.querySelector('.source-link').href = item.source_url;
  const details = fragment.querySelector('.details');
  const fields = [['Source item', item.item_id], ['Fit score', item.fit_score === null ? null : `${item.fit_score}/10`], ['Expires', formatDate(item.expires_at)]];
  fields.filter(([, value]) => value).forEach(([label, value]) => {
    const term = document.createElement('dt');
    term.textContent = label;
    const definition = document.createElement('dd');
    definition.textContent = value;
    details.append(term, definition);
  });
  if (item.artifact_url) {
    const link = fragment.querySelector('.artifact-link');
    link.href = item.artifact_url;
    link.hidden = false;
  }
  if (item.draft) {
    fragment.querySelector('.draft-wrap').hidden = false;
    fragment.querySelector('.draft').textContent = item.draft;
  }
  if (item.evidence.length) {
    fragment.querySelector('.evidence-wrap').hidden = false;
    const list = fragment.querySelector('.evidence');
    item.evidence.forEach((entry) => {
      const row = document.createElement('li');
      const link = document.createElement('a');
      link.href = entry.url;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = entry.label;
      row.append(link);
      if (entry.note) row.append(` — ${entry.note}`);
      list.append(row);
    });
  }
  article.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => decide(item, button.dataset.action, button)));
  return fragment;
};

async function loadQueue() {
  queue.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch('/api/review/items?status=pending');
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Could not load the review queue');
    queue.replaceChildren();
    if (!payload.items.length) return showMessage('The review queue is clear. n8n can POST a prepared packet to /api/review/items when one is ready.');
    payload.items.forEach((item) => queue.append(renderItem(item)));
  } catch (error) {
    showMessage(error.message, 'error');
  } finally {
    queue.setAttribute('aria-busy', 'false');
  }
}

refreshButton.addEventListener('click', loadQueue);
loadQueue();
