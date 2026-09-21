// Fixed-purpose Claude command hook. Prompts arrive on stdin, never in a shell
// command. Keep stdout empty so delivery adds nothing to the model's context.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { TOKEN_ENV, TOKEN_HEADER } from './protocol.ts';

function fail(): never {
  process.stderr.write('Switchboard could not deliver the Claude hook. Restart through switchboard claude; check that hooks are enabled and the router is still running.\n');
  process.exit(2);
}

const deadline = setTimeout(fail, 5000);
try {
  const endpoint = new URL(process.env.SWITCHBOARD_HOOK_URL ?? '');
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port
    || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) throw new Error();
  const token = process.env[TOKEN_ENV];
  if (!token) throw new Error();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 16 * 1024 * 1024) throw new Error();
    chunks.push(bytes);
  }
  const event: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error();
  const hook = event as Record<string, unknown>;
  if (hook.hook_event_name !== process.argv[2] || typeof hook.session_id !== 'string'
    || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(hook.session_id)) throw new Error();
  let body: string;
  if (hook.hook_event_name === 'SessionStart' && typeof hook.source === 'string' && ['startup', 'clear', 'resume', 'compact', 'fork'].includes(hook.source)) {
    endpoint.pathname = '/_router/session';
    body = JSON.stringify({ session_id: hook.session_id, source: hook.source });
  } else if (hook.hook_event_name === 'UserPromptSubmit' && typeof hook.prompt === 'string' && hook.prompt.trim()) {
    endpoint.pathname = '/_router/turn';
    // prompt_id is present in some native versions but absent in the documented
    // schema. Generate event identity here; never derive it from prompt text.
    const promptId = hook.prompt_id ?? randomUUID();
    if (typeof promptId !== 'string' || !promptId.trim() || promptId.length > 256) throw new Error();
    body = JSON.stringify({ session_id: hook.session_id, prompt_id: promptId, prompt: hook.prompt });
  } else throw new Error();
  await new Promise<void>((resolve, reject) => {
    const request = http.request(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', [TOKEN_HEADER]: token } }, response => {
      response.resume();
      response.on('end', () => response.statusCode === 204 ? resolve() : reject(new Error()));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(body);
  });
  clearTimeout(deadline);
} catch { fail(); }
