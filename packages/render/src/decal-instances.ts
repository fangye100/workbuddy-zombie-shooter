import {ObjectPool,composeQuat,multiply,srgbToLinear,type Mat4} from '@aether/core';
import {validateDecalMark,DECAL_PATTERNS,DEFAULT_DECAL_STYLE,MAX_AUTHORED_DECALS,type DecalMark,type SceneDocument,type NodeId} from '@aether/scene';

export const MAX_RUNTIME_DECALS=512;
export const DECAL_INSTANCE_FLOATS=20;
export interface RuntimeDecal {receiver:NodeId;mark:DecalMark;ttlSec:number;fadeSec:number}
export interface DecalFrameRow {readonly receiver:NodeId;readonly mark:DecalMark;readonly remainingSec:number;readonly opacityScale?:number}
/** 只供同步渲染借用，下一次 advance/emit/clear 后失效；MCP 使用复制隔离的 snapshot。 */
export interface DecalFrameView {readonly count:number;readonly marks:readonly DecalFrameRow[]}
interface Entry extends RuntimeDecal {born:number;key:string;group:string|null;remainingSec:number;opacityScale:number;hasStyle:boolean;everAcquired:boolean}
/** 固定槽位对象池。group 是宿主的不透明标签，不解释任何游戏规则。 */
export class DecalPool {
  private readonly pool:ObjectPool<Entry>;
  private readonly entries=new Map<string,Entry>();
  private readonly groups=new Map<string,number>();
  private readonly rows:Entry[]=[];
  private readonly view:DecalFrameView={count:0,marks:this.rows};
  private now=0;evicted=0;private emitted=0;private reused=0;
  constructor(readonly capacity=MAX_RUNTIME_DECALS){
    if(!Number.isInteger(capacity)||capacity<1||capacity>MAX_RUNTIME_DECALS)throw new RangeError('贴花池容量非法');
    this.pool=new ObjectPool<Entry>({capacity,maxRetained:capacity,create:()=>({
      receiver:'',key:'',group:null,born:0,ttlSec:0,fadeSec:0,remainingSec:0,opacityScale:1,hasStyle:false,everAcquired:false,
      mark:{id:'',pattern:'splatter',position:[0,0,0],rotation:[0,0,0,1],size:[1,1],color:'#000000',opacity:1,seed:0,normalOffset:.001,priority:0,style:{...DEFAULT_DECAL_STYLE}},
    })});
    this.pool.prewarm(capacity);
  }
  get time():number{return this.now;}
  emit(input:RuntimeDecal,elapsedSec=0,group:string|null=null):void {
    const errors=validateDecalMark(input.mark);
    if(typeof input.receiver!=='string'||!input.receiver||!Number.isFinite(input.ttlSec)||input.ttlSec<=0||input.ttlSec>120
      ||!Number.isFinite(input.fadeSec)||input.fadeSec<0||input.fadeSec>input.ttlSec||!Number.isFinite(elapsedSec)||elapsedSec<0||elapsedSec>=input.ttlSec||errors.length
      ||(group!==null&&(typeof group!=='string'||!group)))throw new Error(`运行贴花参数非法：${errors.join('；')}`);
    const key=`${input.receiver}:${input.mark.id}`;
    if(this.entries.has(key))throw new Error(`运行贴花 id 已存在：${key}`);
    if(this.entries.size===this.capacity){this.release(this.entries.values().next().value!);this.evicted++;}
    const e=this.pool.acquire(),m=e.mark,src=input.mark;
    if(e.everAcquired)this.reused++;e.everAcquired=true;this.emitted++;
    e.receiver=input.receiver;e.key=key;e.group=group;e.ttlSec=input.ttlSec;e.fadeSec=input.fadeSec;e.born=this.now-elapsedSec;
    m.id=src.id;m.pattern=src.pattern;m.color=src.color;m.opacity=src.opacity;m.seed=src.seed;m.normalOffset=src.normalOffset;m.priority=src.priority;
    for(let j=0;j<3;j++)m.position[j]=src.position[j]!;
    for(let j=0;j<4;j++)m.rotation[j]=src.rotation[j]!;
    m.size[0]=src.size[0];m.size[1]=src.size[1];e.hasStyle=src.style!==undefined;
    const style=src.style??DEFAULT_DECAL_STYLE,target=m.style!;
    target.coverage=style.coverage;target.edgeWidth=style.edgeWidth;target.irregularity=style.irregularity;target.detail=style.detail;
    this.entries.set(key,e);if(group!==null)this.groups.set(group,(this.groups.get(group)??0)+1);
  }
  private release(e:Entry):void {
    this.entries.delete(e.key);
    if(e.group!==null){const count=this.groups.get(e.group)!-1;if(count)this.groups.set(e.group,count);else this.groups.delete(e.group);}
    e.group=null;this.pool.release(e);
  }
  advance(now:number):void {
    if(!Number.isFinite(now)||now<this.now)throw new RangeError('贴花模拟时间不得倒退');this.now=now;
    for(const e of this.entries.values())if(now>=e.born+e.ttlSec)this.release(e);
  }
  groupCount(group:string):number{return this.groups.get(group)??0;}
  removeOldest(group:string):boolean {for(const e of this.entries.values())if(e.group===group){this.release(e);return true;}return false;}
  remove(receiver:NodeId,id:string):boolean {const e=this.entries.get(`${receiver}:${id}`);if(e===undefined)return false;this.release(e);return true;}
  frame():DecalFrameView {
    this.rows.length=0;
    for(const e of this.entries.values()){
      e.remainingSec=e.born+e.ttlSec-this.now;e.opacityScale=e.fadeSec>0?Math.min(1,e.remainingSec/e.fadeSec):1;this.rows.push(e);
    }
    (this.view as {count:number}).count=this.rows.length;return this.view;
  }
  snapshot(){const frame=this.frame();return {time:this.now,count:frame.count,capacity:this.capacity,evicted:this.evicted,marks:frame.marks.map(e=>{
    const entry=e as Entry,mark=structuredClone(e.mark);if(!entry.hasStyle)delete mark.style;mark.opacity*=entry.opacityScale;
    return {receiver:e.receiver,mark,remainingSec:e.remainingSec};
  })};}
  diagnostics(){return {allocatedSlots:this.capacity,emitted:this.emitted,reusedSlots:this.reused,active:this.entries.size,free:this.pool.getStats().inactive};}
  clear():void {for(const e of this.entries.values())this.release(e);this.groups.clear();this.rows.length=0;(this.view as {count:number}).count=0;this.now=0;this.evicted=0;}
}
export type DecalReceiver=(id:NodeId)=>Mat4|null;
export class DecalPackScratch {readonly local=new Float32Array(16);readonly world=new Float32Array(16);}
/** +Y 局部 XZ 平面；调用者提供 scratch 时不为每项分配矩阵、颜色或打包数组。 */
export function packDecalMark(out:Float32Array,offset:number,mark:DecalMark,receiver:Mat4,scratch=new DecalPackScratch(),opacityScale=1):void {
  const {local,world}=scratch;composeQuat(local,...mark.position,mark.rotation,1);multiply(world,receiver,local);
  const ux=world[0]!,uy=world[1]!,uz=world[2]!,vx=world[8]!,vy=world[9]!,vz=world[10]!;
  const nx=vy*uz-vz*uy,ny=vz*ux-vx*uz,nz=vx*uy-vy*ux,n=Math.hypot(nx,ny,nz);
  if(n<1e-8)throw new Error('贴花接收变换退化');
  const color=parseInt(mark.color.slice(1),16),style=mark.style??DEFAULT_DECAL_STYLE;
  out[offset]=world[12]!+nx/n*mark.normalOffset;out[offset+1]=world[13]!+ny/n*mark.normalOffset;out[offset+2]=world[14]!+nz/n*mark.normalOffset;out[offset+3]=DECAL_PATTERNS.indexOf(mark.pattern);
  out[offset+4]=ux*mark.size[0]/2;out[offset+5]=uy*mark.size[0]/2;out[offset+6]=uz*mark.size[0]/2;out[offset+7]=mark.seed;
  out[offset+8]=vx*mark.size[1]/2;out[offset+9]=vy*mark.size[1]/2;out[offset+10]=vz*mark.size[1]/2;out[offset+11]=0;
  out[offset+12]=srgbToLinear(((color>>16)&255)/255);out[offset+13]=srgbToLinear(((color>>8)&255)/255);out[offset+14]=srgbToLinear((color&255)/255);out[offset+15]=mark.opacity*opacityScale;
  out[offset+16]=style.coverage;out[offset+17]=style.edgeWidth;out[offset+18]=style.irregularity;out[offset+19]=style.detail;
}
interface SortRow {key:string;id:string;receiver:string;mark:DecalMark;matrix:Mat4;distance:number;opacityScale:number}
export class DecalFrameBuilder {
  private readonly data=new Float32Array((MAX_AUTHORED_DECALS+MAX_RUNTIME_DECALS)*DECAL_INSTANCE_FLOATS);
  private readonly scratch=new DecalPackScratch();
  private readonly slots:SortRow[]=Array.from({length:MAX_AUTHORED_DECALS+MAX_RUNTIME_DECALS},()=>({key:'',id:'',receiver:'',mark:null!,matrix:null!,distance:0,opacityScale:1}));
  private readonly rows:SortRow[]=[];
  private readonly views=new Map<number,Float32Array<ArrayBuffer>>();
  private readonly compare=(a:SortRow,b:SortRow)=>a.mark.priority-b.mark.priority||b.distance-a.distance||a.key.localeCompare(b.key);
  private add(receiver:NodeId,mark:DecalMark,resolve:DecalReceiver,camera:readonly number[],opacityScale=1):void {
    const matrix=resolve(receiver);if(!matrix||mark.opacity*opacityScale<=0)return;
    const row=this.slots[this.rows.length];if(!row)throw new Error('贴花容量超限，不能静默丢弃');
    const x=matrix[0]!*mark.position[0]+matrix[4]!*mark.position[1]+matrix[8]!*mark.position[2]+matrix[12]!-camera[0]!;
    const y=matrix[1]!*mark.position[0]+matrix[5]!*mark.position[1]+matrix[9]!*mark.position[2]+matrix[13]!-camera[1]!;
    const z=matrix[2]!*mark.position[0]+matrix[6]!*mark.position[1]+matrix[10]!*mark.position[2]+matrix[14]!-camera[2]!;
    if(row.receiver!==receiver||row.id!==mark.id)row.key=`${receiver}:${mark.id}`;row.receiver=receiver;row.id=mark.id;row.mark=mark;row.matrix=matrix;row.distance=Math.hypot(x,y,z);row.opacityScale=opacityScale;this.rows.push(row);
  }
  build(doc:SceneDocument|null,resolve:DecalReceiver,runtime:DecalFrameView,camera:readonly number[]):Float32Array<ArrayBuffer> {
    this.rows.length=0;let authored=0;
    for(const n of doc?.nodes??[])for(const c of n.components)if(c.kind==='Decal'&&c.enabled){authored+=c.marks.length;for(const mark of c.marks)this.add(n.id,mark,resolve,camera);}
    if(authored>MAX_AUTHORED_DECALS||runtime.count>MAX_RUNTIME_DECALS)throw new Error('贴花容量超限，不能静默丢弃');
    for(const e of runtime.marks)this.add(e.receiver,e.mark,resolve,camera,e.opacityScale??1);
    this.rows.sort(this.compare);
    for(let i=0;i<this.rows.length;i++){const row=this.rows[i]!;packDecalMark(this.data,i*DECAL_INSTANCE_FLOATS,row.mark,row.matrix,this.scratch,row.opacityScale);}
    let view=this.views.get(this.rows.length);if(!view){view=this.data.subarray(0,this.rows.length*DECAL_INSTANCE_FLOATS);this.views.set(this.rows.length,view);}return view;
  }
}
