import { connectionEnvironment, stateDirectory } from '../dist/settings.js';
import { classifierStatus, createConfiguredClassifier } from '../dist/classifier.js';
import { defaultPolicy, bundledCatalog } from '../dist/defaults.js';
import { assessInitialRoute } from '../dist/core/policy.js';

// Explicit, single-request connectivity check. It never reads repository content
// or launches a coding model. Ordinary doctor/init remain entirely offline.
const timeoutMs = 10_000;
const signal = AbortSignal.timeout(timeoutMs);
const started = performance.now();
try {
  const tool = process.argv[2] ?? 'claude';
  if (!['claude', 'codex'].includes(tool)) throw new Error('Usage: npm run check:jev -- [claude|codex]');
  const env = await connectionEnvironment(stateDirectory());
  const status = classifierStatus(env);
  console.log(`Checking ${status.label}: ${status.modelId} (one Jev request).`);
  const classify = createConfiguredClassifier(env);
  const result = await classify('Fix a spelling mistake in one README heading. No code or behavior changes are required.', signal,
    { tool, policy: defaultPolicy, catalog: bundledCatalog });
  const elapsedMs = Math.round(performance.now() - started);
  console.log(`Jev connection verified in ${elapsedMs} ms.`);
  console.log(JSON.stringify(result, null, 2));
  if (elapsedMs > defaultPolicy.classifier.timeoutMs) {
    console.log(`This probe exceeded the default ${defaultPolicy.classifier.timeoutMs} ms routing deadline; automatic routing may use its fallback with that deadline.`);
  }
  const decision = assessInitialRoute(defaultPolicy, bundledCatalog, tool, result);
  console.log(JSON.stringify({ tool, ...decision }));
} catch (error) {
  // Classifier errors are sanitized at the adapter boundary. Do not print causes.
  console.error(signal.aborted ? `Jev connection check timed out after ${timeoutMs} ms.`
    : error instanceof Error ? error.message : 'Jev connection check failed.');
  process.exitCode = 2;
}
