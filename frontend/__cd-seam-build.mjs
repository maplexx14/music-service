import { build } from 'vite'
import { copyFile } from 'node:fs/promises'

await build({
  base: '/__cd-motion-check/',
  publicDir: false,
  logLevel: 'warn',
  plugins: [{
    name: 'cd-playback-motion-fixture',
    enforce: 'pre',
    transform(source, id) {
      if (id.endsWith('/__cd-preview.jsx')) {
        return "import './src/components/Player.css';\n" + source
          .replace('window.__store = usePlayerStore', 'window.__uiStore = useUiSettingsStore; window.__store = usePlayerStore')
          .replace("cover_url: '/__cd-preview-cover.jpg'", "cover_url: '/__cd-motion-check/cover.jpg'")
          .replace('<DesktopCdPlayer onPlay=', '<DesktopCdPlayer presentation={new URLSearchParams(location.search).get("presentation") || "default"} onPlay=')
          .replace("createRoot(document.getElementById('root')).render", "window.__heartbeat = setInterval(() => { const state=usePlayerStore.getState(); if(state.isPlaying && window.__heartbeatEnabled !== false) usePlayerStore.setState({currentTime:state.currentTime+0.25}); }, 250); createRoot(document.getElementById('root')).render")
      }
      if (id.endsWith('/cdGpuVolume.js')) return source.replace('antialias: true', 'antialias: !new URLSearchParams(location.search).has("no-msaa")')
      if (id.endsWith('/cdDeckScene.js')) {
        return source
          .replace('getMotionTransform: () => playbackMotion?.transform()', 'getMotionTransform: () => window.__comparisonTransform || playbackMotion?.transform()')
          .replace('playbackVolume.setVisible(cropped && canRender() && !powerSave && !reduced.matches)', 'playbackVolume.setVisible(cropped && canRender() && !powerSave && !reduced.matches && !window.__forceFlat)')
          .replace('renderer.setClearColor(0x000000, 0)', `renderer.setClearColor(0x000000, 0);
            window.__renderer = renderer;
            const fixtureRender = renderer.render;
            renderer.render = function(...args) { window.__glCalls = (window.__glCalls || 0) + 1; return fixtureRender.apply(this, args); };`)
          .replace(/return\s*\{\s*setState,/, `
          window.__compareModel = angle => {
            window.__comparisonTransform = volumeSkipTransform(angle);
            const pose = camera.clone();
            positionCamera(pose, {theta:angle,phi:0,roll:-angle*0.065/0.28,zoom:Math.abs(angle)*0.025/0.28,lift:0});
            const original = new WebGLRenderer({alpha:true,antialias:true,preserveDrawingBuffer:true});
            original.setPixelRatio(2); original.setSize(frameWidth,frameHeight);
            original.outputColorSpace=renderer.outputColorSpace;original.toneMapping=renderer.toneMapping;original.toneMappingExposure=renderer.toneMappingExposure;
            original.shadowMap.enabled=true;original.shadowMap.type=renderer.shadowMap.type;
            original.render(scene,pose);
            const bitmap=document.createElement('img');bitmap.src=original.domElement.toDataURL();bitmap.id='comparison-original';
            Object.assign(bitmap.style,{position:'absolute',left:staticCanvas.offsetLeft+'px',top:'0',width:frameWidth+'px',height:frameHeight+'px',zIndex:'100',display:'none'});
            canvas.parentElement.append(bitmap);original.dispose();
            gpuVolume?.sync(true,true);
            return {angle,volume:playbackVolume?.status(),gpu:gpuVolume?.status()};
          };
          window.__frameStatus = () => softwareFrames?.status();
          window.__carouselMotion = trackCarouselMotion;
          window.__showPose = angle => softwareFrames?.present(angle);
          window.__resetPose = () => softwareFrames?.stop();
          window.__camera = camera;
          window.__worldPoint = (x, y, z) => {
            const world = new Vector3(x, y, z), point = world.clone().project(softwareFrames?.camera || camera);
            const marker = document.createElement('span');
            Object.assign(marker.style, { position:'absolute',width:'0',height:'0',pointerEvents:'none',
              left:(canvas.offsetLeft+(point.x+1)*canvas.clientWidth/2)+'px',
              top:(canvas.offsetTop+(1-point.y)*canvas.clientHeight/2)+'px' });
            if (playbackVolume?.visible) Object.assign(marker.style, { left:'0',top:'0',transformOrigin:'0 0',
              transform:cdCssMatrixTransform(playbackVolume.matrix.clone().multiply(new Matrix4().makeTranslation(x,y,z))) });
            canvas.parentElement.append(marker);
            const rect=marker.getBoundingClientRect(); marker.remove(); return {x:rect.left,y:rect.top};
          };
          window.__nativePoint = (action) => {
            const world = (action === 'volume' ? volume : buttons[action].group).getWorldPosition(new Vector3());
            if (playbackVolume?.visible) return window.__worldPoint(world.x,world.y,world.z);
            const point = world.project(softwareFrames?.camera || camera);
            const surface = staticCanvas || canvas;
            const marker = document.createElement('span');
            Object.assign(marker.style, {
              position: 'absolute', width: '0px', height: '0px', pointerEvents: 'none',
              left: (surface.offsetLeft + (point.x + 1) * surface.clientWidth / 2) + 'px',
              top: (surface.offsetTop + (1 - point.y) * surface.clientHeight / 2) + 'px'
            });
            surface.parentElement.append(marker);
            const rect = marker.getBoundingClientRect();
            marker.remove();
            return { x: rect.left, y: rect.top };
          };
          return window.__sceneApi = { setState,`)
      }
      if (id.endsWith('/cdSoftwareFrames.js')) {
        return source.replace('function draw(angle) {', 'function draw(angle) { (window.__poseSamples ||= []).push({at:performance.now(),angle});')
      }
      return null
    },
  }],
  build: {
    outDir: 'dist/__cd-motion-check',
    emptyOutDir: true,
    rollupOptions: { input: '/app/__cd-preview.html' },
  },
})
await copyFile('/app/__cd-preview-cover.jpg', '/app/dist/__cd-motion-check/cover.jpg')

