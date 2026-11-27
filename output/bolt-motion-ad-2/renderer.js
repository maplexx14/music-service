/* Russian Bolt adaptation of spotify motion graphics ad(1).mp4. */
const canvas=document.getElementById('film'),ctx=canvas.getContext('2d',{alpha:false});
const vertical=new URLSearchParams(location.search).get('format')==='tiktok';
const W=vertical?1080:1920,H=vertical?1920:1080,DURATION=10.4,X=vertical?500:960;
canvas.width=W;canvas.height=H;
if(vertical){canvas.style.width='min(86vw,43vh)';canvas.style.aspectRatio='9/16';document.querySelector('nav a').href='bolt-motion-ru-tiktok.mp4'}
const clamp=x=>Math.max(0,Math.min(1,x)),ease=x=>1-Math.pow(1-clamp(x),4),mix=(a,b,p)=>a+(b-a)*p;
const logo=new Image(),mark=new Image();logo.src='assets/bolt.webp';mark.src='assets/mark.png';
const C={ink:'#222222',violet:'#351467',white:'#fffaff',accent:'#a37bff'};
function rect(x,y,w,h,color){ctx.fillStyle=color;ctx.fillRect(x,y,w,h)}
function text(str,x,y,size=96,align='center',color=C.white){ctx.font=`700 ${size}px Geologica`;ctx.fillStyle=color;ctx.textAlign=align;ctx.textBaseline='middle';ctx.fillText(str,x,y)}
function image(img,x,y,width){ctx.drawImage(img,x-width/2,y-width*img.height/img.width/2,width,width*img.height/img.width)}
function fly(str,x,y,size,at,t,align='center',travel=200){
 const p=clamp((t-at)/.22);if(!p)return;const e=ease(p);
 ctx.save();ctx.globalAlpha*=Math.min(1,p*2.2);ctx.filter=p<.85?`blur(${(1-p)*9}px)`:'none';
 ctx.translate(x+travel*(1-e),y);ctx.scale(1+.12*Math.sin(p*Math.PI)*(1-p),1);text(str,0,0,size,align);ctx.restore();
}
function intro(t){
 rect(0,0,W,H,C.ink);
 const lines=vertical?[
  {y:675,words:[['Вся',.12],['музыка,',.42]]},
  {y:810,words:[['которую',.82]]},
  {y:945,words:[['ты',1.16],['любишь.',1.48]]}
 ]:[{y:450,words:[['Вся',.12],['музыка,',.42],['которую',.82]]},{y:595,words:[['ты',1.16],['любишь.',1.48]]}];
 const size=vertical?94:112,gap=26;
 const exit=ease((t-2.15)/.25);
 ctx.save();ctx.translate(X,vertical?810:520);ctx.rotate(-.055*exit);ctx.scale(1-.13*exit,1-.13*exit);ctx.translate(-X,-(vertical?810:520));ctx.globalAlpha=1-exit;
 for(const line of lines){ctx.font=`700 ${size}px Geologica`;const widths=line.words.map(([w])=>ctx.measureText(w).width);let x=X-(widths.reduce((a,b)=>a+b,0)+gap*(widths.length-1))/2;
  line.words.forEach(([word,at],i)=>{fly(word,x,line.y,size,at,t,'left',220);x+=widths[i]+gap});
 }ctx.restore();
}
function background(){rect(0,0,W,H,C.violet)}
const headerY=vertical?395:184;
function brand(t){
 background();const arrival=ease((t-2.4)/.25),lift=ease((t-2.82)/.34);
 ctx.save();ctx.globalAlpha=arrival;ctx.translate(X,mix(vertical?870:540,headerY,lift));
 ctx.rotate((1-arrival)*-.25);ctx.scale(mix(.65,1,arrival),mix(.65,1,arrival));
 ctx.save();ctx.globalAlpha*=1-lift;image(mark,-20*lift,0,mix(230,120,lift));ctx.restore();
 ctx.save();ctx.globalAlpha*=lift;image(logo,0,0,vertical?425:355);ctx.restore();ctx.restore();
}
const listing=[
 {at:3.2,end:3.84,word:'исполнители.'},
 {at:3.84,end:4.48,word:'группы.'},
 {at:4.48,end:5.12,word:'плейлисты.'},
 {at:5.12,end:5.76,word:'треки.'}
];
function enumeration(t){
 const scene=listing.find(s=>t>=s.at&&t<s.end);if(!scene)return;
 if(vertical){text('Твои',X,740,93);text('любимые',X,875,93);fly(scene.word,X,1010,87,scene.at,t,'center',145)}
 else{
  const size=87,prefix='Твои любимые ';ctx.font=`700 ${size}px Geologica`;const prefixWidth=ctx.measureText(prefix).width,maxWidth=ctx.measureText('исполнители.').width,left=X-(prefixWidth+maxWidth)/2;
  text(prefix,left,552,size,'left');fly(scene.word,left+prefixWidth,552,size,scene.at,t,'left',155);
 }
}
const cards=[
 {at:5.76,end:6.56,text:'Вся твоя музыка.',lines:['Вся твоя','музыка.']},
 {at:6.56,end:7.36,text:'В любое время.',lines:['В любое','время.']},
 {at:7.36,end:8.16,text:'Где угодно.',lines:['Где','угодно.']},
 {at:8.16,end:9.0,text:'Без ограничений.',lines:['Без','ограничений.']}
];
function statement(t){const scene=cards.find(s=>t>=s.at&&t<s.end);if(!scene)return;
 if(vertical)scene.lines.forEach((s,i)=>fly(s,X,820+i*135,96,scene.at+i*.025,t,'center',140));
 else fly(scene.text,X,552,110,scene.at,t,'center',175);
}
function outro(t){
 background();const p=ease((t-9)/.30);
 image(logo,X,mix(headerY,vertical?805:465,p),mix(vertical?425:355,vertical?720:640,p));
 fly('Включай Bolt.',X,vertical?1100:675,80,9.25,t,'center',100);
}
window.renderFrame=t=>{
 t=Math.max(0,Math.min(DURATION-1/60,t));
 if(t<2.4)intro(t);
 else if(t<2.65){rect(0,0,W,H,C.ink);const p=ease((t-2.4)/.25);ctx.save();ctx.beginPath();ctx.rect(0,0,W,H*p);ctx.clip();brand(t);ctx.restore()}
 else if(t<9){brand(t);enumeration(t);statement(t)}else outro(t);
};
window.ready=Promise.all([document.fonts.load('700 112px Geologica','Вся музыка, которую ты любишь.'),document.fonts.load('700 80px Geologica','Bolt'),logo.decode(),mark.decode()]).then(()=>window.renderFrame(0));
const play=document.getElementById('play'),seek=document.getElementById('seek'),time=document.getElementById('time'),sound=document.getElementById('sound');
let running=false,start=0,at=0;seek.max=DURATION-1/60;
function display(t){window.renderFrame(t);seek.value=t;time.textContent=`${t.toFixed(1)} / ${DURATION.toFixed(1)}`}
function tick(now){if(!running)return;at=Math.min(DURATION-1/60,(now-start)/1000);display(at);if(at>=DURATION-1/60){running=false;play.textContent='Смотреть';sound.pause()}else requestAnimationFrame(tick)}
play.onclick=()=>{if(running){running=false;sound.pause();play.textContent='Смотреть';return}if(at>=DURATION-.02)at=0;running=true;start=performance.now()-at*1000;sound.currentTime=at;sound.play().catch(()=>{});play.textContent='Пауза';requestAnimationFrame(tick)};
seek.oninput=()=>{at=Number(seek.value);start=performance.now()-at*1000;sound.currentTime=at;display(at)};display(0);
