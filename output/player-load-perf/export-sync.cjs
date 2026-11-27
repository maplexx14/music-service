const {execFileSync}=require('node:child_process');
const {copyFileSync}=require('node:fs');
const files=execFileSync('git',['ls-files','-z','frontend']);
execFileSync('git',['-c','core.autocrlf=false','checkout-index','--force','--prefix=output/player-load-perf/sync-check/','--stdin','-z'],{input:files});
copyFileSync('output/player-load-perf/push-check/frontend/push-check.sh','output/player-load-perf/sync-check/frontend/push-check.sh');
