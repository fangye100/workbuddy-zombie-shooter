import type { AttackStats } from '@aether/content';
import type { AttackPoint, EnemyAttackEffect } from '@aether/zombie-game';
type Project = (p: readonly [number,number,number])=>{x:number;y:number;behind:boolean};
const INK='#14110f';
function line(c:CanvasRenderingContext2D,a:{x:number;y:number},b:{x:number;y:number},color:string,width:number):void {
  c.beginPath();c.moveTo(a.x,a.y);c.lineTo(b.x,b.y);c.strokeStyle=INK;c.lineWidth=width+3;c.stroke();c.strokeStyle=color;c.lineWidth=width;c.stroke();
}
function ring(c:CanvasRenderingContext2D,project:Project,x:number,z:number,r:number,fill:string,color:string,y=0):void {
  c.beginPath();for(let i=0;i<=40;i++){const t=i/40*Math.PI*2,p=project([x+Math.cos(t)*r,y+.08,z+Math.sin(t)*r]);if(p.behind)return;if(i===0)c.moveTo(p.x,p.y);else c.lineTo(p.x,p.y);}
  c.closePath();c.fillStyle=fill;c.strokeStyle=color;c.lineWidth=2;c.fill();c.stroke();
}
/** Purposeful, time-limited design telegraphs; no general melee range sectors. */
export function drawAttackCue(c:CanvasRenderingContext2D,p:Project,a:AttackStats,x:number,z:number,yaw:number,remaining:number,target?:AttackPoint,y=0):void {
  const kind=a.kind??'melee';const origin=p([x,y+1.4,z]);if(origin.behind)return;
  c.save();const progress=Math.max(0,Math.min(1,1-Math.max(0,remaining)/Math.max(.01,a.windupSec)));
  if(kind==='acid' && target){ring(c,p,target[0],target[2],a.poolRadiusM!,'#85dd3930','#bded5c',target[1]);line(c,origin,{x:origin.x,y:origin.y-10},'#bded5c',6);}
  else if((kind==='pounce' || kind==='charge') && target){const end=p(target);if(!end.behind){c.setLineDash([6,5]);line(c,p([x,y+.1,z]),end,'#ffc531',3);}}
  else if(kind==='explode'){ring(c,p,x,z,a.rangeM,'#ef674530','#ff7759',y);}
  // An ink-edged glow and anticipation slash around the actor replace the debugging wedge.
  c.globalAlpha=.5+.5*progress;c.beginPath();c.arc(origin.x,origin.y,5+progress*9,0,Math.PI*2);c.fillStyle=kind==='acid'?'#b8f05f':kind==='explode'?'#ff5b43':'#ffc531';c.strokeStyle=INK;c.lineWidth=2;c.fill();c.stroke();
  c.restore();
}
export function drawEnemyAttack(c:CanvasRenderingContext2D,p:Project,e:EnemyAttackEffect,age:number):void {
  const q=p(e.position);if(q.behind)return;c.save();c.lineCap='round';
  if(e.kind==='acid'){
    if(e.blocked){c.globalAlpha=Math.max(0,1-age/e.duration);c.fillStyle='#b8ef4e';c.beginPath();c.arc(q.x,q.y,13,0,Math.PI*2);c.fill();}
    else if(e.phase==='flight'){
      const t=Math.min(1,age/e.flightSeconds),prev=Math.max(0,t-.14);
      const a=p([e.from[0]+(e.to[0]-e.from[0])*prev,e.from[1]*(1-prev)+e.to[1]*prev+8.8*prev*(1-prev),e.from[2]+(e.to[2]-e.from[2])*prev]);
      line(c,a,q,'#86dd39',7);c.fillStyle='#d5ff86';c.strokeStyle=INK;c.lineWidth=3;c.beginPath();c.arc(q.x,q.y,8,0,Math.PI*2);c.fill();c.stroke();
      for(let i=0;i<3;i++){c.fillStyle='#a9ed51';c.beginPath();c.arc(q.x-10-i*6,q.y+5+i*3,3-i*.5,0,Math.PI*2);c.fill();}
    }else{
      const fade=Math.min(1,(e.duration-age)*2);c.globalAlpha=fade;ring(c,p,e.to[0],e.to[2],e.radius,'#6cae3770','#c7f06a',e.to[1]);
      for(let i=0;i<7;i++){const angle=i*2.4+age*.35;const b=p([e.to[0]+Math.cos(angle)*e.radius*.65,e.to[1]+.12,e.to[2]+Math.sin(angle)*e.radius*.65]);c.beginPath();c.arc(b.x,b.y,3+Math.sin(age*4+i)*1.5,0,Math.PI*2);c.fillStyle='#bcf570';c.fill();}
    }
  }else if(e.kind==='pounce' || e.kind==='charge'){
    const a=p(e.from);c.globalAlpha=.8;line(c,a,q,e.kind==='charge'?'#ffc531':'#fff6e2',3);
    for(let i=0;i<3;i++)line(c,{x:q.x-12,y:q.y+i*6-6},{x:q.x-27,y:q.y+i*6-6},'#fff6e2',2);
    if(e.finished)ring(c,p,e.position[0],e.position[2],e.radius,'#ffc53125','#fff6e2',e.position[1]);
  }else{
    const t=age/e.duration;c.globalAlpha=1-t;
    if(e.kind==='explode' || e.kind==='slam')ring(c,p,e.from[0],e.from[2],e.radius*(.3+t*.7),'#ef674542','#ffc531',e.from[1]);
    else {const a=p([e.from[0],e.from[1]+1,e.from[2]]),b=p([e.to[0],e.to[1]+1,e.to[2]]);line(c,a,b,'#fff6e2',4);}
    for(let i=0;i<8;i++){const angle=i*Math.PI/4,r=10+t*30;line(c,{x:q.x+Math.cos(angle)*r,y:q.y+Math.sin(angle)*r},{x:q.x+Math.cos(angle)*(r+9),y:q.y+Math.sin(angle)*(r+9)},'#ffc531',2);}
  }
  c.restore();
}
