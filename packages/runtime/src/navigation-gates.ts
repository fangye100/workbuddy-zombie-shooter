import type { Mat4 } from '@aether/core';
import {intervalsPenetrate} from '@aether/core';
import type { ColliderComponent, NodeId } from '@aether/scene';
import { solidCollider, type SolidColliderDesc } from './solid-ray';

export interface GateBounds {minX:number;maxX:number;minY:number;maxY:number;minZ:number;maxZ:number}
export interface NavigationGateDesc {
  nodeId:NodeId;world:Mat4;shape:ColliderComponent['shape'];bounds:GateBounds;
  openOffset:readonly [number,number,number];travelSec:number;initialOpen:boolean;
}
export interface GateOccupant {x:number;y:number;z:number;radius:number;height:number}
interface GateState {desc:NavigationGateDesc;progress:number;targetOpen:boolean;waiting:boolean;solid:SolidColliderDesc;bounds:GateBounds}

/** 通用运动学门。宿主提供占用查询；门的姿态、净空、射线来自同一进度。 */
export class NavigationGates {
  private readonly gates=new Map<NodeId,GateState>();
  constructor(descriptions:readonly NavigationGateDesc[]){
    for(const source of descriptions){
      const desc={...source,world:new Float32Array(source.world),shape:structuredClone(source.shape),bounds:{...source.bounds},openOffset:[...source.openOffset] as [number,number,number]};
      if(this.gates.has(desc.nodeId)||!Number.isFinite(desc.travelSec)||desc.travelSec<=0||!desc.openOffset.every(Number.isFinite)
        ||!Object.values(desc.bounds).every(Number.isFinite))throw new RangeError('运动门描述非法');
      const g:GateState={desc,progress:desc.initialOpen?1:0,targetOpen:desc.initialOpen,waiting:false,solid:solidCollider(desc.nodeId,desc.shape,desc.world),bounds:{...desc.bounds}};
      this.gates.set(desc.nodeId,g);this.pose(g);
    }
  }
  setOpen(nodeId:NodeId,open:boolean):void {
    const g=this.gates.get(nodeId);if(!g)throw new Error(`未登记运动门 ${nodeId}`);
    if(typeof open!=='boolean')throw new TypeError('门开关必须是布尔值');g.targetOpen=open;g.waiting=false;
  }
  reset():void {for(const g of this.gates.values()){g.progress=g.desc.initialOpen?1:0;g.targetOpen=g.desc.initialOpen;g.waiting=false;this.pose(g);}}
  private boundsAt(g:GateState,progress:number):GateBounds {
    const [dx,dy,dz]=g.desc.openOffset,b=g.desc.bounds;
    return {minX:b.minX+dx*progress,maxX:b.maxX+dx*progress,minY:b.minY+dy*progress,maxY:b.maxY+dy*progress,minZ:b.minZ+dz*progress,maxZ:b.maxZ+dz*progress};
  }
  private pose(g:GateState):void {
    const world=new Float32Array(g.desc.world);
    for(let i=0;i<3;i++)world[12+i]=world[12+i]!+g.desc.openOffset[i]!*g.progress;
    g.solid=solidCollider(g.desc.nodeId,g.desc.shape,world);g.bounds=this.boundsAt(g,g.progress);
  }
  step(dt:number,occupied:(swept:GateBounds,nodeId:NodeId)=>boolean):boolean {
    if(!Number.isFinite(dt)||dt<=0)throw new RangeError('门步长非法');let changed=false;
    for(const g of this.gates.values()){
      const next=Math.max(0,Math.min(1,g.progress+(g.targetOpen?1:-1)*dt/g.desc.travelSec));g.waiting=false;
      if(next===g.progress)continue;
      const b=this.boundsAt(g,next),a=g.bounds,swept={minX:Math.min(a.minX,b.minX),maxX:Math.max(a.maxX,b.maxX),minY:Math.min(a.minY,b.minY),maxY:Math.max(a.maxY,b.maxY),minZ:Math.min(a.minZ,b.minZ),maxZ:Math.max(a.maxZ,b.maxZ)};
      // 两个方向都检查扫掠体；关门等待而非压入角色，开门也不能撞到上层角色。
      if(occupied(swept,g.desc.nodeId)){g.waiting=true;continue;}
      g.progress=next;this.pose(g);changed=true;
    }return changed;
  }
  obstacles(){return Array.from(this.gates.values(),g=>({id:g.desc.nodeId,...g.bounds}));}
  solids():SolidColliderDesc[]{return Array.from(this.gates.values(),g=>g.solid);}
  snapshot(){return Array.from(this.gates.values(),g=>({nodeId:g.desc.nodeId,progress:g.progress,targetOpen:g.targetOpen,waiting:g.waiting,
    state:g.waiting?'waiting':g.progress===0?'closed':g.progress===1?'open':g.targetOpen?'opening':'closing',
    position:[g.desc.world[12]!+g.desc.openOffset[0]*g.progress,g.desc.world[13]!+g.desc.openOffset[1]*g.progress,g.desc.world[14]!+g.desc.openOffset[2]*g.progress] as [number,number,number],bounds:{...g.bounds}}));}
}

/** 保守圆柱/AABB 重叠，与运动导航的垂直净空定义一致。 */
export function gateOverlapsActor(b:GateBounds,a:GateOccupant):boolean {
  return intervalsPenetrate(b.minY,b.maxY,a.y+.04,a.y+a.height-.01)
    &&intervalsPenetrate(b.minX,b.maxX,a.x-a.radius,a.x+a.radius)&&intervalsPenetrate(b.minZ,b.maxZ,a.z-a.radius,a.z+a.radius);
}
