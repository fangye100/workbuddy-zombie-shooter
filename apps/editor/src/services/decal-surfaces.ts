import {invert,composeQuat,multiply,type Mat4} from '@aether/core';
import {rayVisibleMesh} from '@aether/runtime';
import type {CombatDecalProjector} from '@aether/zombie-game/presentation/combat-decals';
import type {LabRenderer} from '../renderer';
/** 可见几何适配器：AABB预剔除后只对事件涉及的静态接收面做三角形求交。 */
export function combatDecalProjector(renderer:LabRenderer):CombatDecalProjector {
  return (fact,rule,config)=>{
    const doc=renderer.getDocument();if(!doc)return null;
    const wall=fact.event==='weapon-solid-impact';
    const from: [number,number,number]=wall?fact.point.map((v,i)=>v-fact.direction[i]!*config.surfaceSnapM) as [number,number,number]:[fact.point[0],fact.point[1]+.1,fact.point[2]];
    const direction:[number,number,number]=wall?[...fact.direction]:[0,-1,0];const range=wall?config.surfaceSnapM*2:config.groundProbeM+.1;
    let best:{receiver:string;matrix:Mat4;point:[number,number,number];normal:[number,number,number];distance:number}|null=null;
    for(const object of renderer.state.objects){
      if(!object.nodeId||object.removed||!object.visible||(!wall&&object.background)||(wall&&object.nodeId!==fact.receiver))continue;
      const node=doc.nodes.find(n=>n.id===object.nodeId),mesh=node?.components.find(c=>c.kind==='MeshRenderer'&&c.enabled);
      if(!node?.visible||mesh?.kind!=='MeshRenderer'||mesh.editorOnly||mesh.playBinding||mesh.sharedMotion||mesh.bodyIk||node.id===doc.playerStart)continue;
      const matrix=new Float32Array(16);composeQuat(matrix,...object.pos,object.quat,object.scale);
      const hit=rayVisibleMesh({vertices:object.mesh.vertices,indices:object.mesh.indices,matrix,min:object.localMin,max:object.localMax,ranges:object.subMeshes},from,direction,range);
      if(!hit||(!wall&&hit.normal[1]<.4)||(best&&best.distance<=hit.distance))continue;
      best={...hit,receiver:node.id,matrix};
    }
    if(!best)return null;
    const m=best.matrix,inv=invert(new Float32Array(16),m),p=best.point,n=best.normal;
    const position:[number,number,number]=[inv[0]!*p[0]+inv[4]!*p[1]+inv[8]!*p[2]+inv[12]!,inv[1]!*p[0]+inv[5]!*p[1]+inv[9]!*p[2]+inv[13]!,inv[2]!*p[0]+inv[6]!*p[1]+inv[10]!*p[2]+inv[14]!];
    const local=[m[0]!*n[0]+m[1]!*n[1]+m[2]!*n[2],m[4]!*n[0]+m[5]!*n[1]+m[6]!*n[2],m[8]!*n[0]+m[9]!*n[1]+m[10]!*n[2]],length=Math.hypot(...local);if(length<1e-8)return null;
    const [nx,ny,nz]=local.map(v=>v/length),q=ny!<-.999999?[1,0,0,0]:[nz!,0,-nx!,1+ny!],ql=Math.hypot(...q),rotation=q.map(v=>v/ql) as [number,number,number,number];
    const localMatrix=new Float32Array(16),world=new Float32Array(16);composeQuat(localMatrix,0,0,0,rotation,1);multiply(world,m,localMatrix);
    const size=fact.event==='acid-land'?[fact.radius*2,fact.radius*2]:rule.size;
    const scaled:[number,number]=[size[0]!/Math.hypot(world[0]!,world[1]!,world[2]!),size[1]!/Math.hypot(world[8]!,world[9]!,world[10]!)];
    if(!scaled.every(v=>v>=.01&&v<=100))return null;
    return {receiver:best.receiver,position,rotation,size:scaled};
  };
}
