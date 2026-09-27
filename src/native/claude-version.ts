import { execFile } from 'node:child_process';
import { claudeCodeVersion } from '../doctor-fix.ts';

/**
 * Runs `claude --version` locally. The child receives only PATH and HOME, so no
 * classifier credential reaches it. Returns null when the version cannot be read.
 */
export async function readClaudeCodeVersion(executable: string): Promise<string | null> {
  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(executable, ['--version'], {
        encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024,
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      }, (error, stdout) => error ? reject(error) : resolve(stdout));
    });
    return claudeCodeVersion(output);
  } catch {
    return null;
  }
}
