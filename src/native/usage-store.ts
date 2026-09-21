import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CacheUsage, Provider, Tool } from '../core/types.ts';
import { normalizeUsage } from '../core/usage.ts';
import { atomicJsonWrite } from '../storage.ts';

const empty = (): CacheUsage => ({ totalInputTokens: null, cachedInputTokens: null, cacheWriteTokens: null, outputTokens: null });

export class UsageParser {
  private pending = '';
  private json = '';
  private mode: 'unknown' | 'sse' | 'json';
  private usage: CacheUsage = empty();
  private terminalSeen = false;
  private readonly provider: Provider;
  constructor(provider: Provider, contentType = '') { this.provider = provider; this.mode = /event-stream/i.test(contentType) ? 'sse' : /json/i.test(contentType) ? 'json' : 'unknown'; }
  get completed(): boolean { return this.terminalSeen; }
  push(chunk: Buffer): void {
    const text = chunk.toString('utf8');
    if (this.mode === 'unknown') {
      this.pending = (this.pending + text).slice(-262144);
      const probe = this.pending.trimStart();
      if ('event:'.startsWith(probe) || 'data:'.startsWith(probe)) return;
      this.mode = probe.startsWith('data:') || probe.startsWith('event:') ? 'sse' : 'json';
      if (this.mode === 'json') { this.json = this.pending.slice(-262144); this.pending = ''; return; }
    } else if (this.mode === 'sse') this.pending = (this.pending + text).slice(-262144);
    if (this.mode === 'json') { this.json = (this.json + text).slice(-262144); return; }
    let boundary;
    while ((boundary = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, boundary).trim();
      this.pending = this.pending.slice(boundary + 1);
      if (line.startsWith('data:')) this.inspect(line.slice(5).trim());
    }
  }
  private inspect(raw: string): void {
    try {
      const value = JSON.parse(raw) as Record<string, unknown>;
      if ((this.provider === 'openai' && value.type === 'response.completed')
        || (this.provider === 'anthropic' && value.type === 'message_stop')) this.terminalSeen = true;
      const response = value.response && typeof value.response === 'object' ? value.response as Record<string, unknown> : value;
      const message = value.message && typeof value.message === 'object' ? value.message as Record<string, unknown> : value;
      const candidate = response.usage ?? message.usage ?? value.usage;
      if (candidate) {
        const next = normalizeUsage(this.provider, candidate);
        this.usage = {
          totalInputTokens: next.totalInputTokens ?? this.usage.totalInputTokens,
          cachedInputTokens: next.cachedInputTokens ?? this.usage.cachedInputTokens,
          cacheWriteTokens: next.cacheWriteTokens ?? this.usage.cacheWriteTokens,
          outputTokens: next.outputTokens ?? this.usage.outputTokens,
        };
      }
    } catch { /* Incomplete/non-JSON SSE data is not usage. */ }
  }
  finish(): CacheUsage {
    if (this.mode === 'json') { this.inspect(this.json.trim()); this.json = ''; return { ...this.usage }; }
    const raw = this.pending.trim();
    if (raw) this.inspect(raw.startsWith('data:') ? raw.slice(5).trim() : raw);
    this.pending = '';
    return { ...this.usage };
  }
}

function safeId(id: string): string { return /^[a-zA-Z0-9_.:-]{1,256}$/.test(id) ? id : Buffer.from(id).toString('hex'); }

export class UsageStore {
  private readonly root: string;
  constructor(root: string) { this.root = root; }
  private file(tool: Tool, conversationId: string): string { return join(this.root, 'usage', `${tool}-${safeId(conversationId)}.json`); }
  async save(tool: Tool, conversationId: string, usage: CacheUsage): Promise<void> {
    await mkdir(join(this.root, 'usage'), { recursive: true, mode: 0o700 });
    await atomicJsonWrite(this.file(tool, conversationId), usage);
  }
  async load(tool: Tool, conversationId: string): Promise<CacheUsage | null> {
    try { return JSON.parse(await readFile(this.file(tool, conversationId), 'utf8')) as CacheUsage; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
}
