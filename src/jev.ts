import {
  TypeSafeClient,
  type Questions,
  type RequestOptions,
  type SystemOneRequest,
  type SystemOneResult,
} from '@typesafe-ai/sdk';
import { APICallError, createGateway } from 'ai';
import type { Classification, ClassificationContext } from './core/types.ts';
import { buildJevQuestions, parseJevAnswers } from './jev-questions.ts';

export interface JevClient {
  systemOne<Q extends Questions>(request: SystemOneRequest<Q>, options?: RequestOptions): PromiseLike<SystemOneResult<Q>>;
}

// The Router owns the shorter end-to-end deadline; no transport retries.
const SDK_ATTEMPT_TIMEOUT_MS = 31_000;
export const TYPESAFE_BASE_URL = 'https://api.typesafe.ai';
export const VERCEL_BASE_URL = 'https://ai-gateway.vercel.sh/v4/ai';

export function typesafeModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.SWITCHBOARD_MODEL?.trim() || env.TYPESAFE_DEFAULT_MODEL?.trim() || 'jev-latest';
}

export function createJevClassifier(apiKey: string | undefined, injectedClient?: JevClient, modelId = typesafeModel(), connection: {
  baseURL?: string; provider?: 'typesafe' | 'openrouter';
} = {}) {
  if (!apiKey?.trim()) throw new Error('Set JEV_API_KEY or TYPESAFE_API_KEY before using Jev classification');
  const client: JevClient = injectedClient ?? new TypeSafeClient({
    apiKey,
    baseURL: connection.baseURL ?? TYPESAFE_BASE_URL,
    defaultModel: modelId,
    retry: { maxRetries: 0 },
    timeout: SDK_ATTEMPT_TIMEOUT_MS,
    logLevel: 'off',
  });
  return async (task: string, signal: AbortSignal, context: ClassificationContext): Promise<Classification> => {
    const request = buildJevQuestions(context);
    try {
      const result = await client.systemOne({ model: modelId, state: { task }, questions: request.questions }, { signal, retry: { maxRetries: 0 } });
      return parseJevAnswers(result, context, request.candidates, { provider: connection.provider ?? 'typesafe', requestedModel: modelId, resolvedModel: result.model });
    } catch (error) {
      if (error instanceof Error && error.message === 'Jev returned an invalid classification') throw error;
      throw new Error('Jev classification failed');
    }
  };
}

export const VERCEL_JEV_MODEL = 'typesafe-ai/jev';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

// Gateway validates every present answer before returning it. Normalize only
// optional task/effort answers and diagnostics at this boundary; the SDK still
// validates critical shapes and parseJevAnswers validates choices/confidence.
const gatewayDiagnosticFetch: typeof fetch = async (input, init) => {
  const response = await globalThis.fetch(input, init);
  if (!response.ok) return response;
  const body: unknown = await response.json();
  const answers = record(record(body)?.answers);
  if (answers) {
    for (const [id, value] of Object.entries(answers)) {
      if (id !== 'taskType' && !/^effort_\d+$/.test(id)) continue;
      const answer = record(value);
      if (!answer || answer.type !== 'choice' || typeof answer.choice !== 'string') delete answers[id];
    }
    for (const value of Object.values(answers)) {
      const answer = record(value);
      if (!answer || !['choice', 'score'].includes(String(answer.type)) || answer.probabilities === undefined) continue;
      const probabilities = record(answer.probabilities);
      if (!probabilities || !Object.values(probabilities).every(p => typeof p === 'number' && Number.isFinite(p))) {
        delete answer.probabilities;
      }
    }
  }
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return Response.json(body, { status: response.status, statusText: response.statusText, headers });
};

export function createVercelJevClassifier(apiKey: string | undefined, modelId = VERCEL_JEV_MODEL, baseURL = VERCEL_BASE_URL) {
  if (!apiKey?.trim()) throw new Error('Set AI_GATEWAY_API_KEY before using Jev through Vercel AI Gateway');
  const gatewayModel = createGateway({ apiKey, baseURL, fetch: gatewayDiagnosticFetch }).evaluationModel(modelId);
  return async (task: string, signal: AbortSignal, context: ClassificationContext): Promise<Classification> => {
    const request = buildJevQuestions(context);
    try {
      // Use the SDK transport directly: evaluate() requires every candidate's
      // answer, but routing only requires capability/context plus the selected
      // model's effort. Our shared parser owns that partial-answer contract.
      // doEvaluate makes one request, has no retry loop, and does not log provider
      // warnings (which can contain task data). Keep global SDK logging untouched.
      signal.throwIfAborted();
      const result = await gatewayModel.doEvaluate({ state: { task }, questions: request.questions, abortSignal: signal });
      signal.throwIfAborted();
      const confidence = result.providerMetadata?.typesafe?.confidence;
      const confidenceByQuestion = confidence && typeof confidence === 'object' && !Array.isArray(confidence)
        ? confidence as Record<string, unknown> : {};
      return parseJevAnswers({
        answers: Object.fromEntries(Object.entries(result.answers).map(([id, answer]) => [
          id, { ...answer, confidence: confidenceByQuestion[id] },
        ])),
      }, context, request.candidates, { provider: 'vercel', requestedModel: modelId, resolvedModel: null });
    } catch (error) {
      if (error instanceof Error && error.message === 'Jev returned an invalid classification') throw error;
      // Never pass through SDK messages, causes, response bodies, or headers.
      if (signal.aborted) throw new Error('Vercel AI Gateway Jev classification failed');
      const cause = error instanceof Error ? error.cause : undefined;
      const status = APICallError.isInstance(cause) ? cause.statusCode : undefined;
      if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) {
        throw new Error(`Vercel AI Gateway Jev request failed (HTTP ${status})`);
      }
      throw new Error('Vercel AI Gateway Jev classification failed');
    }
  };
}
