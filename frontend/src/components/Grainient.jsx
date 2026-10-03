import { useEffect, useRef } from 'react';
import { Renderer, Program, Mesh, Triangle } from 'ogl';
import './Grainient.css';

const hexToRgb = hex => {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return [1, 1, 1];
  return [parseInt(result[1], 16) / 255, parseInt(result[2], 16) / 255, parseInt(result[3], 16) / 255];
};

const vertex = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const fragment = `#version 300 es
precision highp float;
uniform vec2 iResolution;
uniform float iTime;
uniform float uAnimationTime;
uniform float uWarpTime;
uniform float uColorBalance;
uniform float uWarpStrength;
uniform float uWarpFrequency;
uniform float uWarpAmplitude;
uniform float uBlendAngle;
uniform float uBlendSoftness;
uniform float uRotationAmount;
uniform float uNoiseScale;
uniform float uGrainAmount;
uniform float uGrainScale;
uniform float uGrainAnimated;
uniform float uContrast;
uniform float uGamma;
uniform float uSaturation;
uniform vec2 uCenterOffset;
uniform float uZoom;
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform vec3 uColor3;
uniform vec2 uRippleCenter;
uniform float uRippleRadius;
uniform float uRippleTime;
uniform float uRippleStrength;
uniform float uRippleFreq;
out vec4 fragColor;
#define S(a,b,t) smoothstep(a,b,t)
mat2 Rot(float a){float s=sin(a),c=cos(a);return mat2(c,-s,s,c);} 
vec2 hash(vec2 p){p=vec2(dot(p,vec2(2127.1,81.17)),dot(p,vec2(1269.5,283.37)));return fract(sin(p)*43758.5453);} 
float noise(vec2 p){vec2 i=floor(p),f=fract(p),u=f*f*(3.0-2.0*f);float n=mix(mix(dot(-1.0+2.0*hash(i+vec2(0.0,0.0)),f-vec2(0.0,0.0)),dot(-1.0+2.0*hash(i+vec2(1.0,0.0)),f-vec2(1.0,0.0)),u.x),mix(dot(-1.0+2.0*hash(i+vec2(0.0,1.0)),f-vec2(0.0,1.0)),dot(-1.0+2.0*hash(i+vec2(1.0,1.0)),f-vec2(1.0,1.0)),u.x),u.y);return 0.5+0.5*n;}
void mainImage(out vec4 o, vec2 C){
  float t=uAnimationTime;
  vec2 uv=C/iResolution.xy;
  float ratio=iResolution.x/iResolution.y;
  vec2 tuv=uv-0.5+uCenterOffset;
  tuv/=max(uZoom,0.001);

  // Волны от диска: кольца рождаются на его кромке и расходятся наружу.
  // Расстояние считаем в долях высоты (rp.x домножен на ratio), иначе на
  // широком hero кольца сплющивались бы в эллипсы. Кромку слегка колышет
  // шум по углу (cos/sin вместо самого угла — без шва на ±π), чтобы фронт
  // волны не был циркульно-ровным.
  float rippleW=0.0;
  float rippleFade=0.0;
  if(uRippleStrength>0.0){
    vec2 rp=uv-uRippleCenter;
    rp.x*=ratio;
    float r=length(rp);
    float ang=atan(rp.y,rp.x);
    float wob=(noise(vec2(cos(ang),sin(ang))*1.6+t*0.05)-0.5)*0.08;
    float d=max(r-uRippleRadius+wob,0.0);
    rippleW=sin(d*uRippleFreq-uRippleTime);
    // Затухание по мере удаления: у диска волна сильнее, к краям hero
    // растворяется в обычном градиенте. Мягкий вход у самой кромки — чтобы
    // на границе диска не было ступеньки.
    rippleFade=exp(-d*1.4)*S(0.0,0.03,d)*uRippleStrength;
    // Радиальное смещение поля: сам градиент «качается» вместе с волной.
    tuv+=(rp/max(r,0.0001))*rippleW*0.035*rippleFade;
  }

  float degree=noise(vec2(t*0.1,tuv.x*tuv.y)*uNoiseScale);
  tuv.y*=1.0/ratio;
  tuv*=Rot(radians((degree-0.5)*uRotationAmount+180.0));
  tuv.y*=ratio;

  float frequency=uWarpFrequency;
  float ws=max(uWarpStrength,0.001);
  float amplitude=uWarpAmplitude/ws;
  tuv.x+=sin(tuv.y*frequency+uWarpTime)/amplitude;
  tuv.y+=sin(tuv.x*(frequency*1.5)+uWarpTime)/(amplitude*0.5);

  vec3 colLav=uColor1;
  vec3 colOrg=uColor2;
  vec3 colDark=uColor3;
  float b=uColorBalance;
  float s=max(uBlendSoftness,0.0);
  mat2 blendRot=Rot(radians(uBlendAngle));
  float blendX=(tuv*blendRot).x;
  float edge0=-0.3-b-s;
  float edge1=0.2-b+s;
  float v0=0.5-b+s;
  float v1=-0.3-b-s;
  vec3 layer1=mix(colDark,colOrg,S(edge0,edge1,blendX));
  vec3 layer2=mix(colOrg,colLav,S(edge0,edge1,blendX));
  vec3 col=mix(layer1,layer2,S(v0,v1,tuv.y));
  // Гребни волн светлее и тянутся к первому цвету, впадины темнее.
  col*=1.0+rippleW*0.14*rippleFade;
  col=mix(col,colLav,S(0.55,1.0,rippleW)*0.22*rippleFade);

  vec2 grainUv=uv*max(uGrainScale,0.001);
  if(uGrainAnimated>0.5){grainUv+=vec2(iTime*0.05);} 
  float grain=fract(sin(dot(grainUv,vec2(12.9898,78.233)))*43758.5453);
  col+=(grain-0.5)*uGrainAmount;

  col=(col-0.5)*uContrast+0.5;
  float luma=dot(col,vec3(0.2126,0.7152,0.0722));
  col=mix(vec3(luma),col,uSaturation);
  col=pow(max(col,0.0),vec3(1.0/max(uGamma,0.001)));
  col=clamp(col,0.0,1.0);

  o=vec4(col,1.0);
}
void main(){
  vec4 o=vec4(0.0);
  mainImage(o,gl_FragCoord.xy);
  fragColor=o;
}
`;

// Градиент — не живой шейдер, а снятый с него кадр, который медленно плывёт
// CSS-трансформом. Живой рендер стоил дорого не шейдером, а самим фактом
// нового кадра: браузер и WindowServer заново композитили окно 20-30 раз в
// секунду, и на интеловском маке (встроенная графика в одном кристалле с CPU)
// это грело процессор при любом капе FPS. Готовая картинка рисуется один раз
// на смену цветов или размера, а дальше GPU только двигает текстуру.

// Момент анимации шейдера, который снимается в кадр. Подобран так, чтобы
// цвета легли крупными мягкими пятнами, а не полосами.
const FRAME_TIME = 3.0;
const FRAME_WARP_TIME = 6.0;

// Дрейф: сдвиг, поворот и масштаб слоя на 140% контейнера (inset -20% в
// CSS), чтобы при повороте не открывались края. Один проход — минута,
// туда-обратно.
const DRIFT_KEYFRAMES = [
  { transform: 'translate3d(0, 0, 0) rotate(0deg) scale(1)' },
  { transform: 'translate3d(-3%, 2%, 0) rotate(6deg) scale(1.06)' },
  { transform: 'translate3d(2%, -2%, 0) rotate(-4deg) scale(1.1)' }
];
const DRIFT_DURATION = 60000;
// Ступенчатый тайминг: 360 шагов на минуту — 6 смен положения в секунду в
// покое и 15 при игре. Смещение за шаг меньше пикселя, поэтому движение
// выглядит плавным, а значение трансформа между шагами не меняется и
// композитору нечего перерисовывать — в отличие от линейной анимации, которая
// обновляет слой на каждом кадре монитора.
const DRIFT_STEPS = 360;
// Играет трек — фон плывёт быстрее, как раньше разгонялся шейдер.
const ACTIVE_RATE = 2.5;
// Смена кадра (новый трек — новые цвета) — перекрёстным затуханием.
const FADE_MS = 700;
// Перерисовываем кадр на ресайзе, только если размер ушёл заметно: картинка
// мягкая и растягивается через object-fit без видимой разницы.
const RESIZE_THRESHOLD = 0.15;
const RESIZE_DEBOUNCE_MS = 250;

// Разовый рендер кадра в PNG. Контекст создаётся на один кадр и сразу
// освобождается: браузер держит жёсткий лимит живых WebGL-контекстов, а на
// маках с двумя видеокартами живой контекст ещё и держит включённой
// дискретную. Компиляция шейдера — десятки миллисекунд раз на трек.
const renderFrame = (params, colors, width, height, dpr) => {
  let renderer;
  try {
    renderer = new Renderer({
      webgl: 2,
      alpha: false,
      antialias: false,
      // Без этой подсказки на MacBook Pro 15/16 WebGL будит дискретную Radeon.
      powerPreference: 'low-power',
      // Буфер читается через toBlob уже после render — без сохранения он мог
      // бы оказаться очищен.
      preserveDrawingBuffer: true,
      dpr
    });
  } catch {
    return Promise.resolve(null);
  }
  const gl = renderer.gl;
  // Контекста может не быть (лимит, софтверный блеклист, экономия батареи):
  // фон — украшение, остаёмся на подложке hero.
  if (!gl) return Promise.resolve(null);
  const release = () => gl.getExtension('WEBGL_lose_context')?.loseContext();

  try {
    renderer.setSize(width, height);
    const program = new Program(gl, {
      vertex,
      fragment,
      uniforms: {
        iTime: { value: 0 },
        iResolution: { value: new Float32Array([gl.drawingBufferWidth, gl.drawingBufferHeight]) },
        uAnimationTime: { value: FRAME_TIME },
        uWarpTime: { value: FRAME_WARP_TIME },
        uColorBalance: { value: params.colorBalance },
        uWarpStrength: { value: params.warpStrength },
        uWarpFrequency: { value: params.warpFrequency },
        uWarpAmplitude: { value: params.warpAmplitude },
        uBlendAngle: { value: params.blendAngle },
        uBlendSoftness: { value: params.blendSoftness },
        uRotationAmount: { value: params.rotationAmount },
        uNoiseScale: { value: params.noiseScale },
        uGrainAmount: { value: params.grainAmount },
        uGrainScale: { value: params.grainScale },
        uGrainAnimated: { value: 0 },
        uContrast: { value: params.contrast },
        uGamma: { value: params.gamma },
        uSaturation: { value: params.saturation },
        uCenterOffset: { value: new Float32Array([params.centerX, params.centerY]) },
        uZoom: { value: params.zoom },
        uColor1: { value: new Float32Array(hexToRgb(colors[0])) },
        uColor2: { value: new Float32Array(hexToRgb(colors[1])) },
        uColor3: { value: new Float32Array(hexToRgb(colors[2])) },
        uRippleCenter: { value: new Float32Array([0.5, 0.5]) },
        uRippleRadius: { value: 0 },
        uRippleTime: { value: 0 },
        // Кольца — волна во времени, в застывшем кадре они не читаются.
        uRippleStrength: { value: 0 },
        uRippleFreq: { value: 0 }
      }
    });
    const mesh = new Mesh(gl, { geometry: new Triangle(gl), program });
    renderer.render({ scene: mesh });
  } catch {
    release();
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      gl.canvas.toBlob(resolve, 'image/png');
    } catch {
      resolve(null);
    }
  }).finally(release);
};

const removeFrame = (img) => {
  URL.revokeObjectURL(img.src);
  img.remove();
};

const Grainient = ({
  colorBalance = 0.0,
  warpStrength = 1.0,
  warpFrequency = 5.0,
  warpAmplitude = 50.0,
  blendAngle = 0.0,
  blendSoftness = 0.05,
  rotationAmount = 500.0,
  noiseScale = 2.0,
  grainAmount = 0.1,
  grainScale = 2.0,
  contrast = 1.5,
  gamma = 1.0,
  saturation = 1.0,
  centerX = 0.0,
  centerY = 0.0,
  zoom = 0.9,
  color1 = '#FF9FFC',
  color2 = '#5227FF',
  color3 = '#B19EEF',
  active = false,
  // Разрешение кадра в долях CSS-пикселя. Градиент мягкий и без мелких
  // деталей — растянутая картинка неотличима от полноразмерной, а PNG и
  // рендер вчетверо меньше. Поднять, если включён заметный grainAmount
  // (зерно при апскейле становится крупным).
  renderScale = 0.5,
  className = ''
}) => {
  const containerRef = useRef(null);
  const driftRef = useRef(null);
  const animRef = useRef(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  // Кадр: перерисовывается на смену цветов (обложка нового трека), параметров
  // шейдера и заметный ресайз. Старый кадр не удаляется сразу — новый
  // проявляется поверх, и только потом старый уходит.
  useEffect(() => {
    const container = containerRef.current;
    const drift = driftRef.current;
    if (!container || !drift) return undefined;

    const params = {
      colorBalance, warpStrength, warpFrequency, warpAmplitude, blendAngle,
      blendSoftness, rotationAmount, noiseScale, grainAmount, grainScale,
      contrast, gamma, saturation, centerX, centerY, zoom
    };
    let cancelled = false;
    let seq = 0;
    let drawn = null;
    let resizeTimer = 0;

    const draw = async () => {
      const rect = drift.getBoundingClientRect();
      // Размер слоя дрейфа без учёта его трансформа: offsetWidth/Height.
      const width = Math.floor(drift.offsetWidth || rect.width);
      const height = Math.floor(drift.offsetHeight || rect.height);
      if (!(width > 0) || !(height > 0)) return;
      const id = ++seq;
      drawn = { width, height };
      const blob = await renderFrame(params, [color1, color2, color3], width, height, renderScale);
      if (cancelled || id !== seq || !blob) return;

      const img = document.createElement('img');
      img.className = 'grainient-frame';
      img.alt = '';
      img.src = URL.createObjectURL(blob);
      // Вставляем уже декодированную картинку, иначе затухание началось бы
      // с пустого кадра.
      await img.decode().catch(() => {});
      if (cancelled || id !== seq) {
        URL.revokeObjectURL(img.src);
        return;
      }
      const previous = Array.from(drift.children);
      drift.appendChild(img);
      requestAnimationFrame(() => img.classList.add('is-visible'));
      setTimeout(() => previous.forEach(removeFrame), FADE_MS);
    };

    const ro = new ResizeObserver(() => {
      if (!drawn) {
        draw();
        return;
      }
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const width = drift.offsetWidth;
        const height = drift.offsetHeight;
        const changed =
          Math.abs(width - drawn.width) > drawn.width * RESIZE_THRESHOLD ||
          Math.abs(height - drawn.height) > drawn.height * RESIZE_THRESHOLD;
        if (changed) draw();
      }, RESIZE_DEBOUNCE_MS);
    });
    ro.observe(container);

    return () => {
      cancelled = true;
      clearTimeout(resizeTimer);
      ro.disconnect();
    };
  }, [
    color1, color2, color3,
    colorBalance, warpStrength, warpFrequency, warpAmplitude, blendAngle,
    blendSoftness, rotationAmount, noiseScale, grainAmount, grainScale,
    contrast, gamma, saturation, centerX, centerY, zoom, renderScale
  ]);

  // Дрейф. Web Animations, а не CSS-класс: скорость при старте/паузе трека
  // меняется через playbackRate без скачка позиции, а смена
  // animation-duration в CSS пересчитала бы прогресс и дёрнула слой.
  useEffect(() => {
    const drift = driftRef.current;
    const container = containerRef.current;
    if (!drift || typeof drift.animate !== 'function') return undefined;
    // prefers-reduced-motion: фон стоит.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return undefined;

    const anim = drift.animate(DRIFT_KEYFRAMES, {
      duration: DRIFT_DURATION,
      iterations: Infinity,
      direction: 'alternate',
      easing: `steps(${DRIFT_STEPS})`
    });
    anim.playbackRate = activeRef.current ? ACTIVE_RATE : 1;
    animRef.current = anim;

    // Hero за пределами экрана — анимацию ставим на паузу, чтобы композитор не
    // тикал впустую.
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting ?? true) anim.play();
      else anim.pause();
    });
    io.observe(container);

    return () => {
      io.disconnect();
      anim.cancel();
      animRef.current = null;
    };
  }, []);

  useEffect(() => {
    animRef.current?.updatePlaybackRate(active ? ACTIVE_RATE : 1);
  }, [active]);

  // Размонтирование — кадры и их object URL больше не нужны.
  useEffect(() => {
    const drift = driftRef.current;
    return () => {
      if (drift) Array.from(drift.children).forEach(removeFrame);
    };
  }, []);

  return (
    <div ref={containerRef} className={`grainient-container ${className}`.trim()}>
      <div ref={driftRef} className="grainient-drift" />
    </div>
  );
};

export default Grainient;
