import {composeQuat,multiply,hexToLinear,type Mat4} from '@aether/core';
import {validateDecalMark,DECAL_PATTERNS,DEFAULT_DECAL_STYLE,MAX_AUTHORED_DECALS,type DecalMark,type SceneDocument,type NodeId} from '@aether/scene';

export const MAX_RUNTIME_DECALS=512;
/** 5×vec4 / 80B：中心、两轴、颜色及可序列化的四项形态参数。 */
export const DECAL_INSTANCE_FLOATS=20;
export interface RuntimeDecal {receiver:NodeId;mark:DecalMark;ttlSec:number;fadeSec:number}
interface Entry extends RuntimeDecal {born:number}
/** 通用运行痕迹池：宿主注入模拟时间，不读取墙钟、游戏或 DOM。 */
export class DecalPool {
  private readonly entries=new Map<string,Entry>();
  private now=0;evicted=0;
  constructor(readonly capacity=MAX_RUNTIME_DECALS){if(!Number.isInteger(capacity)||capacity<1||capacity>MAX_RUNTIME_DECALS)throw new RangeError('贴花池容量非法');}
  emit(input:RuntimeDecal,elapsedSec=0):void {
    const errors=validateDecalMark(input.mark);
    if(typeof input.receiver!=='string'||!input.receiver||!Number.isFinite(input.ttlSec)||input.ttlSec<=0||input.ttlSec>120
      ||!Number.isFinite(input.fadeSec)||input.fadeSec<0||input.fadeSec>input.ttlSec||!Number.isFinite(elapsedSec)||elapsedSec<0||elapsedSec>=input.ttlSec||errors.length)throw new Error(`运行贴花参数非法：${errors.join('；')}`);
    const key=`${input.receiver}:${input.mark.id}`;
    if(this.entries.has(key))throw new Error(`运行贴花 id 已存在：${key}`);
    if(this.entries.size===this.capacity){this.entries.delete(this.entries.keys().next().value!);this.evicted++;}
    this.entries.set(key,{...structuredClone(input),born:this.now-elapsedSec});
  }
  advance(now:number):void {
    if(!Number.isFinite(now)||now<this.now)throw new RangeError('贴花模拟时间不得倒退');this.now=now;
    for(const [id,e]of this.entries)if(now>=e.born+e.ttlSec)this.entries.delete(id);
  }
  remove(receiver:NodeId,id:string):boolean {return this.entries.delete(`${receiver}:${id}`);}
  snapshot(){return {time:this.now,count:this.entries.size,capacity:this.capacity,evicted:this.evicted,marks:Array.from(this.entries.values(),e=>{
    const left=e.born+e.ttlSec-this.now,mark=structuredClone(e.mark);mark.opacity*=e.fadeSec>0?Math.min(1,left/e.fadeSec):1;
    return {receiver:e.receiver,mark,remainingSec:left};
  })};}
  clear():void {this.entries.clear();this.now=0;this.evicted=0;}
}
export type DecalReceiver=(id:NodeId)=>Mat4|null;
/** +Y 朝向的局部 XZ 平面，法线偏移保持世界米制，不随接收者非均匀缩放。 */
export function packDecalMark(out:Float32Array,offset:number,mark:DecalMark,receiver:Mat4):void {
  const local=new Float32Array(16),world=new Float32Array(16);
  composeQuat(local,...mark.position,mark.rotation,1);multiply(world,receiver,local);
  const ux=world[0]!,uy=world[1]!,uz=world[2]!,vx=world[8]!,vy=world[9]!,vz=world[10]!;
  const nx=vy*uz-vz*uy,ny=vz*ux-vx*uz,nz=vx*uy-vy*ux,n=Math.hypot(nx,ny,nz);
  if(n<1e-8)throw new Error('贴花接收变换退化');
  const color=hexToLinear(mark.color);
  out.set([world[12]!+nx/n*mark.normalOffset,world[13]!+ny/n*mark.normalOffset,world[14]!+nz/n*mark.normalOffset,DECAL_PATTERNS.indexOf(mark.pattern),
    ux*mark.size[0]/2,uy*mark.size[0]/2,uz*mark.size[0]/2,mark.seed,
    vx*mark.size[1]/2,vy*mark.size[1]/2,vz*mark.size[1]/2,0,
    color[0]!,color[1]!,color[2]!,mark.opacity],offset);
  const style=mark.style??DEFAULT_DECAL_STYLE;
  out.set([style.coverage,style.edgeWidth,style.irregularity,style.detail],offset+16);
}
export class DecalFrameBuilder {
  private readonly data=new Float32Array((MAX_AUTHORED_DECALS+MAX_RUNTIME_DECALS)*DECAL_INSTANCE_FLOATS);
  build(doc:SceneDocument|null,resolve:DecalReceiver,runtime:ReturnType<DecalPool['snapshot']>,camera:readonly number[]):Float32Array<ArrayBuffer> {
    const rows:{key:string;mark:DecalMark;matrix:Mat4;distance:number}[]=[];
    const add=(receiver:NodeId,mark:DecalMark)=>{
      const matrix=resolve(receiver);if(!matrix||mark.opacity<=0)return;
      const center=[matrix[0]!*mark.position[0]+matrix[4]!*mark.position[1]+matrix[8]!*mark.position[2]+matrix[12]!,matrix[1]!*mark.position[0]+matrix[5]!*mark.position[1]+matrix[9]!*mark.position[2]+matrix[13]!,matrix[2]!*mark.position[0]+matrix[6]!*mark.position[1]+matrix[10]!*mark.position[2]+matrix[14]!];
      rows.push({key:`${receiver}:${mark.id}`,mark,matrix,distance:Math.hypot(center[0]!-camera[0]!,center[1]!-camera[1]!,center[2]!-camera[2]!)});
    };
    let authored=0;
    for(const n of doc?.nodes??[])for(const c of n.components)if(c.kind==='Decal'&&c.enabled){authored+=c.marks.length;for(const mark of c.marks)add(n.id,mark);}
    if(authored>MAX_AUTHORED_DECALS||runtime.count>MAX_RUNTIME_DECALS)throw new Error('贴花容量超限，不能静默丢弃');
    for(const e of runtime.marks)add(e.receiver,e.mark);
    rows.sort((a,b)=>a.mark.priority-b.mark.priority||b.distance-a.distance||a.key.localeCompare(b.key));
    for(let i=0;i<rows.length;i++)packDecalMark(this.data,i*DECAL_INSTANCE_FLOATS,rows[i]!.mark,rows[i]!.matrix);
    return this.data.subarray(0,rows.length*DECAL_INSTANCE_FLOATS);
  }
}
