import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const query = new URLSearchParams(location.search);
const W = Number(query.get('width')) || 1920, H = Math.round(W * 9 / 16);
const film = document.getElementById('film');
film.width = W; film.height = H;
const ctx = film.getContext('2d', {alpha:false});
const renderer = new THREE.WebGLRenderer({antialias:true,alpha:false,preserveDrawingBuffer:true,powerPreference:'high-performance'});
renderer.setSize(W,H,false);
renderer.setPixelRatio(1);
renderer.outputColorSpace=THREE.SRGBColorSpace;
renderer.toneMapping=THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure=1.15;
renderer.shadowMap.enabled=true;
renderer.shadowMap.type=THREE.PCFSoftShadowMap;
const scene=new THREE.Scene();
const camera=new THREE.PerspectiveCamera(42,W/H,.06,120);
const pmrem=new THREE.PMREMGenerator(renderer);
const environment=new RoomEnvironment();
scene.environment=pmrem.fromScene(environment,.035).texture;
environment.dispose(); pmrem.dispose();
scene.environmentIntensity=.9;
const hemi=new THREE.HemisphereLight(0xded7ff,0x272235,2.0); scene.add(hemi);
const key=new THREE.DirectionalLight(0xfff6eb,4.2);key.position.set(-4,8,5);key.castShadow=true;
key.shadow.mapSize.set(2048,2048);key.shadow.camera.left=-14;key.shadow.camera.right=14;key.shadow.camera.top=14;key.shadow.camera.bottom=-14;key.shadow.camera.near=.5;key.shadow.camera.far=35;key.shadow.bias=-.00015;key.shadow.normalBias=.025;scene.add(key);
const rim=new THREE.DirectionalLight(0xa47fff,3.5);rim.position.set(6,4,-3);scene.add(rim);
const fill=new THREE.PointLight(0xe2d9ff,18,30,2);fill.position.set(-5,2,4);scene.add(fill);
const clamp=x=>Math.min(1,Math.max(0,x));
const ease=x=>{x=clamp(x);return x*x*(3-2*x)};
const out=x=>1-Math.pow(1-clamp(x),3);
const lerp=(a,b,p)=>a+(b-a)*p;
const tau=Math.PI*2;
let seed=93245;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296};
const mat=(color,roughness=.3,metalness=.2,extra={})=>new THREE.MeshStandardMaterial({color,roughness,metalness,...extra});
const purple=new THREE.MeshPhysicalMaterial({color:0x8854e8,roughness:.19,metalness:.48,clearcoat:1,clearcoatRoughness:.14});
const lavender=mat(0xc4b0f0,.27,.35),chrome=mat(0xdce6ed,.16,.97),dark=mat(0x14131c,.44,.25),rubber=mat(0x111016,.82,.04),white=mat(0xece9e3,.53,.04);
const dummy=new THREE.Object3D();
function mesh(geo,material,parent,x=0,y=0,z=0){const m=new THREE.Mesh(geo,material);m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;if(parent)parent.add(m);return m}
function box(parent,w,h,d,material,x=0,y=0,z=0,r=.06){return mesh(new RoundedBoxGeometry(w,h,d,2,Math.min(r,w/3,h/3,d/3)),material,parent,x,y,z)}
function ball(parent,r,material,x=0,y=0,z=0){return mesh(new THREE.SphereGeometry(r,40,24),material,parent,x,y,z)}
function torus(parent,r,t,material,x=0,y=0,z=0){return mesh(new THREE.TorusGeometry(r,t,10,100),material,parent,x,y,z)}
function tube(parent,points,r,material,segments=60){return mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p))),segments,r,8,false),material,parent)}
function plane(parent,w,h,material,x=0,y=0,z=0){return mesh(new THREE.PlaneGeometry(w,h),material,parent,x,y,z)}
function textureFrom(draw,w=1024,h=w){const c=document.createElement('canvas');c.width=w;c.height=h;draw(c.getContext('2d'),w,h);const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=renderer.capabilities.getMaxAnisotropy();return t}
function roundRectShape(w,h,r){const s=new THREE.Shape(),x=-w/2,y=-h/2;s.moveTo(x+r,y);s.lineTo(x+w-r,y);s.quadraticCurveTo(x+w,y,x+w,y+r);s.lineTo(x+w,y+h-r);s.quadraticCurveTo(x+w,y+h,x+w-r,y+h);s.lineTo(x+r,y+h);s.quadraticCurveTo(x,y+h,x,y+h-r);s.lineTo(x,y+r);s.quadraticCurveTo(x,y,x+r,y);return s}
function roundedPlane(parent,w,h,r,material){const g=new THREE.ShapeGeometry(roundRectShape(w,h,r));const uv=g.attributes.uv;for(let i=0;i<uv.count;i++)uv.setXY(i,(uv.getX(i)+w/2)/w,(uv.getY(i)+h/2)/h);return mesh(g,material,parent)}
const loader=new THREE.TextureLoader();
const tex={};
const pending=['mark','wordmark','wordmark-white','player','cover-0','cover-1','cover-2','cover-3','cover-4'].map(async name=>{tex[name]=await loader.loadAsync(`assets/${name}.png`);tex[name].colorSpace=THREE.SRGBColorSpace;tex[name].anisotropy=renderer.capabilities.getMaxAnisotropy();});
const rawImages={};
for(const name of ['wordmark','wordmark-white','wordmark-dark']){const im=new Image();im.src=`assets/${name}.png`;rawImages[name]=im;pending.push(im.decode())}
pending.push(document.fonts.load('700 64px Arimo','Музыка в твоём ритме.'));

function woodTexture(){return textureFrom((c,w,h)=>{c.fillStyle='#86716b';c.fillRect(0,0,w,h);for(let i=0;i<2600;i++){const x=random()*w;c.strokeStyle=`rgba(${random()>.5?'222,192,166':'44,25,33'},${.02+random()*.10})`;c.lineWidth=.5+random()*2;c.beginPath();c.moveTo(x,0);for(let y=0;y<=h;y+=24)c.lineTo(x+Math.sin(y*.007+i*.02)*2+Math.sin(y*.07+i)*.6,y);c.stroke()}},1024)}
function marbleTexture(){return textureFrom((c,w,h)=>{const im=c.createImageData(w,h);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const wave=Math.sin(x*.021+Math.sin(y*.014)*4+Math.sin((x+y)*.014)*3);const wave2=Math.sin(y*.028+Math.sin(x*.01)*3);const v=(wave*.7+wave2*.3+1)/2,i=(y*w+x)*4;im.data[i]=69+v*83;im.data[i+1]=30+v*55;im.data[i+2]=138+v*92;im.data[i+3]=255}c.putImageData(im,0,0)},512)}
const marble=marbleTexture();
function orb(parent,r=1){const g=new THREE.Group();parent.add(g);const body=ball(g,r,new THREE.MeshPhysicalMaterial({map:marble,color:0xc5a4ff,metalness:.3,roughness:.16,clearcoat:1,clearcoatRoughness:.08}));const m=new THREE.MeshBasicMaterial({map:tex.mark,transparent:true,depthWrite:false,toneMapped:false,side:THREE.DoubleSide});plane(g,r*1.12,r*1.14,m,0,0,r*1.015);const band=torus(g,r*.997,r*.015,chrome);band.rotation.x=Math.PI/2+.24;const band2=torus(g,r*.997,r*.008,lavender);band2.rotation.y=1.1;g.userData.body=body;return g}
function phone(parent){const p=new THREE.Group();parent.add(p);box(p,1.57,3.36,.19,chrome,0,0,0,.13);box(p,1.51,3.30,.2,dark,0,0,.012,.13);const screen=roundedPlane(p,1.43,3.10,.11,new THREE.MeshBasicMaterial({map:tex.player,toneMapped:false}));screen.position.z=.119;box(p,.42,.065,.024,dark,0,1.56,.138,.02);box(p,.021,.25,.055,chrome,.792,.61,0,.008);box(p,.022,.16,.055,chrome,-.792,.68,0,.008);const glass=roundedPlane(p,1.43,3.1,.11,new THREE.MeshPhysicalMaterial({color:0xe2d5ff,transparent:true,opacity:.045,metalness:.6,roughness:.08,depthWrite:false}));glass.position.z=.122;return p}
function headphones(parent){const g=new THREE.Group();parent.add(g);const arc=[];for(let i=0;i<=35;i++){const a=i/35*Math.PI;arc.push([Math.cos(a)*1.16,Math.sin(a)*1.35,0])}tube(g,arc,.13,purple);tube(g,arc.map(([x,y,z])=>[x,y-.065,z+.025]),.07,rubber);for(const side of [-1,1]){const cup=new THREE.Group();g.add(cup);cup.position.set(side*1.07,-.03,0);cup.rotation.z=side*.13;const body=mesh(new THREE.CylinderGeometry(.55,.55,.35,64),purple,cup);body.rotation.x=Math.PI/2;const cushion=torus(cup,.40,.12,rubber,0,0,.215);const inside=mesh(new THREE.CircleGeometry(.39,48),rubber,cup,0,0,.20);const grill=mesh(new THREE.CircleGeometry(.26,48),mat(0x25242c,.9,0),cup,0,0,.222);const outer=mesh(new THREE.CylinderGeometry(.38,.38,.04,48),dark,cup,0,0,-.19);outer.rotation.x=Math.PI/2;torus(cup,.38,.018,chrome,0,0,-.222);box(cup,.12,.5,.1,chrome,side*.12,.48,-.025,.028)}return g}
function hand(parent){const g=new THREE.Group();parent.add(g);const skin=new THREE.MeshPhysicalMaterial({color:0xc58e69,roughness:.61,metalness:0,clearcoat:.14});const palm=ball(g,.37,skin);palm.scale.set(1,.36,1.35);for(let i=0;i<4;i++){const f=new THREE.Group();g.add(f);f.position.set(-.26+i*.17,0,-.28);const len=[.47,.59,.56,.43][i];const part=mesh(new THREE.CapsuleGeometry(.076,len,6,10),skin,f,0,0,-len*.5);part.rotation.x=Math.PI/2;f.rotation.y=(i-1.5)*.045}const thumb=mesh(new THREE.CapsuleGeometry(.09,.30,6,12),skin,g,.39,-.01,-.07);thumb.rotation.set(Math.PI/2,0,-.75);const sleeve=mesh(new THREE.CylinderGeometry(.32,.39,3.0,32),mat(0x746581,.94,0),g,0,-.01,1.78);sleeve.rotation.x=Math.PI/2;return g}
function note(parent,material=chrome){const n=new THREE.Group();parent.add(n);const head=ball(n,.14,material,-.08,0,0);head.scale.set(1.3,.65,.8);box(n,.044,.63,.044,material,.07,.28,0,.018);tube(n,[[.08,.57,0],[.2,.52,0],[.28,.44,0],[.28,.34,0]],.028,material,18);return n}
function labelTexture(top,bottom,bg='#614095'){return textureFrom((c,w,h)=>{c.fillStyle=bg;c.fillRect(0,0,w,h);const glow=c.createRadialGradient(w*.8,h*.18,0,w*.8,h*.18,w*.8);glow.addColorStop(0,'#b1a4ec');glow.addColorStop(1,'#67439100');c.fillStyle=glow;c.fillRect(0,0,w,h);c.fillStyle='#f4ecff';c.font=`700 ${w*.09}px Arimo`;c.fillText(top,w*.08,h*.75);c.font=`400 ${w*.043}px Arimo`;c.fillText(bottom,w*.08,h*.86);for(let i=0;i<32;i++){c.fillStyle=`rgba(234,218,255,${.15+.1*Math.sin(i)})`;c.fillRect(w*.08+i*w*.026,h*.12,w*.015,h*(.11+.2*Math.abs(Math.sin(i*.21))))}},768)}
function artTexture(index){return textureFrom((c,w,h)=>{const g=c.createLinearGradient(0,0,w,h);g.addColorStop(0,['#2b1848','#ddd6ed','#030c1a','#695799'][index%4]);g.addColorStop(1,['#9272c9','#8268ba','#64569c','#272340'][index%4]);c.fillStyle=g;c.fillRect(0,0,w,h);for(let j=0;j<48;j++){c.beginPath();const yy=h*.25+j*13;for(let x=-10;x<w+10;x+=10){const y=yy+Math.sin(x*.008+j*.16)*85+Math.cos(x*.017-j*.22)*35;if(x===-10)c.moveTo(x,y);else c.lineTo(x,y)}c.strokeStyle=`rgba(218,201,248,${.12+.35*j/48})`;c.lineWidth=5;c.stroke()}c.fillStyle='#fff';c.font=`700 ${w*.063}px Arimo`;c.fillText(['ПОТОК','НОЧЬ','НА ПОВТОРЕ','ОТКРЫТИЯ'][index%4],w*.08,h*.88)},768)}
function card(parent,texture,w=1.2,h=1.2){const g=new THREE.Group();parent.add(g);box(g,w,h,.055,lavender,0,0,0,.012);plane(g,w*.982,h*.982,new THREE.MeshBasicMaterial({map:texture,toneMapped:false}),0,0,.033);return g}
const stages=[];
function stage(name,from,to,bg){const g=new THREE.Group();g.visible=false;scene.add(g);const s={name,from,to,bg,g,update:()=>{}};stages.push(s);return s}
function pointCamera(x,y,z,tx=0,ty=0,tz=0,fov=42){camera.position.set(x,y,z);camera.lookAt(tx,ty,tz);camera.fov=fov;camera.updateProjectionMatrix()}
function lights(day=false){hemi.intensity=day?1.10:.64;key.intensity=day?2.75:3.4;rim.intensity=day?1.7:4.0;fill.intensity=day?6:18;scene.environmentIntensity=day?.68:.85;renderer.toneMappingExposure=day?1.0:1.18}

async function build(){
await Promise.all(pending);
const artworks=[0,1,2,3].map(artTexture);
// 01: physical desktop, daylight, headphones, a real Bolt screen and a reach.
{
const s=stage('desk',0,1.65,0xb3abb9),g=s.g;
const wood=woodTexture();wood.wrapS=wood.wrapT=THREE.RepeatWrapping;wood.repeat.set(3,1);
box(g,12,.30,7,mat(0xb9a290,.75,.04,{map:wood}),0,-.23,0,.10);
plane(g,22,12,mat(0xc3bec7,.93,0),0,4,-4.4);
const poster=labelTexture('В ТВОЁМ','РИТМЕ','#7d7090');plane(g,2.45,2.45,new THREE.MeshBasicMaterial({map:poster}),-3.5,2.2,-4.36);
for(let i=0;i<3;i++)plane(g,.5,.5,mat([0xffe0a6,0xf9d6ac,0xc8c6d9][i],.95,0),-.9+i*.66,2.22,-4.35);
const hp=headphones(g);hp.position.set(-1.65,.58,.06);hp.rotation.set(-.68,.36,-.1);
const p=phone(g);p.position.set(1.27,.10,-.20);p.rotation.set(-Math.PI/2,0,-.16);p.scale.setScalar(.78);
const h=hand(g);h.position.set(1.55,.7,1.95);h.rotation.y=-.12;
for(let i=0;i<3;i++)box(g,1.7,.13,1.2,mat([0x8c889c,0xd4c7a9,0x594674][i],.88,.01),-3,.13+i*.14,-2.4,.035);
const planter=mesh(new THREE.CylinderGeometry(.48,.33,.72,48),mat(0xa29483,.84,0),g,2.95,.27,-2.0);mesh(new THREE.CircleGeometry(.43,32),mat(0x25241f,.95,0),g,2.95,.64,-2.0).rotation.x=-Math.PI/2;
for(let i=0;i<15;i++){const a=i*2.399,r=.25+random()*.5;const stem=tube(g,[[2.95,.63,-2],[2.95+Math.cos(a)*r*.6,1.05+random()*.4,-2+Math.sin(a)*r*.6],[2.95+Math.cos(a)*r,1.4+random()*.7,-2+Math.sin(a)*r]],.018,mat(0x374d2a,.76,0),16);const leaf=ball(g,.27,mat(0x3b553f,.54,0),2.95+Math.cos(a)*r,1.5+random()*.5,-2+Math.sin(a)*r);leaf.scale.set(.65,1.8,.11);leaf.rotation.set(.2,Math.PI*.5+a,a*.3)}
const lamp=mesh(new THREE.CylinderGeometry(.45,.66,.9,48,1,true),mat(0xece9df,.45,.5),g,-4,2.05,-1.6);tube(g,[[-4,.1,-1.6],[-4,1.8,-1.6],[-4,2.4,-1.6]],.025,chrome);mesh(new THREE.CylinderGeometry(.45,.45,.08,48),chrome,g,-4,.06,-1.6);
for(let i=0;i<11;i++){const slat=box(g,.18,.05,8,mat(0x655c77,.8,0,{transparent:true,opacity:.13}),-5+i*.93,.007,.1,.008);slat.rotation.y=-.55;slat.castShadow=false}
s.update=t=>{lights(true);const p0=ease(t/1.65);pointCamera(lerp(3.5,2.1,p0),lerp(6.0,4.7,p0),lerp(6.6,4.7,p0),.1,.3,-.55,43);h.position.set(lerp(1.75,1.1,out(t/1.1)),lerp(.9,.37,out(t/1.3)),lerp(1.95,.10,out(t/1.4)));h.rotation.x=-.05+Math.sin(t*2)*.035;p.position.y=.10+Math.max(0,t-1.25)*.12;};
}
// 02: the glossy service symbol fills the dark studio.
{
const s=stage('symbol',1.65,2.55,0x0d0c15),g=s.g,o=orb(g,1);
const rings=[];for(let i=0;i<7;i++){const r=torus(g,1.8+i*.6,.014,mat(0xa694cb,.35,.7,{transparent:true,opacity:.14}));r.position.set((random()-.5)*8,(random()-.5)*5,-3-random()*3);rings.push(r)}
s.update=t=>{lights();const u=t-1.65;o.rotation.set(.08*Math.sin(u),-.15+u*.45,.10*Math.sin(u*2));pointCamera(.38*Math.sin(u),.13,lerp(6.7,4.6,out(u/.9)),0,0,0,39);};
}
// 03: braided ribbons assembled from hundreds of reflective equalizer bars.
{
const s=stage('ribbons',2.55,4,0x12101c),g=s.g,o=orb(g,.61);
const ribbons=[];for(let j=0;j<3;j++){const count=150;const inst=new THREE.InstancedMesh(new THREE.BoxGeometry(.043,1,.05),j===0?purple:chrome,count);inst.castShadow=false;g.add(inst);ribbons.push(inst)}
s.update=t=>{lights();const u=t-2.55;o.rotation.y=.18*Math.sin(u*2);for(let j=0;j<3;j++){const inst=ribbons[j];for(let i=0;i<150;i++){const a=i/149*tau*1.7+u*.75+j*tau/3;const r=2.1+.25*Math.sin(a*2+u);const amp=.13+Math.pow(Math.max(0,Math.sin(i*.045+u*4+j)),3)*.92;dummy.position.set(Math.cos(a)*r,Math.sin(a)*r*.54,(i/149-.5)*5.4+Math.sin(a)*.25);dummy.rotation.set(.2*Math.sin(a),-a*.25,-a+.45);dummy.scale.set(1,amp,1);dummy.updateMatrix();inst.setMatrixAt(i,dummy.matrix)}inst.instanceMatrix.needsUpdate=true}g.rotation.z=-.13+u*.05;pointCamera(1.2*Math.sin(u*.6),.8,7.2-u*.65,0,0,0,47);};
}
// 04: a spinning vinyl with grooves, tonearm and a miniature musical skyline.
{
const s=stage('vinyl',4,4.85,0xc3b9d2),g=s.g;const platter=new THREE.Group();g.add(platter);
const record=mesh(new THREE.CylinderGeometry(2.25,2.25,.065,120),rubber,platter);record.rotation.x=Math.PI/2;for(let i=0;i<32;i++)torus(platter,.65+i*.048,.006,mat(i%3?0x34313b:0x55515b,.24,.54),0,0,.042);const label=mesh(new THREE.CircleGeometry(.64,64),purple,platter,0,0,.05);plane(platter,.53,.55,new THREE.MeshBasicMaterial({map:tex.mark,transparent:true,toneMapped:false}),0,0,.055);ball(platter,.066,chrome,0,0,.08);
const buildings=new THREE.Group();g.add(buildings);for(let i=0;i<42;i++){const a=i/42*tau;const h=.25+random()*.8;const b=box(buildings,.16,h,.17,i%3?lavender:purple,Math.cos(a)*2.5,Math.sin(a)*2.5,-.1,.015);b.rotation.z=a;for(let j=0;j<4;j++)box(b,.05,.015,.005,white,0,-h*.3+j*h*.18,.089,.001)}
tube(g,[[2.65,-1.75,.25],[1.80,-.75,.45],[1.04,.58,.20]],.039,chrome);box(g,.16,.38,.12,dark,1.04,.58,.19,.025);const o=orb(g,.43);o.position.set(1.7,1.7,.25);
s.update=t=>{lights(true);const u=t-4;platter.rotation.z=u*.48;buildings.rotation.z=u*.08;g.rotation.set(-.40+u*.10,.12,-.25);pointCamera(.4,-.8,8.2-u*.7,0,.20,0,40)};
}
// 05: translucent playlist layers and floating, readable cover artwork.
{
const s=stage('layers',4.85,5.95,0xbeb8cd),g=s.g;const layers=[];
for(let i=0;i<12;i++){const c=card(g,i>8?labelTexture(i===11?'МОЙ ПОТОК':'НА ПОВТОРЕ','BOLT · ТВОЯ МУЗЫКА'):artworks[i%4],2.8,2.25);c.rotation.x=-Math.PI/2;c.position.y=(i-5)*.20;c.position.x=Math.sin(i*.25)*.20;c.position.z=Math.cos(i*.35)*.2;layers.push(c)}const o=orb(g,.47);o.position.set(.8,2.5,-.15);
for(let i=0;i<10;i++){const slab=box(g,.65,.65,.025,white,-4+random()*8,.5+random()*4,-2.6,.006);slab.rotation.set(.12,.15,(random()-.5)*.2)}
s.update=t=>{lights(true);const u=t-4.85;layers.forEach((l,i)=>{l.rotation.y=.16*Math.sin(u*1.7+i*.07);l.position.x=Math.sin(i*.25+u*.6)*.28;l.position.y=(i-5)*(.20+.035*Math.sin(u*2))});o.position.y=2.4+Math.sin(u*3)*.08;g.rotation.y=-.25+u*.24;pointCamera(4.8-u*.9,4.1,6.6-u*.5,0,.7,0,42)};
}
// 06: an instanced sphere of facets, opening around the brand symbol.
{
const s=stage('particles',5.95,6.95,0x0c0b15),g=s.g,o=orb(g,.55),count=1300;
const particles=new THREE.InstancedMesh(new THREE.OctahedronGeometry(.06,0),lavender,count);g.add(particles);const data=[];for(let i=0;i<count;i++){const y=1-i/(count-1)*2,r=Math.sqrt(1-y*y),a=i*2.399963;data.push([Math.cos(a)*r,y,Math.sin(a)*r,random()]);particles.setColorAt(i,new THREE.Color().setHSL(.72+random()*.04,.5,.35+random()*.44))}
s.update=t=>{lights();const u=t-5.95;data.forEach(([x,y,z,n],i)=>{const r=1.8+.33*Math.sin(u*3+n*4)+.18*Math.sin(i*.1+u);dummy.position.set(x*r,y*r,z*r);dummy.rotation.set(n*4+u,x+u*.7,y*3+u);dummy.scale.setScalar(Math.hypot(x,y)<.38?0:.4+n*.85);dummy.updateMatrix();particles.setMatrixAt(i,dummy.matrix)});particles.instanceMatrix.needsUpdate=true;g.rotation.z=u*.22;pointCamera(0,0,lerp(7.4,6.9,out(u)),0,0,0,40)};
}
// 07: the sound wave becomes a three-dimensional field of columns.
{
const s=stage('columns',6.95,8,0x18213b),g=s.g,o=orb(g,.55);o.position.set(0,2.65,0);
const n=38,m=24,count=n*m,blocks=new THREE.InstancedMesh(new THREE.BoxGeometry(.16,1,.16),purple,count);blocks.castShadow=true;blocks.receiveShadow=true;g.add(blocks);const notes=[];
for(let i=0;i<30;i++){const no=note(g,i%3?chrome:lavender);no.position.set((random()-.5)*8,2.6+random()*2.0,(random()-.5)*4);no.scale.setScalar(.12+random()*.22);notes.push(no)}
s.update=t=>{lights();const u=t-6.95;for(let j=0;j<m;j++)for(let i=0;i<n;i++){const x=(i-n/2)*.19,z=(j-m/2)*.19,h=.16+1.5*Math.pow(Math.abs(Math.sin(x*.8+z*.62+u*2)),2)+.3*Math.sin(z*2-x+u);dummy.position.set(x,h/2-.7,z);dummy.scale.set(1,h,1);dummy.rotation.set(0,0,0);dummy.updateMatrix();blocks.setMatrixAt(j*n+i,dummy.matrix)}blocks.instanceMatrix.needsUpdate=true;notes.forEach((no,i)=>{no.position.y+=0;no.rotation.y=u*.5+i;no.rotation.z=Math.sin(u*2+i)*.2});o.position.y=2.65+.1*Math.sin(u*3);pointCamera(5.0-u*1.1,4.0,8.9-u*.8,0,1.0,0,44)};
}
// 08: rolling lavender hills made from thousands of blades and stems.
{
const s=stage('landscape',8,9.75,0xbcc9db),g=s.g;
function height(x,z){return .95*Math.sin(x*.42+z*.29)+.8*Math.cos(z*.55-x*.18)+.22*Math.sin(x*.95+z*.54)}
const groundGeo=new THREE.PlaneGeometry(24,20,90,70);groundGeo.rotateX(-Math.PI/2);const pos=groundGeo.attributes.position;for(let i=0;i<pos.count;i++)pos.setY(i,height(pos.getX(i),pos.getZ(i))-.06);groundGeo.computeVertexNormals();mesh(groundGeo,mat(0x645075,.90,0),g);
const count=20000,grass=new THREE.InstancedMesh(new THREE.ConeGeometry(.055,.30,5,1),lavender,count);g.add(grass);const bladeData=[];for(let i=0;i<count;i++){const x=(random()-.5)*23,z=(random()-.5)*19,n=random();bladeData.push([x,z,n]);grass.setColorAt(i,new THREE.Color().setHSL(.72+n*.04,.48,.24+n*.30))}
const o=orb(g,.63);o.position.set(0,2.65,-2);
const tinyNotes=[];for(let i=0;i<35;i++){const no=note(g,chrome);no.position.set((random()-.5)*15,3+random()*4,-3-random()*8);no.scale.setScalar(.06+random()*.11);tinyNotes.push(no)}
s.update=t=>{lights(true);rim.intensity=2.1;const u=t-8;bladeData.forEach(([x,z,n],i)=>{const h=.5+n*.7;dummy.position.set(x,height(x,z)+.15*h,z);dummy.rotation.set(.16*Math.sin(u*2+x*.9+z*.3),n*tau,.12*Math.sin(u*2+z*.7));dummy.scale.set(1,h,1);dummy.updateMatrix();grass.setMatrixAt(i,dummy.matrix)});grass.instanceMatrix.needsUpdate=true;o.position.set(-.2+u*.15,2.65+.09*Math.sin(u*3),-2-u*.45);o.rotation.y=.1+Math.sin(u)*.20;pointCamera(2.4-u*1.4,2.45,9.3-u*2.9,0,1.3,-3,46)};
}
// 09: chrome notes drifting along visible elliptical orbits.
{
const s=stage('notes',9.75,11.65,0x10131b),g=s.g,o=orb(g,.66),notes=[];
for(let j=0;j<4;j++){const orbit=torus(g,2.0+j*.43,.010,mat(0x79788c,.34,.9,{transparent:true,opacity:.26}));orbit.rotation.set(.65+j*.25,.20+j*.23,j*.37)}
for(let i=0;i<60;i++){const no=note(g,i%6===0?purple:chrome);const size=i<8?.8:.14+random()*.21;no.scale.setScalar(size);notes.push({no,a:random()*tau,r:1.7+random()*3.4,y:(random()-.5)*4,n:random()})}
s.update=t=>{lights();const u=t-9.75;notes.forEach(({no,a,r,y,n},i)=>{const angle=a+u*(.15+n*.3);no.position.set(Math.cos(angle)*r,y+Math.sin(angle)*.4,Math.sin(angle)*r*.45);no.rotation.set(Math.sin(u+n)*.18,-angle+u*.5,Math.sin(u+i)*.22)});o.rotation.y=.2*Math.sin(u*1.8);g.rotation.z=-u*.035;pointCamera(.6*Math.sin(u),.28,8.8-u*.7,0,0,0,44)};
}
// 10: actual Bolt mobile player; artwork glides past in a long perspective line.
{
const s=stage('player',11.65,13.35,0x151422),g=s.g,p=phone(g);p.position.set(1.35,0,.1);p.rotation.set(.07,-.25,-.08);p.scale.setScalar(1.17);
const cards=[];for(let i=0;i<7;i++){const c=card(g,i<5?tex[`cover-${i}`]:artworks[i%4],1.45,1.45);c.position.set(-5.7+i*.75,1.25+i*.04,-2.3+i*.23);c.rotation.set(.02,-.16,-.03);cards.push(c)}
const o=orb(g,.42);o.position.set(2.7,-.58,1.0);
const bubbles=[];for(let i=0;i<22;i++){const b=ball(g,.08+random()*.16,mat(0xc9d3f1,.12,.85,{transparent:true,opacity:.28}),(random()-.5)*10,(random()-.5)*5,-2-random()*3);bubbles.push(b)}
s.update=t=>{lights();const u=t-11.65;cards.forEach((c,i)=>{c.position.x=-5.7+i*.75+u*.6;c.position.y=1.25+i*.04+.08*Math.sin(u*2+i);c.rotation.y=-.16+u*.07});p.rotation.y=-.28+.12*Math.sin(u*1.2);p.rotation.z=-.09+u*.025;o.position.y=-.58+.1*Math.sin(u*3);o.rotation.y=u*.3;pointCamera(3.0-u*.9,.3,8.8-u*.4,.0,0,0,40)};
}
// 11: covers become a rotating ring against an almost white cyclorama.
{
const s=stage('carousel',13.35,14.65,0xe3dfeb),g=s.g,cards=[];for(let i=0;i<24;i++){const c=card(g,i%8<5?tex[`cover-${i%8}`]:artworks[i%4],1.28,1.28);cards.push(c)}const o=orb(g,.53);o.position.set(2.3,-.3,.8);
s.update=t=>{lights(true);const u=t-13.35;cards.forEach((c,i)=>{const a=i/24*tau+u*.7;c.position.set(Math.cos(a)*2.7,Math.sin(a)*2.7,Math.sin(a*2)*.45);c.rotation.set(.1*Math.sin(a),.35*Math.cos(a),a+.16);});o.rotation.y=u*.35;g.rotation.z=-.09;pointCamera(-.45+u*.65,0,9.7-u*.9,0,0,0,41)};
}
// 12: the hero symbol casts radial streaks into a clean white end card.
{
const s=stage('burst',14.65,16.05,0xf3eff9),g=s.g,o=orb(g,.55),rays=[];for(let i=0;i<36;i++){const a=i/36*tau;const material=(i%3?lavender:white).clone();material.transparent=true;material.depthWrite=false;const b=box(g,.017,4.3,.018,material,0,0,-.7,.005);b.rotation.z=a;b.castShadow=false;b.receiveShadow=false;rays.push({b,a})}
s.update=t=>{lights(true);const u=t-14.65,p0=out(u/1.4);o.rotation.set(0,Math.sin(u*1.5)*.18,u*.2);o.scale.setScalar(lerp(1.25,.85,p0));rays.forEach(({b,a},i)=>{const r=.65+u*4;b.position.set(Math.sin(a)*r,Math.cos(a)*r,-.7);b.scale.y=1+u*.35;b.material.transparent=true;b.material.opacity=.24*(1-ease((u-.5)/.8));});pointCamera(0,0,5.1+u*.45,0,0,0,40)};
}
window.renderFrame=t=>{
  t=Math.max(0,Math.min(18-1/60,t));
  const end=t>=16.05;
  if(end){
    ctx.fillStyle='#fcfbfe';ctx.fillRect(0,0,W,H);
    const p=out((t-16.05)/.42),im=rawImages['wordmark-dark'];const width=W*.30;const height=width*im.height/im.width;
    ctx.save();ctx.globalAlpha=p;ctx.drawImage(im,(W-width)/2,H*.42-height/2+(1-p)*H*.015,width,height);ctx.restore();
    ctx.globalAlpha=out((t-16.35)/.38);ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle='#674393';ctx.font=`700 ${W*.023}px Arimo`;ctx.fillText('Музыка в твоём ритме.',W/2,H*.59);ctx.globalAlpha=1;
    return;
  }
  for(const s of stages)s.g.visible=t>=s.from&&t<s.to;
  const current=stages.find(s=>s.g.visible);scene.background=new THREE.Color(current.bg);current.update(t);
  renderer.render(scene,camera);ctx.drawImage(renderer.domElement,0,0,W,H);
  // A subtle photographic vignette, strongest in the dark studio scenes.
  const vignette=ctx.createRadialGradient(W*.5,H*.44,H*.2,W*.5,H*.5,W*.63);vignette.addColorStop(0,'rgba(5,2,14,0)');vignette.addColorStop(1,current.name==='desk'?'rgba(15,10,25,.08)':'rgba(8,3,22,.13)');ctx.fillStyle=vignette;ctx.fillRect(0,0,W,H);
  // Brief exposure accents join the match cuts without hiding the geometry.
  const cuts=[1.65,4,4.85,6.95,8,11.65,13.35,14.65];const distance=Math.min(...cuts.map(c=>Math.abs(t-c)));
  if(distance<.04){ctx.fillStyle=`rgba(228,211,255,${.085*(1-distance/.04)})`;ctx.fillRect(0,0,W,H)}
};
window.filmInfo={width:W,height:H,duration:18,fps:60,renderer:renderer.getContext().getParameter(renderer.getContext().RENDERER),scenes:stages.map(s=>({name:s.name,from:s.from,to:s.to}))};
window.renderFrame(0);
}
window.ready=build();
