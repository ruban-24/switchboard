import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Generate from the artifact being published, never from a possibly newer checkout.
// This maintainer command runs on the macOS/Linux platforms supported by Homebrew.
function formula(pkg, sha256) {
  const problems = [];
  const name = /^@[a-z0-9][a-z0-9-]*\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/.exec(pkg.name ?? '');
  if (!name) problems.push('name must be a scoped package with a lowercase, hyphenated basename');
  if (pkg.private !== false) problems.push('set private to false after choosing the release identity');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version ?? '')) problems.push('version must be an explicit release version');
  if (typeof pkg.description !== 'string' || !pkg.description.trim()) problems.push('description is required');
  try {
    const homepage = new URL(pkg.homepage);
    if (homepage.protocol !== 'https:' || homepage.username || homepage.password) throw new Error();
  } catch { problems.push('homepage must be a public HTTPS URL'); }
  if (typeof pkg.license !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(pkg.license) || pkg.license === 'UNLICENSED') {
    problems.push('choose a release license and set its SPDX identifier');
  }
  const commands = pkg.bin && typeof pkg.bin === 'object' && !Array.isArray(pkg.bin) ? Object.keys(pkg.bin) : [];
  if (commands.length !== 1 || !/^[a-z][a-z0-9-]*$/.test(commands[0] ?? '')) problems.push('bin must expose one CLI command');
  if (problems.length) throw new Error(`Incomplete release metadata: ${problems.join('; ')}.`);

  const basename = name[1];
  const ruby = value => JSON.stringify(value).replaceAll('#', '\\#');
  const className = basename.split('-').map(part => part[0].toUpperCase() + part.slice(1)).join('');
  const url = `https://registry.npmjs.org/${pkg.name}/-/${basename}-${pkg.version}.tgz`;
  return `class ${className} < Formula
  desc ${ruby(pkg.description)}
  homepage ${ruby(pkg.homepage)}
  url ${ruby(url)}
  version ${ruby(pkg.version)}
  sha256 ${ruby(sha256)}
  license ${ruby(pkg.license)}

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    ENV["SWITCHBOARD_HOME"] = (testpath/"config").to_s
    system bin/${ruby(commands[0])}, "init", "--yes"
    system bin/${ruby(commands[0])}, "config", "check"
    assert_path_exists testpath/"config/policy.json"
  end
end
`;
}

try {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/homebrew-formula.mjs <packed-release.tgz>');
  const archive = resolve(process.argv[2]);
  const extracted = spawnSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8', timeout: 10_000 });
  if (extracted.error || extracted.status !== 0) throw new Error('Cannot read package/package.json from the npm tarball.');
  const pkg = JSON.parse(extracted.stdout);
  const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  process.stdout.write(formula(pkg, sha256));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
