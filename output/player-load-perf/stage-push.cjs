const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const git = (...args) => execFileSync('git', args, {encoding:'utf8'});
const read = path => readFileSync(path,'utf8').replace(/\r\n/g,'\n');
function stageBlob(path, content) {
  const hash = execFileSync('git',['hash-object','-w','--stdin'],{input:content,encoding:'utf8'}).trim();
  git('update-index','--add','--cacheinfo',`100644,${hash},${path}`);
}
const desktopPath='frontend/src/components/DesktopCdPlayer.jsx';
let desktop=read(desktopPath);
for (const [before,after] of [
  ["import { haptic, HAPTIC } from '../utils/haptics'\n",''],
  ["transform: setupPreview ? 'translate(20px, 12px) scale(0.97)' : 'translateY(100%)'", "transform: 'translate(20px, 12px) scale(0.97)'"],
  ['[screenActive, modelStatus, powerSave, setupPreview]','[screenActive, modelStatus, powerSave]'],
  ['    if (swipeCommitted) haptic(HAPTIC.selection, { allowDomFallback: false })\n',''],
]) {assert.ok(desktop.includes(before),before);desktop=desktop.replace(before,after)}
stageBlob(desktopPath,desktop);
const cssPath='frontend/src/pages/PlayerSetup.css';
const cssCurrent=read(cssPath);
let css=git('show',`HEAD:${cssPath}`);
const line = prefix => {const value=cssCurrent.split('\n').find(line=>line.startsWith(prefix));assert.ok(value,prefix);return value};
const device=line('.unboxing-device {');
assert.ok(css.includes(device));
css=css.replace(device,device+'\n'+line('.unboxing-device-shadow {')+'\n'+line(".unboxing-scene[data-phase='lifting-top'] .unboxing-device-shadow"));
for (const prefix of ['.unboxing-lid-face {','.unboxing-lid-face--inner {']) {
  const old=css.split('\n').find(line=>line.startsWith(prefix));assert.ok(old,prefix);
  const comment=prefix.includes('--inner') ? "/* A visually imperceptible initial opacity prepares the inside face's layer\n   while the box is sealed, instead of allocating it halfway through opening. */\n" : '';
  css=css.replace(old,comment+line(prefix));
}
stageBlob(cssPath,css);
git('add','--',
  'frontend/package.json','frontend/scripts/bake-cd-software-frames.mjs','frontend/scripts/offline-ui-manifest.mjs',
  'frontend/scripts/bake-cd-studio-environment.mjs','frontend/scripts/cd-studio-environment-source.mjs',
  'frontend/src/assets/cd-studio-environment.bin.gzip','frontend/src/components/UnboxPlayer.jsx',
  'frontend/src/utils/cdDeckScene.js','frontend/src/utils/cdCanvasSize.js','frontend/src/utils/cdGeometry.worker.js',
  'frontend/src/utils/cdGeometryBatch.js','frontend/src/utils/cdGeometryLoad.js','frontend/src/utils/cdMergeVertices.js',
  'frontend/src/utils/cdSceneLoadTask.js','frontend/src/utils/cdStudioEnvironment.js','frontend/src/utils/cdStudioEnvironmentData.js',
  'frontend/tests/cdSceneLoad.test.mjs','frontend/tests/offlineShell.test.mjs');
const files=execFileSync('git',['ls-files','-z','frontend']);
execFileSync('git',['-c','core.autocrlf=false','checkout-index','--force','--prefix=output/player-load-perf/push-check/','--stdin','-z'],{input:files});
console.log(git('diff','--cached','--stat'));
