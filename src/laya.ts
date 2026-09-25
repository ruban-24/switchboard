import type { Classification, ClassificationContext } from './core/types.ts';
import { buildLayaQuestions, parseLayaAnswers } from './laya-questions.ts';

// laya-serve's default address; Laya has no official hosted endpoint.
export const LAYA_BASE_URL = 'http://127.0.0.1:8000';
export const LAYA_MODEL = 'english';
const MAX_RESPONSE_CHARS = 256 * 1024;

// Plain fetch rather than the TypeSafe SDK: Laya's calibrated answer_confidence
// is an extension field that a strict System One client need not preserve.
export function createLayaClassifier(apiKey: string | undefined, modelId = LAYA_MODEL, baseURL = LAYA_BASE_URL) {
  const endpoint = `${baseURL}/v1/systemone`;
  return async (task: string, signal: AbortSignal, context: ClassificationContext): Promise<Classification> => {
    const questions = buildLayaQuestions(context);
    let status: number | undefined;
    try {
      const response = await fetch(endpoint, {
        method: 'POST', signal, redirect: 'error',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model: modelId, state: { task }, questions }),
      });
      status = response.status;
      if (!response.ok) throw new Error();
      const text = await response.text();
      if (text.length > MAX_RESPONSE_CHARS) throw new Error();
      return parseLayaAnswers(JSON.parse(text), context);
    } catch (error) {
      if (error instanceof Error && error.message === 'Laya returned an invalid classification') throw error;
      // Never pass through response bodies, headers, or the request.
      if (!signal.aborted && status !== undefined && status >= 400 && status <= 599) throw new Error(`Laya request failed (HTTP ${status})`);
      throw new Error('Laya classification failed');
    }
  };
}
