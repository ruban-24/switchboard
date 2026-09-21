#!/usr/bin/env node

try {
  const { main } = await import('../dist/cli.js');
  process.exitCode = await main(process.argv.slice(2));
} catch {
  console.error('switchboard: could not load the build. From the repository, run npm ci && npm run build.');
  process.exitCode = 2;
}
