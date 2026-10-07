import type { RuntimeSession, WeaponEffect } from '@aether/runtime';
import type { WorldProjection } from './combat-overlay';

/** Procedural ink placeholders use simulation positions, never invent damage or animation clocks. */
export function drawWeaponEffect(c:CanvasRenderingContext2D,project:WorldProjection,e:WeaponEffect,age:number):void {
  const a=project(e.from),b=project(e.kind==='projectile'?e.position:e.to);
  if(a.behind || b.behind)return;
  c.save();c.globalAlpha=Math.max(0,1-age/e.duration);c.lineCap='round';c.strokeStyle=e.color;
  if(e.kind==='projectile'){c.globalAlpha=1;c.fillStyle=e.color;c.strokeStyle='#171327';c.lineWidth=3;c.beginPath();c.arc(b.x,b.y,5,0,Math.PI*2);c.fill();c.stroke();}
  else if(e.kind==='explosion'){
    const edge=project([e.from[0]+e.radius,.08,e.from[2]]),radius=Math.max(12,Math.hypot(edge.x-a.x,edge.y-a.y))*Math.min(1,.3+age/e.duration);
    c.fillStyle='#ff8c3188';c.strokeStyle='#ffc531';c.lineWidth=3;c.beginPath();
    for(let i=0;i<24;i++){const angle=i*Math.PI/12,r=radius*(i%2?.65:1);const x=a.x+Math.cos(angle)*r,y=a.y+Math.sin(angle)*r;if(i===0)c.moveTo(x,y);else c.lineTo(x,y);}c.closePath();c.fill();c.stroke();
  }else if(e.kind==='flame'){
    const dx=(e.to[0]-e.from[0])/e.radius,dz=(e.to[2]-e.from[2])/e.radius;
    // Ink-edged flame tongues, not a debug range polygon. Motion uses recorded simulation age.
    for(let i=0;i<9;i++){
      const t=(i+.5)/9,side=Math.sin(i*2.4+e.tick*.3+age*16)*t*e.radius*.13;
      const p=project([e.from[0]+dx*e.radius*t-dz*side,e.from[1],e.from[2]+dz*e.radius*t+dx*side]);if(p.behind)continue;
      const r=5+10*t;
      c.beginPath();c.moveTo(p.x-r,p.y+r*.3);c.quadraticCurveTo(p.x-r*1.1,p.y-r*.7,p.x-r*.2,p.y-r*.6);
      c.lineTo(p.x+r*.1,p.y-r*1.8);c.lineTo(p.x+r*.4,p.y-r*.5);c.quadraticCurveTo(p.x+r*1.3,p.y-r,p.x+r,p.y+r*.3);c.closePath();
      c.fillStyle='#f26a28';c.strokeStyle='#171327';c.lineWidth=2;c.fill();c.stroke();
      c.fillStyle='#ffc531';c.beginPath();c.moveTo(p.x-r*.5,p.y+r*.2);c.lineTo(p.x+r*.1,p.y-r);c.lineTo(p.x+r*.5,p.y+r*.2);c.closePath();c.fill();
    }
  }else if(e.kind==='slash'){
    const yaw=Math.atan2(e.to[2]-e.from[2],e.to[0]-e.from[0]),arc=e.spreadDeg*Math.PI/180;
    c.beginPath();for(let i=0;i<=16;i++){const angle=yaw-arc/2+i/16*arc,p=project([e.from[0]+Math.cos(angle)*e.radius,e.from[1],e.from[2]+Math.sin(angle)*e.radius]);if(i===0)c.moveTo(p.x,p.y);else c.lineTo(p.x,p.y);}
    c.strokeStyle='#171327';c.lineWidth=10;c.stroke();c.strokeStyle='#fff6e2';c.lineWidth=6;c.stroke();c.strokeStyle=e.color;c.lineWidth=2;c.stroke();
  }else{
    c.strokeStyle='#171327';c.lineWidth=e.kind==='pierce'?7:4;c.beginPath();c.moveTo(a.x,a.y);c.lineTo(b.x,b.y);c.stroke();
    c.strokeStyle=e.color;c.lineWidth=e.kind==='pierce'?4:2;c.stroke();
    c.fillStyle='#fff6e2';c.beginPath();c.arc(a.x,a.y,4,0,Math.PI*2);c.fill();
  }
  c.restore();
}

export function drawHeldWeapon(c:CanvasRenderingContext2D,project:WorldProjection,runtime:RuntimeSession,debug:boolean):void {
  const player=runtime.player();if(!player)return;
  const pose=runtime.weapons.poseIntent,def=runtime.weapons.definitions.find(w=>w.id===pose.weaponId)!;
  const y=runtime.weaponMount.position[1],dx=Math.cos(player.yaw),dz=Math.sin(player.yaw);
  const world=(v:readonly number[]):[number,number,number]=>[player.x+dx*v[0]!-dz*v[2]!,y+v[1]!,player.z+dz*v[0]!+dx*v[2]!];
  const local=(v:readonly number[]):[number,number,number]=>[v[0]!+pose.recoil.translation[0],v[1]!+Math.sin(pose.recoil.pitchDeg*Math.PI/180)*v[0]!,v[2]!];
  const base=project(world(local(pose.markers.primaryGrip.position))),muzzle=project(world(local(pose.markers.muzzle.position)));
  if(base.behind || muzzle.behind)return;
  c.save();c.lineCap='square';c.strokeStyle='#14110f';c.lineWidth=def.behavior==='melee'?11:8;c.beginPath();c.moveTo(base.x,base.y);c.lineTo(muzzle.x,muzzle.y);c.stroke();
  c.strokeStyle=def.presentation.color;c.lineWidth=def.behavior==='melee'?6:4;c.stroke();
  const hand=pose.markers[pose.reload.leftHandTarget as 'magazine'|'chamber'|'supportGrip'];
  const handPoint=project(world(local(hand.position)));c.fillStyle='#ffe4bd';c.beginPath();c.arc(handPoint.x,handPoint.y,3,0,Math.PI*2);c.fill();
  if(pose.action==='reload'){c.strokeStyle='#7bdbe4';c.lineWidth=2;c.beginPath();c.arc(base.x,base.y-12,8,-Math.PI/2,pose.phase*Math.PI*2-Math.PI/2);c.stroke();}
  if(debug)for(const [key,m] of Object.entries(pose.markers)){const p=project(world(m.position));if(p.behind)continue;c.fillStyle='#7bdbe4';c.fillRect(p.x-2,p.y-2,4,4);c.font='10px system-ui';c.fillText(key,p.x+4,p.y);}
  c.restore();
}
