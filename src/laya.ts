import type { Classification, ClassificationContext } from './core/types.ts';
import { buildLayaQuestions, parseLayaAnswers } from './laya-questions.ts';

// laya-serve's default address; Laya has no official hosted endpoint.
export const LAYA_BASE_URL = 'http://127.0.0.1:8000';
export const LAYA_MODEL = 'english';
const MAX_RESPONSE_BYTES = 256 * 1024;
// Laya gives each question up to 192 tokens and the task the rest of its 512-token input,
// cutting longer tasks from the end without saying so. Its tokenizer averages about 2.4
// characters per token on paths and dense code, so 700 characters always fit. A longer task
// is still sent for its diagnostics but marked as insufficient context, like any truncation.
export const LAYA_MAX_TASK_CHARS = 700;

/** Reads at most `limit` bytes, cancelling the body as soon as it grows past the limit. */
async function readLimited(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (declared > limit || !response.body) { await response.body?.cancel(); throw new Error(); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new Error(); }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// Plain fetch rather than the TypeSafe SDK: Laya's calibrated answer_confidence
// is an extension field that a strict System One client need not preserve.
export function createLayaClassifier(apiKey: string | undefined, modelId = LAYA_MODEL, baseURL = LAYA_BASE_URL) {
  const endpoint = `${baseURL}/v1/systemone`;
  return async (task: string, signal: AbortSignal, context: ClassificationContext): Promise<Classification> => {
    const questions = buildLayaQuestions(context);
    const truncated = task.length > LAYA_MAX_TASK_CHARS;
    let status: number | undefined;
    try {
      const response = await fetch(endpoint, {
        method: 'POST', signal, redirect: 'error',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model: modelId, state: { task: task.slice(0, LAYA_MAX_TASK_CHARS) }, questions }),
      });
      status = response.status;
      if (!response.ok) throw new Error();
      const result = parseLayaAnswers(JSON.parse(await readLimited(response, MAX_RESPONSE_BYTES)), context);
      return truncated ? { ...result, sufficientContext: false } : result;
    } catch (error) {
      if (error instanceof Error && error.message === 'Laya returned an invalid classification') throw error;
      // Never pass through response bodies, headers, or the request.
      if (!signal.aborted && status !== undefined && status >= 400 && status <= 599) throw new Error(`Laya request failed (HTTP ${status})`);
      throw new Error('Laya classification failed');
    }
  };
}
