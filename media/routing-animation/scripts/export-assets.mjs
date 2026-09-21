import {copyFile, mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const require = createRequire(import.meta.url);
const exporterRequire = createRequire(require.resolve('@motion-canvas/ffmpeg'));
const ffmpeg = exporterRequire('@ffmpeg-installer/ffmpeg').path;
const ffprobe = exporterRequire('@ffprobe-installer/ffprobe').path;
const input = fileURLToPath(new URL('../output/project.mp4', import.meta.url));
const assets = new URL('../../../assets/', import.meta.url);
const asset = name => fileURLToPath(new URL(name, assets));

const metadata = JSON.parse(execFileSync(ffprobe, [
  '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', input,
], {encoding: 'utf8'}));
const duration = Number(metadata.format.duration);
if (!Number.isFinite(duration) || duration < 1) {
  throw new Error('Render the complete scene with the Video (FFmpeg) exporter first.');
}

await mkdir(assets, {recursive: true});
await copyFile(input, asset('switchboard-routing.mp4'));
execFileSync(ffmpeg, [
  '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
  '-filter_complex',
  'fps=12,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a',
  '-loop', '0', asset('switchboard-routing.gif'),
], {stdio: 'inherit'});
execFileSync(ffmpeg, [
  '-hide_banner', '-loglevel', 'error', '-y', '-ss', String(duration - 0.2),
  '-i', input, '-frames:v', '1', asset('switchboard-routing-poster.png'),
], {stdio: 'inherit'});
console.log(`Exported MP4, GIF, and poster to assets (${duration.toFixed(1)} seconds).`);
