import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_STATE = { version: 1, jobs: [] };

export class PipelineStore {
  constructor(filePath) { this.filePath = filePath; this.writeChain = Promise.resolve(); }
  async initialize() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try { await readFile(this.filePath, 'utf8'); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.#write(DEFAULT_STATE);
    }
  }
  async getByStableId(stableId) {
    const state = await this.#read();
    return state.jobs.find((job) => job.stable_id === stableId) || null;
  }
  async record(record) {
    return this.#mutate((state) => {
      const existing = state.jobs.find((job) => job.stable_id === record.stable_id);
      const next = { ...(existing || { id: randomUUID(), created_at: new Date().toISOString() }), ...record, updated_at: new Date().toISOString() };
      if (existing) Object.assign(existing, next); else state.jobs.push(next);
      return next;
    });
  }
  async #read() {
    const state = JSON.parse(await readFile(this.filePath, 'utf8'));
    if (!Array.isArray(state.jobs)) throw new Error('pipeline store is invalid');
    return state;
  }
  async #mutate(operation) {
    const pending = this.writeChain.then(async () => { const state = await this.#read(); const result = operation(state); await this.#write(state); return result; });
    this.writeChain = pending.catch(() => undefined);
    return pending;
  }
  async #write(state) {
    const temporaryPath = join(dirname(this.filePath), `.pipeline-${randomUUID()}.tmp`);
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }
}
