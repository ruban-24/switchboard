// Claude supplies session JSON on stdin. This helper only reads local routing
// state; it never sends requests or persists the status payload.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { Store } from '../storage.ts';
import { AUTO_MODEL } from './protocol.ts';

const inputLimit = 1024 * 1024;
const outputLimit = 64 * 1024;
const color = process.env.NO_COLOR === undefined;
const reset = color ? '\x1b[0m' : '';
const dim = color ? '\x1b[2m' : '';
const brand = `${reset}${color ? '\x1b[1;36m' : ''}Switchboard${reset}`;
const separator = ` ${dim}·${reset} `;
const waiting = `${brand}${separator}${dim}waiting for first prompt${reset}`;
const unavailable = `${brand}${separator}${dim}status unavailable${reset}`;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function label(value: unknown): string {
  if (typeof value !== 'string') return '';
  // Strip escape sequences, controls and directional marks from our labels.
  // The user's own status output is kept byte-for-byte below.
  return value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim().slice(0, 100);
}

function selected(model: unknown, effort: unknown, mode: string): string {
  const effortLabel = effort === null ? 'no effort' : label(effort) ? `${label(effort)} effort` : 'effort unknown';
  return [brand, label(model) || 'unknown model', effortLabel, `${dim}${mode}${reset}`].join(separator);
}

async function routingLine(input: Buffer, directory: string): Promise<string> {
  try {
    const payload = object(JSON.parse(input.toString('utf8')));
    const model = object(payload.model).id;
    if (typeof model === 'string' && model.trim() && model !== AUTO_MODEL) {
      return selected(model, object(payload.effort).level, 'manual');
    }
    const id = payload.session_id;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(id)) return unavailable;
    const state = await new Store(directory).load('claude', id);
    if (!state) return waiting;
    const reason = state.lastDecision.reason;
    const mode = state.manual || reason === 'manual' ? 'manual'
      : ['classifier-unavailable', 'uncertain'].includes(reason) || state.selection.excludedModel ? 'fallback'
      : ['pinned', 'tool-continuation'].includes(reason) ? 'pinned' : 'auto';
    return selected(state.selection.model, state.selection.effort, mode);
  } catch { return unavailable; }
}

let stopChild = () => {};
async function existingOutput(command: string | undefined, input: Buffer): Promise<Buffer> {
  if (!command) return Buffer.alloc(0);
  const env = { ...process.env };
  for (const key of ['OPENROUTER_API_KEY', 'SWITCHBOARD_API_KEY', 'JEV_API_KEY', 'TYPESAFE_API_KEY', 'AI_GATEWAY_API_KEY']) delete env[key];
  return new Promise(resolve => {
    // A detached process group lets the deadline also stop pipelines and child
    // processes. Preserve the inherited working directory and original stdin.
    const child = spawn('/bin/sh', ['-c', command], { env, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;
    const stop = () => {
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    };
    stopChild = stop;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      stop();
      child.stdin.destroy();
      child.stdout.destroy();
      resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(finish, 1000);
    child.stdout.on('data', (chunk: Buffer) => {
      const remaining = outputLimit - size;
      chunks.push(chunk.subarray(0, remaining));
      size += Math.min(chunk.length, remaining);
      if (size >= outputLimit) finish();
    });
    child.stdin.on('error', () => {});
    child.on('error', finish);
    child.on('close', finish);
    child.stdin.end(input);
  });
}

let outputWritten = false;
function output(previous: Buffer, line: string) {
  if (outputWritten) return;
  outputWritten = true;
  process.stdout.write(Buffer.concat([previous, Buffer.from(`${previous.length && previous.at(-1) !== 10 ? '\n' : ''}${line}\n`)]));
}

const deadline = setTimeout(() => {
  stopChild();
  output(Buffer.alloc(0), unavailable);
  process.stdout.end(() => process.exit(0));
}, 2000);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, () => { stopChild(); process.exit(0); });
process.stdout.on('error', () => { stopChild(); process.exit(0); });

try {
  const config = object(JSON.parse(await readFile(process.argv[2] ?? '', 'utf8')));
  if (typeof config.stateDirectory !== 'string' || !config.stateDirectory) throw new Error();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > inputLimit) throw new Error();
    chunks.push(bytes);
  }
  const input = Buffer.concat(chunks);
  const [previous, line] = await Promise.all([
    existingOutput(typeof config.command === 'string' ? config.command : undefined, input),
    routingLine(input, config.stateDirectory),
  ]);
  output(previous, line);
} catch { output(Buffer.alloc(0), unavailable); }
finally { clearTimeout(deadline); }
