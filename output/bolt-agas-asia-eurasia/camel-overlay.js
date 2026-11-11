const canvas=document.getElementById('film'),ctx=canvas.getContext('2d');
const W=1080,H=1920;
const clamp=x=>Math.max(0,Math.min(1,x));
const ease=x=>1-(1-clamp(x))**3;
const smooth=x=>{x=clamp(x);return x*x*(3-2*x);};
const C={outline:'#332134',sand:'#ddb17b',light:'#f6d49b',shade:'#b7845a',hoof:'#59424a',pink:'#df9b80'};
function shape(path,fill,stroke=C.outline,width=5){ctx.fillStyle=fill;ctx.fill(new Path2D(path));if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=width;ctx.lineJoin='round';ctx.lineCap='round';ctx.stroke(new Path2D(path));}}
function stroke(path,color,width){ctx.strokeStyle=color;ctx.lineWidth=width;ctx.lineJoin='round';ctx.lineCap='round';ctx.stroke(new Path2D(path));}
function ellipse(x,y,rx,ry,fill){ctx.beginPath();ctx.ellipse(x,y,rx,ry,0,0,Math.PI*2);ctx.fillStyle=fill;ctx.fill();}
function label(s,x,y,size,color){ctx.font=`600 ${size}px Unbounded`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle=color;ctx.fillText(s,x,y);}

function mountain(t){
  const arrive=ease(t/.24);
  ctx.save();ctx.translate(0,18*(1-arrive));
  // A broad rocky summit makes the four feet visibly rest on the same ledge.
  shape('M 204 504 L 354 463 L 403 444 L 669 444 L 718 464 L 885 504 L 898 516 L 184 516 Z','#604a70','#8a6a94',2);
  shape('M 403 444 L 669 444 L 653 455 L 422 455 Z','#c3a8b9',null);
  shape('M 422 455 L 525 460 L 446 515 L 239 515 Z','#80607f',null);
  shape('M 545 456 L 653 455 L 806 511 L 670 515 Z','#4d3b61',null);
  stroke('M 486 470 L 463 486 L 479 493 M 630 471 L 659 483 M 345 490 L 321 500','#aa849a',3);
  ellipse(526,447,147,9,'#32243d60');
  ctx.restore();
}
function leg(x,phase,t,front){
  const walk=1-smooth((t-.65)/.3);
  const swing=Math.sin(t*12+phase)*17*walk;
  const kneeX=x+swing*.75,footX=x+swing;
  const footY=170-Math.max(0,Math.cos(t*12+phase))*15*walk;
  const legColor=front?C.sand:C.shade;
  stroke(`M ${x} 37 Q ${kneeX-5} 89 ${kneeX} 106 L ${footX+5} ${footY-5}`,C.outline,19);
  stroke(`M ${x} 37 Q ${kneeX-5} 89 ${kneeX} 106 L ${footX+5} ${footY-5}`,legColor,12);
  ellipse(footX+10,footY,16,6,C.hoof);
  ellipse(kneeX,106,7,8,legColor);
}
function head(t){
  const react=smooth((t-1.65)/.3)*(1-smooth((t-3.0)/.35));
  const second=smooth((t-3.55)/.25)*(1-smooth((t-5.25)/.4));
  const tilt=-.07*react+.06*second;
  ctx.save();ctx.translate(103,-108);ctx.rotate(tilt);ctx.translate(-103,108);
  const ear=.11*Math.sin(t*2.4)+.13*react;
  ctx.save();ctx.translate(98,-149);ctx.rotate(ear);
  shape('M 0 4 Q -29 -10 -21 -31 Q -3 -27 8 -3 Z',C.sand);
  shape('M -4 -3 Q -17 -16 -17 -23 Q -7 -18 0 -4 Z',C.pink,null);
  ctx.restore();
  shape('M 87 -115 Q 77 -130 89 -149 Q 96 -163 117 -157 Q 133 -154 141 -141 L 161 -139 Q 179 -135 177 -122 Q 174 -109 154 -108 L 118 -107 Q 98 -101 87 -115 Z',C.light);
  ellipse(157,-123,17,12,'#e7b881');
  ellipse(166,-124,3.1,2.4,C.outline);
  const blink=[1.32,4.65,6.8].some(at=>Math.abs(t-at)<.075);
  if(blink){stroke('M 102 -137 Q 111 -132 120 -137',C.outline,4);}
  else{
    ellipse(112,-137,11,13,'#fff9eb');
    ellipse(115+react*2-second*4,-136,4.2,6.5,C.outline);
    ellipse(117+react*2-second*4,-139,1.5,2,'#fff');
  }
  stroke(`M 101 ${-154-react*4} Q 111 ${-159-react*7} 121 ${-154-react*4}`,C.outline,3.5);
  stroke('M 146 -112 Q 158 -108 169 -114',C.outline,3);
  ctx.restore();
}
function camel(t){
  const enter=ease(t/.95),x=485+55*enter;
  const walk=1-smooth((t-.65)/.3);
  const bob=Math.sin(t*12)*2.6*walk+Math.sin(t*2)*.8;
  ctx.save();ctx.translate(x,320+bob);ctx.scale(.95,.72);
  const tail=8*Math.sin(t*2.9);
  stroke(`M -128 2 Q -166 ${4+tail} -169 ${38+tail}`,C.outline,8);
  stroke(`M -128 2 Q -166 ${4+tail} -169 ${38+tail}`,C.sand,4);
  shape(`M -173 ${30+tail} Q -186 ${44+tail} -170 ${53+tail} Q -158 ${41+tail} -173 ${30+tail}`,C.hoof,null);
  leg(-70,Math.PI,t,false);leg(25,0,t,false);
  shape('M -134 -7 Q -122 -31 -75 -31 L -47 -31 Q -37 -38 -29 -67 Q -15 -108 4 -85 Q 23 -64 29 -31 Q 66 -33 90 -16 Q 111 4 92 34 Q 75 57 37 59 L -75 57 Q -128 54 -138 27 Q -143 11 -134 -7 Z',C.sand);
  shape('M -37 -39 Q -26 -93 -10 -85 Q 1 -80 13 -48 Q -6 -67 -19 -40 Z','#f4cc92',null);
  shape('M -125 25 Q -56 64 74 32 Q 74 55 35 59 L -75 57 Z',C.shade,null);
  leg(-108,0,t,true);leg(64,Math.PI,t,true);
  shape('M 59 -14 Q 95 -24 103 -52 Q 111 -78 94 -103 Q 81 -122 94 -138 Q 108 -146 123 -130 Q 129 -119 130 -95 Q 151 -65 137 -25 Q 127 10 93 30 L 76 32 Z',C.sand);
  stroke('M 107 -107 Q 127 -71 116 -38 Q 108 -12 89 -3',C.light,8);
  stroke('M -118 -5 Q -85 -16 -57 -12','#f6d6a5',5);
  head(t);
  ctx.restore();
}
function surprise(t){
  const alpha=ease((t-1.8)/.2)*(1-smooth((t-3.0)/.25));
  if(alpha<=0)return;
  ctx.save();ctx.globalAlpha*=alpha;
  ctx.translate(766,229-12*ease((t-1.8)/.3));ctx.rotate(.07*Math.sin(t*2));
  label('?',0,0,44,'#d4b4ff');
  ctx.restore();
}
function oxygen(t){
  const start=5.71;
  for(let i=0;i<4;i++){
    const age=t-start-i*.28;if(age<0||age>1.8)continue;
    const p=age/1.8,alpha=ease(age/.16)*(1-smooth((p-.6)/.4));
    const x=718+i*47+Math.sin(p*4+i)*9,y=345-p*150-i*4;
    const r=(i%2?17:27)*(.8+.2*ease(age/.25));
    ctx.save();ctx.globalAlpha*=alpha;
    ellipse(x,y,r,r,'#b793ff16');ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.strokeStyle='#bfa4ed';ctx.lineWidth=2;ctx.stroke();
    if(t>=6.35&&i%2===0)label('O₂',x,y+1,21,'#e6d7ff');
    else ellipse(x-r*.3,y-r*.3,3.5,3.5,'#e5d7ff');
    ctx.restore();
  }
}
window.renderFrame=t=>{
  ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,W,H);
  const alpha=ease(t/.2)*(1-smooth((t-7.14)/.25));
  if(alpha<=0)return;
  ctx.save();ctx.globalAlpha=alpha;mountain(t);camel(t);surprise(t);oxygen(t);ctx.restore();
};
window.ready=Promise.all([document.fonts.load('600 44px Unbounded','? O₂'),new Promise((resolve,reject)=>{const video=document.getElementById('base');if(video.readyState>=2)return resolve();video.addEventListener('loadeddata',resolve,{once:true});video.addEventListener('error',()=>reject(Error('Base video unavailable')),{once:true});})]).then(()=>window.renderFrame(1));
