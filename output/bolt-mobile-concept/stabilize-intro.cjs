const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const sharp = require('sharp');
const dir = __dirname;
const edition = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
const ffmpeg = process.env.FFMPEG_PATH || path.join(process.env.USERPROFILE, '.codex/tmp/bolt-video-tools/node_modules/ffmpeg-static/ffmpeg.exe');
const framePath = i => path.join(dir, 'assets/intro', String(i).padStart(5, '0') + '.jpg');
async function differences() {
  let previous;
  const values = [];
  for (let i = 0; i < Math.round(edition.swipeStart * 60); i++) {
    const pixels = await sharp(framePath(i)).extract({ left: 200, top: 700, width: 650, height: 750 }).resize(130, 150).raw().toBuffer();
    if (previous) {
      let total = 0;
      for (let j = 0; j < pixels.length; j++) total += Math.abs(pixels[j] - previous[j]);
      values.push({ frame: i, difference: total / pixels.length });
    }
    previous = pixels;
  }
  return values;
}
(async () => {
  const before = await differences();
  const frozen = before.filter(item => item.difference < 0.1);
  const scratch = path.join(dir, 'assets/intro-repair');
  fs.mkdirSync(scratch, { recursive: true });
  for (const { frame } of frozen) {
    assert.ok(frame > 0 && frame < Math.round(edition.swipeStart * 60) - 1, 'Cannot interpolate an endpoint');
    // Only repair isolated missing GPU submissions, preserving every other
    // captured frame and the original timing. Motion estimation reconstructs
    // the midpoint rather than blending two visible copies of the disc.
    for (let i = 0; i < 4; i++) fs.copyFileSync(framePath(i === 0 ? frame - 1 : frame + 1), path.join(scratch, `${i}.jpg`));
    const result = spawnSync(ffmpeg, ['-hide_banner', '-y', '-loglevel', 'error', '-framerate', '30', '-i', path.join(scratch, '%d.jpg'), '-vf', "minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,select='eq(n,1)'", '-frames:v', '1', '-q:v', '2', framePath(frame)], { windowsHide: true });
    assert.equal(result.status, 0, result.stderr?.toString());
  }
  const after = await differences();
  assert.ok(after.every(item => item.difference > 0.1), 'Frozen player frames remain');
  const median = after.map(item => item.difference).sort((a,b) => a-b)[Math.floor(after.length / 2)];
  assert.ok(Math.max(...after.map(item => item.difference)) < median * 2.5, 'Large motion jump remains');
  const metadataPath = path.join(dir, 'intro.json');
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  metadata.playerMotion.captureVerification = { repairedFrames: frozen.map(item => item.frame), frozenFrames: 0, checkedTransitions: after.length, minDifference: Math.min(...after.map(item => item.difference)), maxDifference: Math.max(...after.map(item => item.difference)), medianDifference: median };
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + '\n');
  console.log(JSON.stringify(metadata.playerMotion.captureVerification, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
