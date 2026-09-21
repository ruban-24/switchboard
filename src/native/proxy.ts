import http from 'node:http';
import https from 'node:https';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { CacheUsage, Catalog, Classifier, Decision, Policy, Selection, Tool } from '../core/types.ts';
import { Router } from '../core/session.ts';
import { selectInitialRoute } from '../core/policy.ts';
import { Store } from '../storage.ts';
import { Ownership, OwnershipCollisionError } from './ownership.ts';
import { applyRoute, claudeConversationSignature, claudeUserTextBlocks, hasPriorConversation, normalizeMatchText, parseNativeRequest, TOKEN_HEADER } from './protocol.ts';
import { UsageParser, UsageStore } from './usage-store.ts';
import { DecisionStream } from './decision-stream.ts';

export { AUTO_MODEL, TOKEN_ENV, TOKEN_HEADER } from './protocol.ts';

export interface ProxyOptions {
  tool: Tool;
  root: string;
  policy: Policy;
  catalog: Catalog;
  classify: Classifier;
  onDecision?: (decision: Decision) => void;
  upstreams?: { claude?: string; codexApi?: string; codexSubscription?: string };
  maxBodyBytes?: number;
}

export interface ProxyHandle { url: string; token: string; close(): Promise<void>; }

const defaults = { claude: 'https://api.anthropic.com', codexApi: 'https://api.openai.com/v1', codexSubscription: 'https://chatgpt.com/backend-api/codex' };
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length', TOKEN_HEADER]);

function cleanHeaders(headers: http.IncomingHttpHeaders): Headers {
  const result = new Headers();
  const nominated = new Set(String(headers.connection ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
  for (const [name, value] of Object.entries(headers)) {
    if (hopHeaders.has(name.toLowerCase()) || nominated.has(name.toLowerCase()) || value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) result.append(name, item); else result.set(name, value);
  }
  return result;
}

async function forward(target: URL, method: string, incoming: http.IncomingHttpHeaders, body: Buffer, response: http.ServerResponse, signal: AbortSignal, usage: UsageParser, saveUsage?: (usage: CacheUsage) => Promise<void>, decision?: Decision): Promise<boolean> {
  signal.throwIfAborted();
  let completed = false;
  let successful = false;
  try { return await new Promise<boolean>((resolve, reject) => {
    const transport = target.protocol === 'http:' ? http : https;
    const headers: Record<string, string | string[]> = {};
    cleanHeaders(incoming).forEach((value, name) => { headers[name] = value; });
    // Node's HTTP transport does not decompress responses. Negotiate plaintext
    // streams so usage can be observed without buffering or rewriting content.
    headers['accept-encoding'] = 'identity';
    if (body.length) headers['content-length'] = String(body.length);
    headers.connection = 'close';
    const upstreamRequest = transport.request(target, { method, headers }, upstreamResponse => {
      successful = (upstreamResponse.statusCode ?? 502) >= 200 && (upstreamResponse.statusCode ?? 502) < 300;
      // Subscription responses can omit content-type. DecisionStream verifies
      // the actual response.created SSE frame before inserting anything.
      const display = successful && decision ? new DecisionStream(decision) : undefined;
      const outgoing: Record<string, string | string[]> = {};
      const nominated = new Set(String(upstreamResponse.headers.connection ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
      for (const [name, value] of Object.entries(upstreamResponse.headers)) if (!hopHeaders.has(name.toLowerCase()) && !nominated.has(name.toLowerCase()) && value !== undefined) outgoing[name] = value;
      outgoing.connection = 'close';
      response.writeHead(upstreamResponse.statusCode ?? 502, outgoing);
      upstreamResponse.on('data', (chunk: Buffer) => {
        usage.push(chunk);
        const forwarded = display ? display.push(chunk) : chunk;
        if (forwarded.length && !response.write(forwarded)) {
          upstreamResponse.pause();
          response.once('drain', () => upstreamResponse.resume());
        }
      });
      upstreamResponse.on('end', () => { if (display) response.write(display.finish()); completed = true; resolve(successful); });
      upstreamResponse.on('error', reject);
      response.on('close', () => { if (!completed) upstreamRequest.destroy(new Error('Native client disconnected')); });
    });
    upstreamRequest.on('error', reject);
    signal.addEventListener('abort', () => upstreamRequest.destroy(signal.reason), { once: true });
    upstreamRequest.end(body);
  }); } finally {
    const observed = usage.finish();
    // Native clients may disconnect after the terminal SSE event but before HTTP
    // EOF. Preserve its counters while draining shutdown; partial/error streams
    // must not overwrite the last successful observation.
    if (saveUsage && successful && (completed || usage.completed)) await saveUsage(observed);
  }
}

async function bodyOf(request: http.IncomingMessage, limit: number, signal: AbortSignal): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const cleanup = () => { request.off('data', onData); request.off('end', onEnd); request.off('error', onError); signal.removeEventListener('abort', onAbort); };
    const onData = (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      size += chunk.length;
      if (size <= limit) { chunks.push(chunk); return; }
      settled = true; cleanup(); request.resume();
      reject(new SafeError(413, 'Request body exceeds the configured limit'));
    };
    const onEnd = () => { if (!settled) { settled = true; cleanup(); resolve(Buffer.concat(chunks)); } };
    const onError = (error: Error) => { if (!settled) { settled = true; cleanup(); reject(error); } };
    const onAbort = () => { if (!settled) { settled = true; cleanup(); request.destroy(); reject(signal.reason); } };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    request.on('data', onData); request.on('end', onEnd); request.on('error', onError);
  });
}

class SafeError extends Error { readonly status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
type PromptHook = { promptId: string; prompt: string; digest: string };
type ConsumedPrompt = Pick<PromptHook, 'promptId' | 'prompt'>;

function jsonError(response: http.ServerResponse, status: number, message: string): void {
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
  response.end(JSON.stringify({ error: { type: 'router_error', message } }));
}

function upstreamFor(options: ProxyOptions, headers: http.IncomingHttpHeaders): string {
  const configured = { ...defaults, ...options.upstreams };
  if (options.tool === 'claude') return configured.claude;
  return headers['chatgpt-account-id'] ? configured.codexSubscription : configured.codexApi;
}

function targetUrl(base: string, incomingPath: string): URL {
  const target = new URL(base);
  const basePath = target.pathname.replace(/\/$/, '');
  const incoming = new URL(incomingPath, 'http://loopback');
  target.pathname = `${basePath}${incoming.pathname}`.replace(/\/+/g, '/');
  target.search = incoming.search;
  return target;
}

function fallback(policy: Policy, catalog: Catalog, tool: Tool): Selection { return selectInitialRoute(policy, catalog, tool, null); }

function titleRoute(policy: Policy, catalog: Catalog, tool: Tool): Selection {
  // Deterministic helper policy, not a Jev result; never stored as a user decision.
  return selectInitialRoute(policy, catalog, tool, { taskType: 'other', complexity: 'routine', reasoning: 'low',
    sufficientContext: true, confidences: { model: 1, effort: 1, context: 1, taskType: 1 } });
}

export async function startProxy(options: ProxyOptions): Promise<ProxyHandle> {
  const token = randomBytes(32).toString('base64url');
  const repository = new Store(options.root, { historyLimit: options.policy.history.limit, capturePrompts: options.policy.history.capturePrompts });
  const router = new Router({ policy: options.policy, catalog: options.catalog, repository, classify: options.classify });
  const ownership = new Ownership(options.root, randomUUID());
  const usageStore = new UsageStore(options.root);
  const pendingHooks = new Map<string, PromptHook[]>();
  const consumed = new Map<string, Map<string, ConsumedPrompt>>();
  const sessionStarts = new Map<string, 'fresh' | 'resume'>();
  const active = new Set<AbortController>();
  const inFlight = new Set<Promise<void>>();
  const maxBodyBytes = options.maxBodyBytes ?? 16 * 1024 * 1024;

  const server = http.createServer(async (request, response) => {
    let finishHandler!: () => void;
    const handlerDone = new Promise<void>(resolve => { finishHandler = resolve; });
    inFlight.add(handlerDone);
    const abort = new AbortController();
    active.add(abort);
    const disconnect = () => { if (!response.writableFinished) abort.abort(new Error('Native client disconnected')); };
    request.on('aborted', disconnect);
    response.on('error', disconnect);
    response.on('close', disconnect);
    try {
      if (request.headers[TOKEN_HEADER] !== token) return jsonError(response, 401, 'Missing or invalid router token');
      const raw = await bodyOf(request, maxBodyBytes, abort.signal);
      if (request.method === 'POST' && request.url === '/_router/session') {
        if (options.tool !== 'claude') return jsonError(response, 404, 'Hook endpoint is available only for Claude');
        let hook: Record<string, unknown>;
        try { hook = JSON.parse(raw.toString('utf8')) as Record<string, unknown>; } catch { throw new SafeError(400, 'Hook body must be valid JSON'); }
        if (!hook || Array.isArray(hook) || typeof hook.session_id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(hook.session_id)
          || typeof hook.source !== 'string' || !['startup', 'clear', 'resume', 'compact', 'fork'].includes(hook.source)) throw new SafeError(400, 'Session hook requires a bounded session_id and supported source');
        if (!sessionStarts.has(hook.session_id) && sessionStarts.size >= 128) sessionStarts.delete(sessionStarts.keys().next().value!);
        // Delayed/repeated lifecycle delivery cannot turn a resumed identity
        // into a fresh conversation. /clear supplies a new session identity.
        const resumed = sessionStarts.get(hook.session_id) === 'resume' || !['startup', 'clear'].includes(hook.source);
        sessionStarts.set(hook.session_id, resumed ? 'resume' : 'fresh');
        response.writeHead(204); response.end(); return;
      }
      if (request.method === 'POST' && request.url === '/_router/turn') {
        if (options.tool !== 'claude') return jsonError(response, 404, 'Hook endpoint is available only for Claude');
        let hook: Record<string, unknown>;
        try { hook = JSON.parse(raw.toString('utf8')) as Record<string, unknown>; } catch { throw new SafeError(400, 'Hook body must be valid JSON'); }
        if (!hook || Array.isArray(hook) || typeof hook.session_id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(hook.session_id)
          || typeof hook.prompt_id !== 'string' || !hook.prompt_id.trim() || hook.prompt_id.length > 256
          || typeof hook.prompt !== 'string' || !hook.prompt.trim()) throw new SafeError(400, 'Hook requires bounded session_id, prompt_id, and prompt');
        if (!pendingHooks.has(hook.session_id) && pendingHooks.size >= 128) pendingHooks.delete(pendingHooks.keys().next().value!);
        const events = pendingHooks.get(hook.session_id) ?? [];
        if (!events.some(event => event.promptId === hook.prompt_id)) events.push({ promptId: hook.prompt_id, prompt: hook.prompt.slice(0, options.policy.classifier.maxContextChars + 1), digest: digest(normalizeMatchText(hook.prompt)) });
        pendingHooks.set(hook.session_id, events.slice(-8));
        response.writeHead(204); response.end(); return;
      }
      if (request.method === 'GET' && options.tool === 'codex' && new URL(request.url ?? '/', 'http://loopback').pathname === '/models') {
        const usage = new UsageParser('openai');
        await forward(targetUrl(upstreamFor(options, request.headers), request.url ?? '/'), 'GET', request.headers, Buffer.alloc(0), response, abort.signal, usage);
        response.end(); return;
      }
      if (request.method !== 'POST') return jsonError(response, 405, 'Unsupported native request');
      let body: Record<string, unknown>;
      try { body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>; }
      catch { return jsonError(response, 400, 'Native request body must be valid JSON'); }
      if ((request.url ?? '').startsWith('/_router/')) throw new SafeError(404, 'Unknown router endpoint');
      let parsed: ReturnType<typeof parseNativeRequest>;
      try { parsed = parseNativeRequest(options.tool, request.url ?? '/', request.headers, body); }
      catch { throw new SafeError(409, 'Automatic request identity is invalid or conflicting; resume through the original router'); }
      let routed = body;
      let attributableConversation: string | null = null;
      let displayDecision: Decision | undefined;
      if (parsed.automatic) {
        const pathname = new URL(request.url ?? '/', 'http://loopback').pathname;
        const supported = parsed.endpoint !== 'other' || (options.tool === 'claude' && pathname === '/v1/messages/count_tokens');
        if (!supported) throw new SafeError(409, `Unsupported automatic ${options.tool} endpoint; refusing to forward the sentinel model`);
        if (!parsed.conversationId) throw new SafeError(409, `Automatic ${options.tool} request is missing stable conversation identity`);
        const routeConversationId = parsed.ownerConversationId ?? parsed.conversationId;
        await ownership.acquire(options.tool, routeConversationId);
        let selection: Selection;
        const saved = await repository.load(options.tool, routeConversationId);
        const reuseSaved = () => {
          if (!saved) throw new SafeError(409, 'Automatic request has no saved route and cannot identify a fresh user turn; resume through the original router or start a new chat');
          const decision: Decision = { ...saved.lastDecision, selection: saved.selection, classification: null, recommendation: null,
            reason: 'pinned', adjustments: ['turn-detection-fallback'], turnDetection: 'saved-route', at: new Date().toISOString() };
          options.onDecision?.(decision);
          if (options.tool === 'codex') displayDecision = decision;
          routed = applyRoute(options.tool, request.url ?? '/', body, saved.selection);
          attributableConversation = routeConversationId;
        };
        let matchedHook: PromptHook | undefined;
        let previousPrompt: ConsumedPrompt | undefined;
        let fingerprint = '';
        if (options.tool === 'claude' && parsed.endpoint === 'messages'
          && (parsed.kind === 'user' || parsed.auxiliaryType === 'continuation')) {
          fingerprint = digest(claudeConversationSignature(body.messages));
          const candidates = new Set(claudeUserTextBlocks(body.messages).map(digest));
          if (parsed.kind === 'user' && parsed.task) candidates.add(digest(normalizeMatchText(parsed.task)));
          const matches = (pendingHooks.get(parsed.conversationId) ?? []).filter(event => candidates.has(event.digest));
          matchedHook = matches.length === 1 ? matches[0] : undefined;
          previousPrompt = matches.length === 0 ? consumed.get(parsed.conversationId)?.get(fingerprint) : undefined;
          // A single matching current event (or an already consumed retry) proves
          // the user turn despite sibling interruption text or tool results.
          const match = matchedHook ?? previousPrompt;
          if (match) { parsed.kind = 'user'; parsed.task = match.prompt; }
        }
        if (parsed.kind === 'unknown') {
          const input = options.tool === 'claude' ? body.messages : body.input;
          if (!Array.isArray(input) || input.length === 0) throw new SafeError(409, 'Unsupported automatic request shape; cannot apply the saved route');
          reuseSaved();
        } else if (parsed.kind === 'user') {
          if (!saved && (hasPriorConversation(options.tool, body) || sessionStarts.get(parsed.conversationId) === 'resume')) {
            throw new SafeError(409, 'Resumed conversation has no saved route; resume through the original router or start a new chat');
          }
          let task = parsed.task;
          let turnId = parsed.turnId;
          let turnDetection: Decision['turnDetection'] = 'native';
          if (options.tool === 'claude') {
            const events = pendingHooks.get(parsed.conversationId) ?? [];
            // Carry the event identity through: its bounded classifier prompt
            // may be shorter than the full text used to establish the match.
            const event = matchedHook;
            if (event) events.splice(events.indexOf(event), 1);
            if (!events.length) pendingHooks.delete(parsed.conversationId);
            if (event) {
              task = event.prompt; turnId = event.promptId;
              turnDetection = 'hook';
              if (!consumed.has(parsed.conversationId) && consumed.size >= 128) consumed.delete(consumed.keys().next().value!);
              const turns = consumed.get(parsed.conversationId) ?? new Map();
              turns.set(fingerprint, { promptId: event.promptId, prompt: event.prompt });
              while (turns.size > 8) turns.delete(turns.keys().next().value!);
              consumed.set(parsed.conversationId, turns);
            } else if (previousPrompt) { task = previousPrompt.prompt; turnId = previousPrompt.promptId; turnDetection = 'hook'; }
            else if (saved) reuseSaved();
            else if (sessionStarts.get(parsed.conversationId) === 'fresh' && task.trim()) {
              turnId = `content-${fingerprint}`; turnDetection = 'content';
            } else throw new SafeError(409, 'Claude UserPromptSubmit hook data is missing and a fresh session cannot be confirmed; start a new chat through the router with hooks enabled');
          }
          if (!routed || routed === body) {
            if ((!turnId || !task) && saved) reuseSaved();
            else {
              if (!turnId || !task) throw new SafeError(409, `Automatic ${options.tool} main request is missing turn identity or user task`);
              const decision = await router.routeTurn({ conversationId: parsed.conversationId, turnId, tool: options.tool, kind: 'user', task, signal: abort.signal, turnDetection });
              options.onDecision?.(decision);
              if (options.tool === 'codex') displayDecision = decision;
              selection = decision.selection;
              routed = applyRoute(options.tool, request.url ?? '/', body, selection);
              attributableConversation = parsed.conversationId;
            }
          }
        } else {
          if (!saved && (parsed.kind === 'compact' || parsed.auxiliaryType === 'continuation')) throw new SafeError(409, 'Automatic continuation has no saved route; resume through the original router');
          const title = parsed.auxiliaryType === 'title';
          selection = title ? titleRoute(options.policy, options.catalog, options.tool) : saved?.selection ?? fallback(options.policy, options.catalog, options.tool);
          const quotaProbe = options.tool === 'claude' && parsed.auxiliaryType === 'prewarm';
          // Keep the one-token quota check minimal; it is not a thinking task
          // and must not replace the conversation's last observed usage.
          routed = quotaProbe ? { ...body, model: selection.model } : applyRoute(options.tool, request.url ?? '/', body, selection);
          if (saved && !quotaProbe && !title) attributableConversation = routeConversationId;
        }
      }
      const target = targetUrl(upstreamFor(options, request.headers), request.url ?? '/');
      abort.signal.throwIfAborted();
      const usage = new UsageParser(options.tool === 'claude' ? 'anthropic' : 'openai');
      const conversation = attributableConversation;
      await forward(target, request.method, request.headers, Buffer.from(JSON.stringify(routed)), response, abort.signal, usage,
        conversation ? observed => usageStore.save(options.tool, conversation, observed) : undefined, displayDecision);
      response.end();
    } catch (error) {
      if (!abort.signal.aborted) {
        if (error instanceof OwnershipCollisionError) jsonError(response, 409, error.message);
        else jsonError(response, error instanceof SafeError ? error.status : 502, error instanceof SafeError ? error.message : 'Router request failed');
      }
    } finally { active.delete(abort); inFlight.delete(handlerDone); finishHandler(); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address() as AddressInfo;
  let closed = false;
  return { url: `http://127.0.0.1:${address.port}`, token, close: async () => {
    if (closed) return;
    closed = true;
    for (const controller of active) controller.abort(new Error('Router shutting down'));
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await Promise.all([...inFlight]);
    await ownership.close();
  } };
}
