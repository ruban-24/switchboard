import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

const begin = '# >>> Switchboard >>>';
const end = '# <<< Switchboard <<<';
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export async function recommendedProfiles(env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<string[]> {
  const shell = basename(env.SHELL ?? '');
  if (shell === 'zsh') return [join(env.ZDOTDIR && isAbsolute(env.ZDOTDIR) ? env.ZDOTDIR : home, '.zshrc')];
  if (shell === 'bash') {
    const interactive = join(home, '.bashrc');
    for (const name of ['.bash_profile', '.bash_login', '.profile']) {
      try { if ((await stat(join(home, name))).isFile()) return [interactive, join(home, name)]; } catch { /* No login profile yet. */ }
    }
    return [interactive, join(home, '.bash_profile')];
  }
  return shell === 'sh' || shell === 'dash' ? [join(home, '.profile')] : [];
}

/** A small, optional profile block selects the configuration directory, never the key. */
export async function installProfileBlock(profile: string, root: string): Promise<void> {
  if (![profile, root].every(path => isAbsolute(path) && !/[\x00-\x1f\x7f]/.test(path))) throw new Error('Shell profile and configuration paths must be absolute and contain no control characters');
  await mkdir(dirname(profile), { recursive: true, mode: 0o700 });
  let target: string;
  try { target = await realpath(profile); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot resolve shell profile');
    try { if ((await lstat(profile)).isSymbolicLink()) throw new Error('Shell profile is a dangling symbolic link'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    target = profile;
  }
  const lockFile = `${target}.switchboard.lock`;
  let lock;
  try { lock = await open(lockFile, 'wx', 0o600); }
  catch { throw new Error('Shell profile is busy or not writable; no changes made'); }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    let before = '', mode = 0o600;
    try {
      const info = await lstat(target);
      if (!info.isFile() || info.size > 1024 * 1024 || (process.getuid && info.uid !== process.getuid())) throw new Error('Shell profile must be a regular file owned by the current user and smaller than 1 MB');
      mode = info.mode & 0o777;
      before = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(target));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const starts = [...before.matchAll(/^# >>> Switchboard >>>\r?$/gm)];
    const ends = [...before.matchAll(/^# <<< Switchboard <<<\r?$/gm)];
    if (starts.length !== ends.length || starts.length > 1 || (starts[0] && ends[0]!.index! < starts[0].index!)) throw new Error('Shell profile has an incomplete or ambiguous Switchboard block; no changes made');
    const newline = before.includes('\r\n') ? '\r\n' : '\n';
    const block = [begin, '# Credentials stay in connection.json; this selects their directory.', `export SWITCHBOARD_HOME=${quote(root)}`, end].join(newline);
    const after = starts[0]
      ? before.slice(0, starts[0].index) + block + before.slice(ends[0]!.index! + end.length)
      : before + (before && !before.endsWith('\n') ? newline : '') + (before ? newline : '') + block + newline;
    if (after === before) return;
    const handle = await open(temporary, 'wx', mode);
    try { await handle.chmod(mode); await handle.writeFile(after); await handle.sync(); }
    finally { await handle.close(); }
    let current = '';
    try { current = await readFile(target, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (current !== before) throw new Error('Shell profile changed during setup; retry init');
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
    await lock.close();
    await rm(lockFile, { force: true });
  }
}

/** Hidden input uses readline's terminal editing without writing its echo to the terminal. */
export async function ask(question: string, hidden = false): Promise<string> {
  const output = hidden ? new Writable({ write(_chunk, _encoding, done) { done(); } }) : process.stdout;
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const controller = new AbortController();
  const abort = () => controller.abort();
  rl.once('SIGINT', abort);
  rl.once('close', abort);
  if (hidden) process.stdout.write(question);
  try { return (await rl.question(hidden ? '' : question, { signal: controller.signal })).trim(); }
  catch { throw new Error('Setup cancelled; run switchboard init when ready'); }
  finally { rl.close(); if (hidden) process.stdout.write('\n'); }
}

export async function choose(question: string, choices: string[], fallback: string): Promise<string> {
  for (;;) {
    const answer = await ask(`${question} [${fallback}]: `) || fallback;
    if (choices.includes(answer)) return answer;
    console.log(`Enter ${choices.join(', ')}.`);
  }
}
