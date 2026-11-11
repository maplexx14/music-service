// The photographic cutout shares the vector character's stage coordinates,
// so the existing shot changes, camera crops and karaoke timings stay intact.
const camelPhoto=new Image();
camelPhoto.src='assets/camel.png';
camel=function(t){
  if(!camelPhoto.complete||!camelPhoto.naturalWidth)return;
  const enter=ease(t/.95),walk=1-smooth((t-.65)/.3);
  const bob=Math.sin(t*12)*2.6*walk+Math.sin(t*2)*.8;
  const reaction=smooth((t-1.65)/.3)*(1-smooth((t-3.0)/.35));
  const width=330,height=width*camelPhoto.naturalHeight/camelPhoto.naturalWidth;
  ctx.save();
  ctx.translate(540-55*(1-enter),447+bob);
  // Level the photograph's sloping sand line with the mountain ledge.
  ctx.rotate(-.065+Math.sin(t*12)*.009*walk-.018*reaction);
  ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
  ctx.drawImage(camelPhoto,-172,-height,width,height);
  ctx.restore();
};
window.ready=Promise.all([window.ready,camelPhoto.decode()]);
