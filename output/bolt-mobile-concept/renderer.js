/* The UI is a sequence captured from the real localhost app. This file adds only the film's camera, background and titles. */
const canvas = document.getElementById('film');
const ctx = canvas.getContext('2d', { alpha: false });
const W = 1080, H = 1920, FPS = 60;
const edition = window.BOLT_EDITION;
const homeIntro = window.BOLT_INTRO;
const INTRO_DURATION = edition.introDuration, ENDING_SPEED = edition.endingSpeed, DURATION = edition.filmDuration;
canvas.width=W;canvas.height=H;
const meta = window.BOLT_CAPTURE;
if (!meta) throw new Error('Run capture.cjs and render.cjs to prepare the localhost recording.');
const C = { white: '#f7f3fb', accent: '#b68aff', muted: '#b9adc9' };
const clamp = x => Math.max(0, Math.min(1, x));
const mix = (a, b, p) => a + (b - a) * p;
const smooth = x => { x = clamp(x); return x * x * (3 - 2 * x); };
const out = x => 1 - Math.pow(1 - clamp(x), 4);
const easeInOut = x => { x = clamp(x); return x < .5 ? 8 * x ** 4 : 1 - 8 * (1 - x) ** 4; };
function asset(name) { const i = new Image(); i.src = 'assets/' + name; return i; }
const logo = asset('bolt.webp'), mark = asset('mark.png');
const artists = [asset('artist-1.jpg'), asset('artist-2.jpg'), asset('artist-3.jpg')];
const beforeSwitch = asset('live/00068.jpg');
const intro = asset('live/00000.jpg');
const pointerImage = new Image();
pointerImage.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 48 48"><circle cx="24" cy="24" r="21" fill="white" fill-opacity=".08" stroke="white" stroke-opacity=".28" stroke-width="1"/><circle cx="24" cy="24" r="12" fill="white" fill-opacity=".23"/></svg>');

// Perspective-correct textured plane. Coordinates stay in the app's CSS pixels.
const plane = document.createElement('canvas');
plane.width = W; plane.height = H;
const gl = plane.getContext('webgl', { alpha: true, antialias: true, preserveDrawingBuffer: true, premultipliedAlpha: true });
if (!gl) throw new Error('WebGL is needed for the perspective camera.');
function shader(type, source) {
  const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
const program = gl.createProgram();
gl.attachShader(program, shader(gl.VERTEX_SHADER, `
  precision highp float;
  attribute vec2 aUv;
  uniform vec2 uSource, uFocus, uScreen, uOutput;
  uniform vec3 uRotation;
  uniform float uScale;
  varying vec2 vUv;
  void main() {
    vUv = aUv;
    vec3 p = vec3((aUv * uSource - uFocus) * uScale, 0.0);
    float cy = cos(uRotation.y), sy = sin(uRotation.y);
    p = vec3(cy*p.x + sy*p.z, p.y, -sy*p.x + cy*p.z);
    float cx = cos(uRotation.x), sx = sin(uRotation.x);
    p = vec3(p.x, cx*p.y - sx*p.z, sx*p.y + cx*p.z);
    float cr = cos(uRotation.z), sr = sin(uRotation.z);
    p.xy = vec2(cr*p.x - sr*p.y, sr*p.x + cr*p.y);
    float depth = 1.0 + p.z / 2200.0;
    vec2 screen = p.xy + (uScreen - uOutput * 0.5) * depth;
    gl_Position = vec4(screen.x * 2.0 / uOutput.x, -screen.y * 2.0 / uOutput.y, 0.0, depth);
  }
`));
gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uImage;
  uniform sampler2D uOldImage;
  uniform sampler2D uPointerImage;
  uniform vec2 uSource;
  uniform vec2 uPulseCenter;
  uniform vec4 uCrop;
  uniform vec4 uPointer;
  uniform float uRadius, uShadow, uSwitch, uPulse;
  uniform vec2 uUiBlur;
  vec3 soften(sampler2D image, vec2 uv, float blur) {
    vec2 delta = vec2(blur) / uSource;
    return texture2D(image,uv).rgb*0.4 +
      (texture2D(image,uv+vec2(delta.x,0.0)).rgb + texture2D(image,uv-vec2(delta.x,0.0)).rgb +
       texture2D(image,uv+vec2(0.0,delta.y)).rgb + texture2D(image,uv-vec2(0.0,delta.y)).rgb)*0.15;
  }
  float roundedBox(vec2 p, vec2 halfSize, float radius) {
    vec2 q = abs(p) - halfSize + radius;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
  }
  void main() {
    vec2 px = vUv * uSource;
    vec2 center = vec2((uCrop.x + uCrop.z)*0.5, (uCrop.y + uCrop.w)*0.5);
    vec2 halfSize = vec2(uCrop.z-uCrop.x, uCrop.w-uCrop.y)*0.5;
    if (uShadow > 0.5) {
      float d = roundedBox(px - center - vec2(0.0, 17.0), halfSize, uRadius);
      float alpha = exp(-pow(max(d, 0.0)/22.0, 2.0))*0.55;
      gl_FragColor = vec4(0.0, 0.0, 0.0, alpha);
    } else {
      float d = roundedBox(px - center, halfSize, uRadius);
      float alpha = 1.0 - smoothstep(-0.75, 0.75, d);
      vec3 color = texture2D(uImage, clamp(vUv, 0.0, 1.0)).rgb;
      if(uUiBlur.x>0.0&&px.y<uUiBlur.y){
        vec2 delta=vec2(uUiBlur.x/uSource.x,0.0);
        color=texture2D(uImage,vUv).rgb*0.20;
        color+=(texture2D(uImage,vUv+delta).rgb+texture2D(uImage,vUv-delta).rgb)*0.17;
        color+=(texture2D(uImage,vUv+2.0*delta).rgb+texture2D(uImage,vUv-2.0*delta).rgb)*0.12;
        color+=(texture2D(uImage,vUv+3.0*delta).rgb+texture2D(uImage,vUv-3.0*delta).rgb)*0.075;
        color+=(texture2D(uImage,vUv+4.0*delta).rgb+texture2D(uImage,vUv-4.0*delta).rgb)*0.035;
      }
      if (uSwitch < 1.0 && px.y > 128.0) {
        float blur = sin(uSwitch * 3.14159265)*2.0;
        vec2 nextUv = vUv - vec2((1.0-uSwitch)*18.0/uSource.x,0.0);
        vec2 oldUv = vUv + vec2(uSwitch*14.0/uSource.x,0.0);
        color = mix(soften(uOldImage,oldUv,blur),soften(uImage,nextUv,blur),uSwitch);
      }
      color = pow(color,vec3(1.13));
      if (uPulse > 0.0 && uPulse < 1.0) {
        float radius = length(px-uPulseCenter);
        float ring = exp(-pow((radius-(39.0+23.0*uPulse))/3.0,2.0))*(1.0-uPulse)*0.20;
        float glow = exp(-pow((radius-39.0)/13.0,2.0))*sin(uPulse*3.14159265)*0.08;
        color += vec3(0.61,0.32,0.93)*(ring+glow);
      }
      if (uPointer.z > 0.0) {
        vec2 pointerUv = (px-uPointer.xy)/(vec2(48.0,48.0)*uPointer.w);
        if (pointerUv.x>=0.0 && pointerUv.x<=1.0 && pointerUv.y>=0.0 && pointerUv.y<=1.0) {
          vec4 pointer = texture2D(uPointerImage,pointerUv);
          color = mix(color,pointer.rgb,pointer.a*uPointer.z);
        }
      }
      float border = smoothstep(-1.8, -0.45, d)*0.065;
      color = mix(color, vec3(0.73, 0.66, 0.84), border);
      gl_FragColor = vec4(color*alpha, alpha);
    }
  }
`));
gl.linkProgram(program);
if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
gl.useProgram(program);
const locations = Object.fromEntries(['uSource','uFocus','uScreen','uOutput','uRotation','uScale','uImage','uOldImage','uPointerImage','uPointer','uCrop','uRadius','uShadow','uSwitch','uPulse','uPulseCenter','uUiBlur'].map(name => [name, gl.getUniformLocation(program, name)]));
const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-.07,-.07, 1.07,-.07, -.07,1.07, -.07,1.07, 1.07,-.07, 1.07,1.07]), gl.STATIC_DRAW);
const position = gl.getAttribLocation(program, 'aUv'); gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
const textureCanvas=document.createElement('canvas');textureCanvas.width=2048;textureCanvas.height=2048;
const textureCtx=textureCanvas.getContext('2d',{alpha:false});textureCtx.imageSmoothingQuality='high';
function uploadUi(image) {
  textureCtx.drawImage(image,0,0,textureCanvas.width,textureCanvas.height);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,textureCanvas);
  gl.generateMipmap(gl.TEXTURE_2D);
}
gl.activeTexture(gl.TEXTURE1);
const oldTexture = gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,oldTexture);
gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
const oldReady=beforeSwitch.decode().then(()=>{gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,oldTexture);uploadUi(beforeSwitch);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture)});
gl.activeTexture(gl.TEXTURE2);
const pointerTexture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,pointerTexture);
gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
const pointerReady=pointerImage.decode().then(()=>{gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D,pointerTexture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,pointerImage);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture)});
gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);
gl.uniform1i(locations.uImage, 0);gl.uniform1i(locations.uOldImage,1);gl.uniform1i(locations.uPointerImage,2);gl.uniform1f(locations.uSwitch,1);
gl.uniform2f(locations.uPulseCenter,meta.controls.x,meta.controls.y);
gl.uniform2f(locations.uSource, meta.width, meta.height); gl.uniform2f(locations.uOutput, W, H);
gl.viewport(0, 0, W, H); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

// Average shutter samples entirely on the GPU. Running averages preserve identical
// pixel values and avoid the brightness steps of additive 8-bit canvas blending.
const presentProgram=gl.createProgram();
gl.attachShader(presentProgram,shader(gl.VERTEX_SHADER,'attribute vec2 aPosition;varying vec2 vUv;void main(){vUv=aPosition*0.5+0.5;gl_Position=vec4(aPosition,0.0,1.0);}'));
gl.attachShader(presentProgram,shader(gl.FRAGMENT_SHADER,'precision highp float;uniform sampler2D uFrame;varying vec2 vUv;void main(){gl_FragColor=texture2D(uFrame,vUv);}'));
gl.linkProgram(presentProgram);if(!gl.getProgramParameter(presentProgram,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(presentProgram));
const fullPosition=gl.getAttribLocation(presentProgram,'aPosition'),frameSampler=gl.getUniformLocation(presentProgram,'uFrame');
const fullBuffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,fullBuffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
function target() {
  gl.activeTexture(gl.TEXTURE3);const image=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,image);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,W,H,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
  const framebuffer=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,image,0);
  if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('Motion framebuffer is incomplete.');
  return {image,framebuffer};
}
const sampleTarget=target(),motionTarget=target();gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);
function present(image,framebuffer,index) {
  gl.useProgram(presentProgram);gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);
  gl.bindBuffer(gl.ARRAY_BUFFER,fullBuffer);gl.enableVertexAttribArray(fullPosition);gl.vertexAttribPointer(fullPosition,2,gl.FLOAT,false,0,0);
  gl.activeTexture(gl.TEXTURE3);gl.bindTexture(gl.TEXTURE_2D,image);gl.uniform1i(frameSampler,3);
  if(index>0){gl.enable(gl.BLEND);gl.blendColor(0,0,0,1/(index+1));gl.blendFunc(gl.CONSTANT_ALPHA,gl.ONE_MINUS_CONSTANT_ALPHA)}else gl.disable(gl.BLEND);
  gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
  gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);
}
const cache = new Map();
const partialFrames = [0,36,68,72,114,150,161,170,186,222,258,280,281,282,283,286,294,312,336,366,395];
async function liveFrame(t) {
  if(t<66/meta.fps){await intro.decode();return intro;}
  let frame = Math.max(0, Math.min(meta.count - 1, Math.round(t * meta.fps)));
  if (meta.partial) frame = partialFrames.reduce((a, b) => Math.abs(b-frame) < Math.abs(a-frame) ? b : a);
  if (!cache.has(frame)) {
    const i = new Image(); i.src = `assets/live/${String(frame).padStart(5, '0')}.jpg`;
    cache.set(frame, { image: i, ready: i.decode() });
  }
  const entry = cache.get(frame); await entry.ready;
  for (const key of cache.keys()) if (key < frame - 3 || key > frame + 3) cache.delete(key);
  return entry.image;
}
const introCache = new Map();
async function homeFrame(t) {
  const frame = Math.max(0,Math.min(homeIntro.count-1,Math.round(t*homeIntro.fps)));
  if(!introCache.has(frame)) {
    const image=new Image();image.src=`assets/intro/${String(frame).padStart(5,'0')}.jpg`;
    introCache.set(frame,{image,ready:image.decode()});
  }
  const entry=introCache.get(frame);await entry.ready;
  for(const key of introCache.keys())if(Math.abs(key-frame)>3)introCache.delete(key);
  return entry.image;
}

const rowY = meta.selectedRow.y, playX = meta.controls.x, playY = meta.controls.y;
const keys = [
  {t:0,    x:195,y:410,s:2.16,rx:3.5,ry:-7,rz:-1,ox:566,oy:980,a:1,c:0},
  {t:.95,  x:195,y:415,s:2.03,rx:2,ry:-3,rz:-.3,ox:540,oy:950,a:1,c:0},
  {t:1.6,  x:195,y:420,s:2.04,rx:1,ry:-2,rz:0,ox:540,oy:950,a:1,c:0},
  {t:2.18, x:195,y:Math.max(rowY,470),s:2.12,rx:1,ry:2,rz:0,ox:540,oy:900,a:1,c:0},
  {t:2.6,  x:195,y:meta.miniCover.y-15,s:2.50,rx:1,ry:3,rz:0,ox:540,oy:940,a:1,c:0},
  {t:3.20, x:195,y:420,s:2.04,rx:1,ry:-2,rz:0,ox:540,oy:950,a:1,c:0},
  {t:3.88, x:195,y:422,s:2.04,rx:0,ry:-1,rz:0,ox:540,oy:950,a:1,c:0},
  {t:4.40, x:playX,y:playY-38,s:2.92,rx:-1,ry:2,rz:0,ox:540,oy:1070,a:1,c:0},
  {t:4.94, x:playX,y:playY-38,s:2.88,rx:0,ry:0,rz:0,ox:540,oy:1070,a:1,c:0},
  {t:5.60, x:195,y:422,s:2.04,rx:0,ry:1,rz:0,ox:540,oy:950,a:1,c:0},
  {t:6.20, x:195,y:422,s:2.03,rx:0,ry:-1,rz:0,ox:540,oy:950,a:1,c:0},
  {t:6.60, x:195,y:422,s:2.02,rx:1,ry:-8,rz:-1,ox:-540,oy:950,a:0,c:0},
];
const cameraChannels=['x','y','s','rx','ry','rz','ox','oy','a','c'];
const tangents=Object.fromEntries(cameraChannels.map(channel=>{
  const delta=keys.slice(1).map((key,i)=>(key[channel]-keys[i][channel])/(key.t-keys[i].t));
  const slopes=keys.map((key,i)=>{
    if(i===0||i===keys.length-1)return 0;
    if(delta[i-1]*delta[i]<=0)return 0;
    const h0=key.t-keys[i-1].t,h1=keys[i+1].t-key.t,w0=2*h1+h0,w1=h1+2*h0;
    return (w0+w1)/(w0/delta[i-1]+w1/delta[i]);
  });
  return [channel,slopes];
}));
function camera(t) {
  if (t <= 0) return keys[0];
  let i = keys.findIndex(k => k.t >= t); if (i < 0) return keys.at(-1);
  const b = keys[i], a = keys[Math.max(0, i-1)];
  const span=b.t-a.t,p=clamp((t-a.t)/span),p2=p*p,p3=p2*p;
  const result = {};
  for(const channel of cameraChannels)result[channel]=(2*p3-3*p2+1)*a[channel]+(p3-2*p2+p)*span*tangents[channel][i-1]+(-2*p3+3*p2)*b[channel]+(p3-p2)*span*tangents[channel][i];
  return result;
}
function pointerAt(t,isIntro=false) {
  if(isIntro) {
    const gesture=homeIntro.gesture,p=(t-gesture.start)/(gesture.release-gesture.start);
    if(p>=0&&p<=1.1){const q=clamp(p),eased=q*q*q*(10+q*(-15+6*q));return {x:mix(gesture.from.x,gesture.to.x,eased),y:gesture.from.y,alpha:Math.min(1,clamp(p/.12),clamp((1.1-p)/.12))*.9,scale:.8};}
    const pause=homeIntro.pauseAction,u=(t-pause.time)/.25;
    if(u>=0&&u<=1)return {...pause.point,alpha:Math.sin(Math.PI*u)*.82,scale:.55+.55*out(u)};
    return {x:0,y:0,alpha:0,scale:1};
  }
  const taps=[{at:70/FPS,point:meta.best},{at:meta.openAt,point:meta.miniCover},{at:meta.playAt,point:meta.controls}];
  for(const tap of taps){const p=(t-tap.at)/.30;if(p>=0&&p<=1)return {...tap.point,alpha:Math.sin(Math.PI*p)*.82,scale:.55+.55*out(p)};}
  return {x:0,y:0,alpha:0,scale:1};
}
function drawPlane(cam,t,isIntro=false) {
  gl.useProgram(program);gl.bindFramebuffer(gl.FRAMEBUFFER,sampleTarget.framebuffer);
  gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
  gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
  const pointer=pointerAt(t,isIntro);gl.uniform4f(locations.uPointer,pointer.x-24*pointer.scale,pointer.y-24*pointer.scale,pointer.alpha,pointer.scale);
  // Samples taken just before the click must still show the previous results,
  // even when this output frame already contains the new captured bitmap.
  const switchedAt=70/meta.fps;gl.uniform1f(locations.uSwitch,isIntro?1:out((t-switchedAt)/.28));
  const gesture=homeIntro.gesture,p=clamp((t-gesture.start)/(gesture.release-gesture.start));
  const velocity=isIntro?Math.abs(gesture.to.x-gesture.from.x)/(gesture.release-gesture.start)*30*p*p*(1-p)*(1-p):0;
  gl.uniform2f(locations.uUiBlur,Math.min(1.25,velocity*.6/FPS/12),meta.miniCover.y-36);
  gl.uniform1f(locations.uPulse,!isIntro&&t>=meta.playAt&&t<meta.playAt+.42?clamp((t-meta.playAt)/.42):0);
  gl.uniform2f(locations.uFocus, cam.x, cam.y); gl.uniform2f(locations.uScreen, cam.ox, cam.oy);
  gl.uniform1f(locations.uScale, cam.s); gl.uniform3f(locations.uRotation, cam.rx*Math.PI/180, cam.ry*Math.PI/180, cam.rz*Math.PI/180);
  gl.uniform4f(locations.uCrop,0,0,meta.width,meta.height);
  gl.uniform1f(locations.uRadius,17);
  gl.uniform1f(locations.uShadow, 1); gl.drawArrays(gl.TRIANGLES,0,6);
  gl.uniform1f(locations.uShadow, 0); gl.drawArrays(gl.TRIANGLES,0,6);
}
function background(t) {
  ctx.fillStyle = '#070609'; ctx.fillRect(0,0,W,H);
  const fade = 1 - smooth((t-11.66)/.24);
  ctx.save(); ctx.globalAlpha = fade;
  let g = ctx.createRadialGradient(40 + Math.sin(t*.24)*45,-70,0,40,-70,1500);
  g.addColorStop(0,'#7338a842'); g.addColorStop(.47,'#3820491a'); g.addColorStop(1,'#10091300'); ctx.fillStyle=g; ctx.fillRect(0,0,W,H);
  g=ctx.createRadialGradient(1050,1600,0,1050,1600,1050); g.addColorStop(0,'#53348022'); g.addColorStop(1,'#0000'); ctx.fillStyle=g; ctx.fillRect(0,0,W,H);
  g=ctx.createRadialGradient(540,1250,30,540,1250,850); g.addColorStop(0,'#41344c10'); g.addColorStop(1,'#0000'); ctx.fillStyle=g; ctx.fillRect(0,0,W,H);
  ctx.restore();
}
function text(value,x,y,size,color=C.white,weight=500,align='left') {
  ctx.font=`${weight} ${size}px Geologica`; ctx.fillStyle=color; ctx.textAlign=align; ctx.textBaseline='middle'; ctx.fillText(value,x,y);
}
function width(value,size,weight=500) { ctx.font=`${weight} ${size}px Geologica`; return ctx.measureText(value).width; }
function word(value,x,y,size,t,at,color=C.white,weight=500) {
  const p=out((t-at)/.22);
  ctx.save(); ctx.globalAlpha*=p; ctx.translate(0,(1-p)*12); ctx.filter=`blur(${(1-p)*3}px)`; text(value,x,y,size,color,weight); ctx.restore();
}
function avatar(i,x,y,size,t,start) {
  const p=out((t-start)/.24);
  ctx.save(); ctx.globalAlpha*=p; ctx.translate(x,y+(1-p)*11); ctx.rotate((1-p)*-.12); ctx.scale(.88+.12*p,.88+.12*p);
  ctx.beginPath();ctx.arc(0,0,size/2,0,Math.PI*2);ctx.fillStyle='#24202b';ctx.fill();ctx.clip();ctx.drawImage(i,-size/2,-size/2,size,size);ctx.restore();
  ctx.save();ctx.globalAlpha*=p;ctx.strokeStyle='#b987ffb3';ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(x,y+(1-p)*11,(size/2)*(.88+.12*p),0,Math.PI*2);ctx.stroke();ctx.restore();
}
function firstTitle(t) {
  ctx.save();ctx.globalAlpha=1-smooth((t-8.14)/.14);
  word('Находи',540-width('Находи',76)/2,740,76,t,6.60);
  word('свою музыку.',540-width('свою музыку.',76)/2,836,76,t,6.71,C.accent);
  artists.forEach((image,i)=>{
    const x=280+i*260,start=6.83+i*.065;avatar(image,x,1065,144,t,start);
    const p=out((t-start-.08)/.23);ctx.save();ctx.globalAlpha*=p;text(meta.artistImages[i],x,1180+14*(1-p),i===2?34:38,C.white,500,'center');ctx.restore();
  });ctx.restore();
}
function phrase(parts,t,start,end,size) {
  ctx.save();ctx.globalAlpha=1-smooth((t-end+.11)/.11);
  parts.forEach((part,i)=>word(part[0],540-width(part[0],size)/2,920+(i-(parts.length-1)/2)*104,size,t,start+i*.085,part[1]||C.white));ctx.restore();
}
function brand(t) {
  const enter=out((t-10.10)/.23), reveal=out((t-10.39)/.45), leave=1-smooth((t-11.64)/.11);
  const size=mix(164,183,enter), move=83*reveal;
  ctx.save();ctx.globalAlpha=enter*leave*(1-smooth((reveal-.23)/.5));ctx.translate(540-move,920);ctx.rotate((1-enter)*-.16);ctx.drawImage(mark,-size/2,-size/2,size,size);ctx.restore();
  if(reveal>0) {
    const w=mix(576,615,reveal),h=w*logo.height/logo.width;
    ctx.save();ctx.globalAlpha=leave;ctx.beginPath();ctx.rect(540-w*reveal/2,920-h/2-4,w*reveal,h+8);ctx.clip();ctx.drawImage(logo,540-w/2,920-h/2,w,h);ctx.restore();
    ctx.save();ctx.globalAlpha=leave*out((t-10.91)/.25);text('Музыка в твоём ритме',540,1100,32,C.muted,500,'center');ctx.restore();
  }
}
function endTitle(t) {
  const p=out((t-11.75)/.12),grow=smooth((t-11.77)/.95);
  ctx.save();ctx.globalAlpha=p;ctx.translate(540,950);ctx.scale(1+.10*grow,1+.10*grow);
  ctx.shadowColor='#f5edff';ctx.shadowBlur=18+grow*30;text('Включай Bolt.',0,0,76,C.white,650,'center');ctx.shadowBlur=0;text('Включай Bolt.',0,0,76,C.white,650,'center');ctx.restore();
}

window.renderFrame = async t => {
  t=Math.max(0,Math.min(DURATION-1/FPS,t));
  const movieTime=t,isIntro=t<INTRO_DURATION;
  t=isIntro?0:t-INTRO_DURATION;
  if(t>=edition.sourceDuration)t=edition.sourceDuration+(t-edition.sourceDuration)*ENDING_SPEED;
  background(t);
  if(t<6.60) {
    const image=isIntro?await homeFrame(movieTime):await liveFrame(t);
    await oldReady;await pointerReady;
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);uploadUi(image);
    const current=isIntro?{...camera(0),a:out(movieTime/.3)}:camera(t),samples=8;
    for(let j=0;j<samples;j++){
      const at=Math.max(0,(isIntro?movieTime:t)-(1-j/(samples-1))*.6/FPS);
      drawPlane(isIntro?current:camera(at),at,isIntro);present(sampleTarget.image,motionTarget.framebuffer,j);
    }
    present(motionTarget.image,null,0);
    ctx.save();ctx.globalAlpha=current.a;ctx.drawImage(plane,0,0);ctx.restore();
  }
  if(t>=6.60&&t<8.28)firstTitle(t);
  else if(t>=8.28&&t<9.20)phrase([['В твоём'],['ритме.',C.accent]],t,8.28,9.20,82);
  else if(t>=9.20&&t<10.10)phrase([['В одно'],['касание.',C.accent]],t,9.20,10.10,82);
  else if(t>=10.10&&t<11.75)brand(t);
  else if(t>=11.75)endTitle(t);
};
window.ready=Promise.all([document.fonts.load('500 51px Geologica','Слушай в своём ритме.'),document.fonts.load('650 64px Geologica','Включай Bolt.'),document.fonts.load('500 64px Geologica','Bolt'),logo.decode(),mark.decode(),intro.decode(),oldReady,pointerReady,...artists.map(i=>i.decode())]).then(()=>window.renderFrame(.65));

const play=document.getElementById('play'),seek=document.getElementById('seek'),time=document.getElementById('time'),sound=document.getElementById('sound'),mute=document.getElementById('mute');
seek.max=DURATION-1/FPS;
time.textContent=`0.0 / ${DURATION.toFixed(1)}`;
let running=false,start=0,at=0,busy=false;
async function display(t){await window.renderFrame(t);seek.value=t;time.textContent=`${t.toFixed(1)} / ${DURATION.toFixed(1)}`}
async function tick(now){if(!running)return;at=Math.min(DURATION-1/FPS,(now-start)/1000);if(!busy){busy=true;await display(at);busy=false}if(at>=DURATION-1/FPS){running=false;play.textContent='Смотреть';sound.pause()}else requestAnimationFrame(tick)}
play.onclick=()=>{if(running){running=false;sound.pause();play.textContent='Смотреть';return}if(at>=DURATION-.02)at=0;running=true;start=performance.now()-at*1000;sound.currentTime=at;sound.play().catch(()=>{});play.textContent='Пауза';requestAnimationFrame(tick)};
seek.oninput=()=>{at=Number(seek.value);start=performance.now()-at*1000;sound.currentTime=at;display(at)};
mute.onclick=()=>{sound.muted=!sound.muted;mute.textContent=sound.muted?'Звук выключен':'Звук включён';mute.setAttribute('aria-pressed',String(sound.muted))};
