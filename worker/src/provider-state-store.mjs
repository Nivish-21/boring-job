import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_STATE = { version: 1, providers: {} };

export class ProviderStateStore {
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

  async isEnabled(provider) {
    const state = await this.#read();
    const entry = state.providers[provider];
    if (!entry || entry.status !== 'disabled') return true;
    if (entry.disabled_until && Date.parse(entry.disabled_until) <= Date.now()) return true;
    return false;
  }

  async recordSuccess(provider) {
    return this.#mutate((state) => {
      state.providers[provider] = {
        status: 'enabled',
        disabled_until: null,
        failure_count: 0,
        last_error: null,
        updated_at: new Date().toISOString()
      };
      return state.providers[provider];
    });
  }

  async recordFailure(provider, { errorType, message, cooldownMs = null } = {}) {
    return this.#mutate((state) => {
      const existing = state.providers[provider];
      const failureCount = (existing?.failure_count || 0) + 1;
      const now = new Date();
      state.providers[provider] = {
        status: 'disabled',
        disabled_until: typeof cooldownMs === 'number' ? new Date(now.getTime() + cooldownMs).toISOString() : null,
        failure_count: failureCount,
        last_error: { errorType: errorType || 'unknown', message: message || null, at: now.toISOString() },
        updated_at: now.toISOString()
      };
      return state.providers[provider];
    });
  }

  async #read() {
    const raw = await readFile(this.filePath, 'utf8');
    const state = JSON.parse(raw);
    if (!state.providers || typeof state.providers !== 'object') throw new Error('provider state store is invalid');
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
    const temporaryPath = join(dirname(this.filePath), `.provider-state-${randomUUID()}.tmp`);
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }
}
