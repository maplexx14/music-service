// Reuse Bolt's promo path and palette (DemoMode.jsx / promo.css), plus the
// loader's original SVG sprites for the one-shot reaction burst.
const fxBoltPath=new Path2D('M20 4l26 2-12 32h18L12 92l10-42H6z');
const fxHead=new Image();fxHead.src='assets/camel-surprised.png';
const fxSprites=[1,2,3].map(i=>{const image=new Image();image.src=`assets/effect-bolt-${i}.svg`;return image;});
const fxCard=document.createElement('canvas');fxCard.width=936;fxCard.height=1260;
const fxCardCtx=fxCard.getContext('2d');
const fxOriginalBackground=dBackground,fxOriginalService=dService;
const fxOut=x=>1-(1-clamp(x))**4;
const fxMix=(a,b,p)=>a+(b-a)*p;
function fxStrike(age){
  if(age<0||age>.9)return {scale:1,alpha:.46,glow:0};
  const keys=[[0,1,.46],[.108,1.45,1],[.198,1.30,.64],[.288,1.25,1],[.9,1,.46]];
  for(let i=1;i<keys.length;i++)if(age<=keys[i][0]){
    const a=keys[i-1],b=keys[i],p=smooth((age-a[0])/(b[0]-a[0]));
    return {scale:fxMix(a[1],b[1],p),alpha:fxMix(a[2],b[2],p),glow:1-age/.9};
  }
}
function fxBolt(x,y,width,rotation,alpha=1,glow=0){
  ctx.save();ctx.globalAlpha*=alpha;ctx.translate(x,y);ctx.rotate(rotation);
  ctx.scale(width/64,width/64);ctx.translate(-32,-48);
  ctx.lineWidth=3;ctx.lineJoin='round';
  const offset=2+glow*1.2;
  ctx.save();ctx.translate(-offset,1);ctx.strokeStyle='#22e4ff';ctx.stroke(fxBoltPath);ctx.restore();
  ctx.save();ctx.translate(offset,1);ctx.strokeStyle='#ff2fa0';ctx.stroke(fxBoltPath);ctx.restore();
  ctx.fillStyle='#8b3cf0';ctx.strokeStyle='#0d0420';
  if(glow>0){ctx.shadowColor='#ff2fa0';ctx.shadowBlur=12*glow;}
  ctx.fill(fxBoltPath);ctx.shadowBlur=0;ctx.stroke(fxBoltPath);ctx.restore();
}
function fxIntroBolts(t){
  const positions=[[91,349,104,-.24],[958,400,85,.28],[988,1040,96,.38],[78,1100,80,-.35]];
  const beats=[.08,1.72,3.36,4.53,5.58,7.39];
  positions.forEach(([x,y,size,rotation],i)=>{
    const active=beats.filter((beat,j)=>j%4===i&&beat<=t).at(-1);
    const pulse=fxStrike(active===undefined?-1:t-active);
    const float=Math.sin(t*Math.PI/6+i*1.4)*12;
    fxBolt(x,y+float,size*pulse.scale,rotation,pulse.alpha,pulse.glow);
  });
}
dBackground=function(t,scene){fxOriginalBackground(t,scene);fxIntroBolts(t);};
function fxServiceBolts(t){
  const click=(8.9+window.DYNAMIC_CAPTURE.clickAt)/1.1-.7;
  [[39,690,61,-.22],[1040,620,64,.32],[40,1520,59,-.32],[1030,1514,76,.24]].forEach(([x,y,size,rotation],i)=>{
    const age=t-(i%2?click:dynamicReveal+.04),pulse=fxStrike(age);
    fxBolt(x,y+Math.sin(t*.7+i)*8,size*pulse.scale,rotation,pulse.alpha*.8,pulse.glow);
  });
}
function fxReactionBurst(t){
  // Same staggered fan and decelerating flight as BoltLoader, played once.
  const angles=[-105,-46,12,53,-155];
  angles.forEach((deg,i)=>{
    const age=t-13.22-i*.055;if(age<0||age>.72)return;
    const p=age/.72,move=fxOut(p),angle=deg*Math.PI/180;
    const alpha=smooth(p/.12)*(1-smooth((p-.56)/.44));
    const distance=80+185*move,x=853+Math.cos(angle)*distance,y=1040+Math.sin(angle)*distance;
    const height=83*(.9+.1*move),sprite=fxSprites[i%3];
    ctx.save();ctx.globalAlpha=alpha;ctx.translate(x,y);ctx.rotate(angle-Math.PI/2+move*.16);
    ctx.drawImage(sprite,-height*76/136/2,-height/2,height*76/136,height);ctx.restore();
  });
}
function fxReaction(t){
  if(t<13.1)return;
  const layout=endingEase((t-13.1)/.62);
  // Move the existing recorded card as one plane; the logo and CTA stay sharp
  // and retain their screen positions throughout the reaction.
  fxCardCtx.clearRect(0,0,936,1260);fxCardCtx.drawImage(canvas,72,330,936,1260,0,0,936,1260);
  ctx.fillStyle='#050505';ctx.fillRect(72,330,936,1260);
  ctx.drawImage(fxCard,fxMix(72,62,layout),fxMix(330,432,layout),fxMix(936,608,layout),fxMix(1260,1260*608/936,layout));
  const age=t-13.22;if(age<0)return;
  const enter=fxOut(age/.5),alpha=smooth(age/.16);
  const spring=age<.65?1-.08*Math.exp(-age*8)*Math.cos(age*15):1;
  fxReactionBurst(t);
  ctx.save();ctx.globalAlpha=alpha;
  const x=850,y=1150+(1-enter)*135;
  ctx.translate(x,y);ctx.rotate((1-enter)*.09);ctx.scale(-spring,spring);
  const width=510,height=width*fxHead.naturalHeight/fxHead.naturalWidth;
  ctx.drawImage(fxHead,-width/2,-height*.54,width,height);
  ctx.restore();
  const punctuation=ease((age-.14)/.2);
  ctx.save();ctx.globalAlpha=punctuation;ctx.translate(944,785+(1-punctuation)*18);ctx.rotate(.12);
  ctx.shadowColor='#ff2fa060';ctx.shadowBlur=14;
  dText('?!',0,0,110,'#dfbcff',750,'center',220);ctx.restore();
}
dService=function(t){
  fxOriginalService(t);fxReaction(t);fxServiceBolts(t);
};
const fxInheritedReady=window.ready;
window.ready=Promise.all([fxInheritedReady,fxHead.decode(),...fxSprites.map(sprite=>sprite.decode())]).then(()=>window.renderFrame(0));
