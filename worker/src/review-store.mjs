import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_STATE = { version: 1, items: [] };

const asText = (value, field, { required = false, max = 4_000 } = {}) => {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${field} is required`);
    return null;
  }
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const text = value.trim();
  if (!text && required) throw new Error(`${field} is required`);
  if (text.length > max) throw new Error(`${field} must be at most ${max} characters`);
  return text || null;
};

const asUrl = (value) => {
  const text = asText(value, 'source_url', { required: true, max: 2_000 });
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
    return url.toString();
  } catch {
    throw new Error('source_url must be an http or https URL');
  }
};

const asNumber = (value, field, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be a number`);
  if (parsed < min || parsed > max) throw new Error(`${field} must be between ${min} and ${max}`);
  return parsed;
};

const normalizeEvidence = (value) => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 12) throw new Error('evidence must be an array with at most 12 entries');
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`evidence[${index}] must be an object`);
    return {
      label: asText(entry.label, `evidence[${index}].label`, { required: true, max: 160 }),
      url: asUrl(entry.url),
      note: asText(entry.note, `evidence[${index}].note`, { max: 800 })
    };
  });
};

export class ReviewStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.writeChain = Promise.resolve();
  }

  async initialize() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.#write(DEFAULT_STATE);
    }
  }

  async list({ status } = {}) {
    const state = await this.#read();
    const now = Date.now();
    return state.items
      .map((item) => {
        if (item.status !== 'pending') return item;
        if (Date.parse(item.expires_at) > now) return item;
        return { ...item, status: 'expired' };
      })
      .filter((item) => !status || item.status === status)
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  async create(input) {
    const kind = input?.kind === 'founder' ? 'founder' : input?.kind === 'job' ? 'job' : null;
    if (!kind) throw new Error('kind must be job or founder');

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 48 * 60 * 60 * 1_000).toISOString();
    const item = {
      id: randomUUID(),
      approval_id: randomUUID(),
      item_id: asText(input.item_id, 'item_id', { required: true, max: 200 }),
      kind,
      title: asText(input.title, 'title', { required: true, max: 240 }),
      source_url: asUrl(input.source_url),
      summary: asText(input.summary, 'summary', { required: true, max: 8_000 }),
      draft: asText(input.draft, 'draft', { max: 16_000 }),
      company_context: asText(input.company_context, 'company_context', { max: 1_200 }),
      talking_points: asText(input.talking_points, 'talking_points', { max: 2_000 }),
      artifact_url: input.artifact_url ? asUrl(input.artifact_url) : null,
      fit_score: asNumber(input.fit_score, 'fit_score', { min: 0, max: 10 }),
      evidence: normalizeEvidence(input.evidence),
      status: 'pending',
      expires_at: expiresAt,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      decisions: []
    };

    await this.#mutate((state) => {
      state.items.push(item);
      return item;
    });
    return item;
  }

  async decide(id, input) {
    const action = input?.action;
    if (!['approve', 'reject', 'regenerate', 'skip'].includes(action)) {
      throw new Error('action must be approve, reject, regenerate, or skip');
    }
    const approvalId = asText(input.approval_id, 'approval_id', { required: true, max: 200 });
    const actor = asText(input.actor, 'actor', { max: 160 }) || 'local-reviewer';
    const reason = asText(input.reason, 'reason', { max: 1_000 });

    return this.#mutate((state) => {
      const item = state.items.find((entry) => entry.id === id);
      if (!item) throw new Error('review item not found');
      if (item.status !== 'pending') throw new Error('review item has already been decided');
      if (item.approval_id !== approvalId) throw new Error('approval_id does not match this review item');
      if (new Date(item.expires_at) <= new Date()) {
        throw new Error('review item has expired');
      }

      const now = new Date().toISOString();
      item.status = action === 'approve' ? 'approved' : action === 'regenerate' ? 'pending' : 'rejected';
      if (action !== 'regenerate') item.approval_id = null;
      item.updated_at = now;
      item.decisions.push({ action, actor, reason, at: now });
      return item;
    });
  }

  async #read() {
    const raw = await readFile(this.filePath, 'utf8');
    const state = JSON.parse(raw);
    if (!Array.isArray(state.items)) throw new Error('review store is invalid');
    return state;
  }

  async #mutate(operation) {
    const pending = this.writeChain.then(async () => {
      const state = await this.#read();
      const result = operation(state);
      await this.#write(state);
      return result;
    });
    this.writeChain = pending.catch(() => undefined);
    return pending;
  }

  async #write(state) {
    const temporaryPath = join(dirname(this.filePath), `.review-items-${randomUUID()}.tmp`);
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }
}
