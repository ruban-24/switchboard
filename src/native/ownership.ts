import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Tool } from '../core/types.ts';

export class OwnershipCollisionError extends Error {
  constructor() {
    super('Conversation is already owned by another router process; stop the other process or remove its lock after verifying it is no longer running');
    this.name = 'OwnershipCollisionError';
  }
}

export class Ownership {
  private readonly held = new Map<string, string>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly root: string;
  private readonly owner: string;
  constructor(root: string, owner: string) { this.root = root; this.owner = owner; }

  private file(tool: Tool, conversationId: string): string {
    const key = createHash('sha256').update(`${tool}:${conversationId}`).digest('hex');
    return join(this.root, 'native-locks', `${key}.lock`);
  }

  async acquire(tool: Tool, conversationId: string): Promise<void> {
    const file = this.file(tool, conversationId);
    if (this.held.has(file)) return;
    const existing = this.pending.get(file);
    if (existing) return existing;
    const acquisition = this.acquireFile(file);
    this.pending.set(file, acquisition);
    try { await acquisition; } finally { if (this.pending.get(file) === acquisition) this.pending.delete(file); }
  }

  private async acquireFile(file: string): Promise<void> {
    await mkdir(join(this.root, 'native-locks'), { recursive: true, mode: 0o700 });
    let handle;
    try { handle = await open(file, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new OwnershipCollisionError();
      throw error;
    }
    const marker = JSON.stringify({ owner: this.owner, pid: process.pid });
    try { await handle.writeFile(marker); await handle.sync(); }
    finally { await handle.close(); }
    this.held.set(file, marker);
  }

  async close(): Promise<void> {
    await Promise.all([...this.held].map(async ([file, marker]) => {
      try { if (await readFile(file, 'utf8') === marker) await rm(file); } catch { /* Retain unknown/replaced locks. */ }
    }));
    this.held.clear();
  }
}
