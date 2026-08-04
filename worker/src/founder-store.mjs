import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_STATE = { version: 1, founders: [] };

// Same atomic-JSON-file pattern as pipeline-store.mjs, keyed by profile_url instead of a
// provider-derived stable_id -- a founder already processed on a prior CSV import isn't
// re-researched (re-spending Firecrawl/OpenAI calls) on the next one.
export class FounderStore {
  constructor(filePath) { this.filePath = filePath; this.writeChain = Promise.resolve(); }
  async initialize() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try { await readFile(this.filePath, 'utf8'); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.#write(DEFAULT_STATE);
    }
  }
  async getByProfileUrl(profileUrl) {
    const state = await this.#read();
    return state.founders.find((founder) => founder.profile_url === profileUrl) || null;
  }
  async list() {
    const state = await this.#read();
    return state.founders.sort((left, right) => right.created_at.localeCompare(left.created_at));
  }
  async record(record) {
    return this.#mutate((state) => {
      const existing = state.founders.find((founder) => founder.profile_url === record.profile_url);
      const next = { ...(existing || { id: randomUUID(), created_at: new Date().toISOString() }), ...record, updated_at: new Date().toISOString() };
      if (existing) Object.assign(existing, next); else state.founders.push(next);
      return next;
    });
  }
  async #read() {
    const state = JSON.parse(await readFile(this.filePath, 'utf8'));
    if (!Array.isArray(state.founders)) throw new Error('founder store is invalid');
    return state;
  }
  async #mutate(operation) {
    const pending = this.writeChain.then(async () => { const state = await this.#read(); const result = operation(state); await this.#write(state); return result; });
    this.writeChain = pending.catch(() => undefined);
    return pending;
  }
  async #write(state) {
    const temporaryPath = join(dirname(this.filePath), `.founders-${randomUUID()}.tmp`);
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }
}
