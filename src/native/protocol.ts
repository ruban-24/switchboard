import type { Selection, Tool } from '../core/types.ts';

export const AUTO_MODEL = 'switchboard';
export const TOKEN_HEADER = 'x-switchboard-token';
export const TOKEN_ENV = 'SWITCHBOARD_TOKEN';

export function isAutomaticModel(model: unknown): boolean {
  return model === AUTO_MODEL;
}

type Headers = Record<string, string | string[] | undefined>;
type Json = Record<string, unknown>;

export interface NativeRequest {
  automatic: boolean;
  conversationId: string | null;
  turnId: string | null;
  kind: 'user' | 'auxiliary' | 'compact' | 'explicit' | 'unknown';
  task: string;
  endpoint: 'messages' | 'responses' | 'compact' | 'other';
  ownerConversationId?: string | null;
  auxiliaryType?: 'helper' | 'continuation' | 'prewarm' | 'title';
}

function object(value: unknown): Json { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}; }
function header(headers: Headers, name: string): string | null {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}
function jsonObject(value: unknown): Json {
  if (typeof value !== 'string') return {};
  try { return object(JSON.parse(value)); } catch { return {}; }
}
function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null; }
export function normalizeMatchText(value: string): string { return value.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '').trim(); }

// Claude can expand its system-context message into user-message reminders and
// move cache breakpoints during a compatibility retry. Identify the underlying
// conversational content, not that mutable transport envelope. Tool results,
// images, and prior assistant/user messages still distinguish different turns.
export function claudeConversationSignature(messages: unknown): string {
  if (!Array.isArray(messages)) return JSON.stringify(messages ?? null);
  return JSON.stringify(messages.map(object).filter(message => message.role !== 'system').map(message => {
    const parts = typeof message.content === 'string' ? [{ type: 'text', text: message.content }]
      : Array.isArray(message.content) ? message.content : [];
    const content = parts.flatMap(value => {
      const { cache_control: _cache, ...part } = object(value);
      if (part.type !== 'text' || typeof part.text !== 'string') return [part];
      const text = message.role === 'user' ? normalizeMatchText(part.text) : part.text;
      return text ? [{ ...part, text }] : [];
    });
    return { role: message.role, content };
  }));
}

export function hasPriorConversation(tool: Tool, value: unknown): boolean {
  const body = object(value);
  if (tool === 'codex' && body.previous_response_id) return true;
  const items = tool === 'claude' ? body.messages : body.input;
  if (!Array.isArray(items)) return true;
  return items.some(value => {
    const item = object(value);
    if (item.role === 'assistant' || ['function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output', 'reasoning', 'compaction'].includes(String(item.type))) return true;
    return Array.isArray(item.content) && item.content.some(part => ['tool_use', 'tool_result'].includes(String(object(part).type)));
  });
}
function agreeing(values: Array<string | null>, label: string): string | null {
  const present = values.filter((value): value is string => value !== null);
  if (new Set(present).size > 1) throw new Error(`${label} identity projections disagree`);
  return present[0] ?? null;
}
function inputText(input: unknown): string {
  if (!Array.isArray(input)) return '';
  for (let index = input.length - 1; index >= 0; index--) {
    const item = object(input[index]);
    if (item.role !== 'user' || item.type === 'function_call_output' || item.type === 'custom_tool_call_output') continue;
    if (typeof item.content === 'string') return item.content.trim();
    if (!Array.isArray(item.content)) continue;
    const value = item.content.map(part => object(part)).filter(part => part.type === 'input_text').map(part => text(part.text) ?? '').join('\n').trim();
    if (value) return value;
  }
  return '';
}

function lastClaudeMessage(messages: unknown): Json {
  if (!Array.isArray(messages)) return {};
  let index = messages.length - 1;
  while (index >= 0) {
    const candidate = object(messages[index]);
    // Claude appends system context in both tagged and untagged forms depending
    // on the authentication mode. It is not a user/tool turn. Leave it intact
    // upstream and inspect the preceding conversational message for routing.
    if (candidate.role !== 'system') break;
    index--;
  }
  return object(messages[index]);
}

// Only sibling user text is eligible for hook matching. Never search inside a
// tool result: output can quote the user's next prompt without being that turn.
export function claudeUserTextBlocks(messages: unknown): string[] {
  const last = lastClaudeMessage(messages);
  if (last.role !== 'user') return [];
  if (typeof last.content === 'string') return [normalizeMatchText(last.content)];
  if (!Array.isArray(last.content)) return [];
  return last.content.map(object).filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => normalizeMatchText(part.text as string)).filter(Boolean);
}

function claudeTurn(messages: unknown): { kind: 'user' | 'auxiliary' | 'unknown'; task: string } {
  if (Array.isArray(messages) && !messages.length) return { kind: 'user', task: '' };
  if (!Array.isArray(messages)) return { kind: 'unknown', task: '' };
  const last = lastClaudeMessage(messages);
  if (last.role !== 'user') return { kind: 'auxiliary', task: '' };
  if (typeof last.content === 'string') return { kind: 'user', task: normalizeMatchText(last.content) };
  if (!Array.isArray(last.content)) return { kind: 'unknown', task: '' };
  const parts = last.content.map(object);
  if (parts.some(part => part.type === 'tool_result')) return { kind: 'auxiliary', task: '' };
  const task = normalizeMatchText(parts.filter(part => part.type === 'text').map(part => text(part.text) ?? '').join('\n'));
  return task ? { kind: 'user', task } : { kind: 'unknown', task: '' };
}

function isClaudeSessionTitle(body: Json, task: string): boolean {
  // Observed in Claude Code 2.1.276: its session namer has no hook or agent ID.
  // Empty tools alone is ambiguous because --tools "" also permits real turns.
  if (!Array.isArray(body.tools) || body.tools.length !== 0
    || !Array.isArray(body.messages) || body.messages.length !== 1
    || !/^<session>[\s\S]*<\/session>/.test(task)) return false;
  const system = typeof body.system === 'string' ? [body.system]
    : Array.isArray(body.system) ? body.system.map(part => object(part).text) : [];
  return system.some(value => typeof value === 'string'
    && value.startsWith('You are naming a coding session ')
    && value.includes('Return JSON with a single "title" field.'));
}

function isClaudeQuotaProbe(body: Json): boolean {
  // The interactive CLI probes quota before submitting a user turn. Match its
  // minimal observed envelope, not arbitrary short or tool-free user messages.
  if (body.max_tokens !== 1 || !Array.isArray(body.messages) || body.messages.length !== 1
    || Object.keys(body).some(key => !['model', 'max_tokens', 'messages', 'metadata'].includes(key))) return false;
  const message = object(body.messages[0]);
  return message.role === 'user' && message.content === 'quota';
}

function isCodexTaskTitle(body: Json): boolean {
  // Match the installed CLI's naming envelope, not title-like text from users.
  // Codex 0.154 also puts the naming instruction in user-role input; the
  // caller must establish system thread origin before using this predicate.
  const instructions = [body.instructions, inputText(body.input)];
  if (Array.isArray(body.input)) for (const item of body.input.map(object)) {
    if (item.role !== 'developer' && item.role !== 'system') continue;
    if (typeof item.content === 'string') instructions.push(item.content);
    else if (Array.isArray(item.content)) instructions.push(...item.content.map(part => object(part).text));
  }
  return instructions.some(value => typeof value === 'string'
    && value.startsWith('Generate a concise, single-line task title of at most 36 characters')
    && value.includes('Start with an imperative verb.'));
}

export function parseNativeRequest(tool: Tool, path: string, headers: Headers, value: unknown): NativeRequest {
  const body = object(value);
  const automatic = isAutomaticModel(body.model);
  if (!automatic) return { automatic: false, conversationId: null, turnId: null, kind: 'explicit', task: '', endpoint: 'other' };
  if (tool === 'claude') {
    const user = jsonObject(object(body.metadata).user_id);
    const conversationId = agreeing([text(user.session_id), text(header(headers, 'x-claude-code-session-id'))], 'Claude session');
    const pathname = new URL(path, 'http://loopback').pathname;
    const messages = pathname === '/v1/messages';
    const turn = messages ? claudeTurn(body.messages) : { kind: 'auxiliary' as const, task: '' };
    const agent = header(headers, 'x-claude-code-agent-id') || header(headers, 'x-claude-code-parent-agent-id');
    const helper = Boolean(agent) || (messages && isClaudeSessionTitle(body, turn.task));
    const prewarm = messages && isClaudeQuotaProbe(body);
    return { automatic: true, conversationId, turnId: null, kind: helper || prewarm ? 'auxiliary' : turn.kind, task: helper || prewarm ? '' : turn.task, endpoint: messages ? 'messages' : 'other', ...(prewarm ? { auxiliaryType: 'prewarm' as const } : helper ? { auxiliaryType: 'helper' as const } : messages && turn.kind === 'auxiliary' ? { auxiliaryType: 'continuation' as const } : {}) };
  }
  const client = object(body.client_metadata);
  const bodyCanonical = jsonObject(client['x-codex-turn-metadata']);
  const headerCanonical = jsonObject(header(headers, 'x-codex-turn-metadata'));
  const canonical = Object.keys(bodyCanonical).length ? bodyCanonical : headerCanonical;
  const conversationId = agreeing([text(bodyCanonical.thread_id), text(headerCanonical.thread_id), text(client.thread_id), text(header(headers, 'thread-id'))], 'Codex thread');
  const turnId = agreeing([text(bodyCanonical.turn_id), text(headerCanonical.turn_id), text(client.turn_id)], 'Codex turn');
  const requestKind = text(canonical.request_kind) ?? 'unknown';
  const threadSource = agreeing([text(bodyCanonical.thread_source), text(headerCanonical.thread_source)], 'Codex thread source');
  const helper = Boolean(canonical.subagent_kind || canonical.parent_thread_id || header(headers, 'x-openai-subagent'));
  const compact = requestKind === 'compaction' || /\/responses\/compact(?:\?|$)/.test(path);
  const tail = Array.isArray(body.input) ? object(body.input.at(-1)) : {};
  const continuation = tail.type === 'function_call_output' || tail.type === 'custom_tool_call_output';
  const title = !helper && !compact && !continuation && requestKind === 'turn' && threadSource === 'system' && isCodexTaskTitle(body);
  const knownAuxiliary = title || helper || continuation || ['prewarm', 'memory'].includes(requestKind);
  const kind = compact ? 'compact' : knownAuxiliary ? 'auxiliary' : requestKind === 'turn' ? 'user' : 'unknown';
  return { automatic: true, conversationId, turnId, kind, task: kind === 'user' ? inputText(body.input) : '', endpoint: compact ? 'compact' : /\/responses(?:\?|$)/.test(path) ? 'responses' : 'other', ...(text(canonical.parent_thread_id) ? { ownerConversationId: text(canonical.parent_thread_id) } : {}), ...(title ? { auxiliaryType: 'title' as const } : helper ? { auxiliaryType: 'helper' as const } : continuation ? { auxiliaryType: 'continuation' as const } : ['prewarm', 'memory'].includes(requestKind) ? { auxiliaryType: 'prewarm' as const } : {}) };
}

export function applyRoute(tool: Tool, path: string, value: unknown, selection: Selection): Json {
  const source = object(value);
  if (!isAutomaticModel(source.model)) return source;
  const body = structuredClone(source);
  body.model = selection.model;
  if (tool === 'codex') {
    if (!/\/responses\/compact(?:\?|$)/.test(path) && selection.effort !== null) {
      body.reasoning = { ...object(body.reasoning), effort: selection.effort };
    }
    return body;
  }
  if (selection.effort === null) {
    delete body.thinking;
    const output = object(body.output_config);
    delete output.effort;
    if (Object.keys(output).length) body.output_config = output; else delete body.output_config;
    const context = object(body.context_management);
    if (Array.isArray(context.edits)) {
      const edits = context.edits.filter(edit => !/thinking/i.test(String(object(edit).type ?? '')));
      if (edits.length) context.edits = edits; else delete context.edits;
    }
    if (Object.keys(context).length) body.context_management = context; else delete body.context_management;
  } else {
    body.output_config = { ...object(body.output_config), effort: selection.effort };
    body.thinking = { type: 'adaptive' };
  }
  return body;
}
