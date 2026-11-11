const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ffmpeg = process.env.FFMPEG_PATH || path.join(process.env.USERPROFILE, '.codex/tmp/bolt-video-tools/node_modules/ffmpeg-static/ffmpeg.exe');
const input = path.join(__dirname, 'bolt-agas-karaoke-v2.mp4');
const output = path.join(__dirname, 'bolt-agas-karaoke-v3.mp4');
const fps = 30, sampleRate = 48000;
// V2 contains a measured silence at 3.20312–4.17454 s. Remove 21 complete
// frames from its middle, together with exactly the same 33,600 audio samples.
const fromFrame = 101, toFrame = 122;
const fromSample = fromFrame * sampleRate / fps;
const toSample = toFrame * sampleRate / fps;
const duration = 16 - (toFrame - fromFrame) / fps;
const filter = [
  '[0:v]split=2[iv0][iv1]',
  `[iv0]trim=end_frame=${fromFrame},setpts=PTS-STARTPTS[v0]`,
  `[iv1]trim=start_frame=${toFrame},setpts=PTS-STARTPTS[v1]`,
  '[0:a]asplit=2[ia0][ia1]',
  `[ia0]atrim=end_sample=${fromSample},asetpts=PTS-STARTPTS[a0]`,
  `[ia1]atrim=start_sample=${toSample},asetpts=PTS-STARTPTS[a1]`,
  '[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]',
].join(';');
const result = spawnSync(ffmpeg, [
  '-hide_banner', '-y', '-loglevel', 'error', '-i', input,
  '-filter_complex', filter, '-map', '[v]', '-map', '[a]',
  '-c:v', 'libx264', '-preset', 'fast', '-crf', '17', '-pix_fmt', 'yuv420p', '-r', String(fps),
  '-c:a', 'aac', '-ar', String(sampleRate), '-b:a', '192k',
  '-t', String(duration), '-movflags', '+faststart', output,
], { windowsHide: true, encoding: 'utf8' });
if (result.status !== 0) throw new Error(result.stderr);
const silent = spawnSync(ffmpeg, [
  '-hide_banner', '-y', '-loglevel', 'error', '-i', output, '-c:v', 'copy', '-an',
  '-movflags', '+faststart', path.join(__dirname, 'bolt-agas-karaoke-v3-silent.mp4'),
], { windowsHide: true, encoding: 'utf8' });
if (silent.status !== 0) throw new Error(silent.stderr);
const edit = {
  input: path.basename(input), output: path.basename(output),
  cutFromSeconds: fromFrame / fps, cutToSeconds: toFrame / fps,
  removedSeconds: (toFrame - fromFrame) / fps, duration,
  frames: Math.round(duration * fps),
  note: 'Video and audio cut together inside silence; existing karaoke sync and 1.1x speed preserved.',
};
fs.writeFileSync(path.join(__dirname, 'pause-edit-v3.json'), JSON.stringify(edit, null, 2) + '\n');
console.log(JSON.stringify(edit, null, 2));
