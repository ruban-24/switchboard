import type { Catalog, Compatibility, Environment } from './types.ts';
import * as v from './validate.ts';

export function parseCatalog(input: unknown): Catalog {
  const root = v.object(input, 'catalog', ['version', 'models', 'compatibility']);
  if (root.version !== 1) throw new Error('Unsupported catalog version');
  const models = v.array(root.models, 'models').map(value => {
    const m = v.object(value, 'model', ['id', 'tool', 'provider', 'family', 'efforts']);
    const tool = v.oneOf(m.tool, v.tools, 'model.tool');
    const provider = v.oneOf(m.provider, ['anthropic', 'openai'] as const, 'model.provider');
    if ((tool === 'claude') !== (provider === 'anthropic')) throw new Error('Model tool/provider mismatch');
    const efforts = v.unique(v.array(m.efforts, 'model.efforts').map(e => v.effort(e, 'effort')), 'efforts');
    if (!efforts.length || (efforts.includes(null) && efforts.length > 1)) throw new Error('Efforts must specify supported levels or a single fixed null value');
    return { id: v.text(m.id, 'model.id'), tool, provider, family: v.text(m.family, 'model.family'), efforts };
  });
  v.unique(models.map(m => `${m.tool}:${m.id}`), 'models');
  const compatibility: Compatibility[] = v.array(root.compatibility, 'compatibility').map(value => {
    const c = v.object(value, 'compatibility', ['model', 'tool', 'cliVersions', 'connection', 'mode', 'mechanism', 'status', 'sourceUrl', 'checkedAt', 'evidence', 'restrictions']);
    const tool = v.oneOf(c.tool, v.tools, 'compatibility.tool');
    const model = v.text(c.model, 'compatibility.model');
    if (!models.some(m => m.id === model && m.tool === tool)) throw new Error(`Compatibility model ${model} is not catalogued`);
    const status = v.oneOf(c.status, ['verified', 'unverified', 'unsupported'] as const, 'status');
    const evidence = c.evidence === null ? null : v.text(c.evidence, 'evidence');
    if (status === 'verified' && !evidence) throw new Error('Verified compatibility requires evidence');
    const sourceUrl = v.text(c.sourceUrl, 'sourceUrl');
    if (new URL(sourceUrl).protocol !== 'https:') throw new Error('Evidence source must use HTTPS');
    const checkedAt = v.text(c.checkedAt, 'checkedAt');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(checkedAt) || !Number.isFinite(Date.parse(checkedAt))) throw new Error('Invalid checkedAt date');
    const cliVersions = v.unique(v.array(c.cliVersions, 'cliVersions').map(version => v.text(version, 'cliVersion')), 'cliVersions');
    if (status === 'verified' && cliVersions.length === 0) throw new Error('Verified evidence needs tested CLI versions');
    const mechanism = v.oneOf(c.mechanism, ['fixed', 'openai-configuration-update', 'anthropic-message-effort'] as const, 'mechanism');
    if ((mechanism.startsWith('openai') && tool !== 'codex') || (mechanism.startsWith('anthropic') && tool !== 'claude')) throw new Error('Effort mechanism belongs to another provider');
    return {
      model, tool, cliVersions, connection: v.oneOf(c.connection, ['api-key', 'subscription'] as const, 'connection'),
      mode: v.text(c.mode, 'mode'), mechanism, status, sourceUrl, checkedAt, evidence,
      restrictions: v.array(c.restrictions, 'restrictions').map(r => v.text(r, 'restriction')),
    };
  });
  const entries = compatibility.flatMap(c => c.cliVersions.map(version => `${c.tool}:${c.model}:${c.connection}:${c.mode}:${version}`));
  v.unique(entries, 'compatibility');
  return { version: 1, models, compatibility };
}

export function findCompatibility(catalog: Catalog, environment: Environment): Compatibility | undefined {
  return catalog.compatibility.find(c => c.model === environment.model && c.tool === environment.tool &&
    c.connection === environment.connection && c.mode === environment.mode && c.cliVersions.includes(environment.cliVersion));
}

export function canChangeEffort(catalog: Catalog, environment: Environment): boolean {
  const match = findCompatibility(catalog, environment);
  // Free-text restrictions are not executable checks. Until an adapter can enforce
  // them, their presence prevents an automatic effort change.
  return match?.status === 'verified' && match.mechanism !== 'fixed' && match.restrictions.length === 0;
}
