import type {ColorHex,Vec3,Quat} from './document';

// 只能追加，GPU 的图案索引必须保持既有五类的顺序。
export const DECAL_PATTERNS=['splatter','scorch','crack','hazard','bullet-hole','acid','oil','paper','rubble'] as const;
export const MAX_AUTHORED_DECALS=512;
export interface DecalStyle { coverage:number;edgeWidth:number;irregularity:number;detail:number }
export const DEFAULT_DECAL_STYLE:Readonly<DecalStyle>=Object.freeze({coverage:1,edgeWidth:.025,irregularity:.5,detail:.5});
export interface DecalMark {
  id:string; pattern:typeof DECAL_PATTERNS[number];
  /** 接收节点的局部空间；平面为局部 XZ，正法线为 +Y。 */
  position:Vec3;rotation:Quat;size:[number,number];
  color:ColorHex;opacity:number;seed:number;normalOffset:number;priority:number;
  /** 可选形态参数；旧数据不注入字段，缺省使用 DEFAULT_DECAL_STYLE。 */
  style?:DecalStyle;
}
/** 同一静态接收物的有界实例集合；不增加 mesh/材质/变换槽。 */
export interface DecalComponent {kind:'Decal';enabled:boolean;marks:DecalMark[]}
export function validateDecalMark(value:unknown):string[] {
  if(!value||typeof value!=='object'||Array.isArray(value))return ['贴花必须是对象'];
  const m=value as DecalMark,errors:string[]=[];
  const vec=(v:unknown,n:number)=>Array.isArray(v)&&v.length===n&&v.every(Number.isFinite);
  if(typeof m.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(m.id))errors.push('贴花 id 必须是稳定 ASCII 标识（1–80 字符）');
  if(!DECAL_PATTERNS.includes(m.pattern))errors.push('未知程序贴花 pattern');
  if(!vec(m.position,3)||!vec(m.rotation,4)||Math.abs(Math.hypot(...(m.rotation??[]))-1)>.001)errors.push('贴花局部位置/单位四元数非法');
  if(!vec(m.size,2)||!m.size.every(v=>v>=.01&&v<=100))errors.push('贴花尺寸必须在 0.01–100m');
  if(typeof m.color!=='string'||!/^#[0-9a-f]{6}$/i.test(m.color))errors.push('贴花颜色必须是 #RRGGBB');
  if(!Number.isFinite(m.opacity)||m.opacity<0||m.opacity>1)errors.push('贴花透明度必须在 0–1');
  if(!Number.isInteger(m.seed)||m.seed<0||m.seed>65535)errors.push('贴花 seed 必须在 0–65535');
  if(!Number.isFinite(m.normalOffset)||m.normalOffset<.001||m.normalOffset>.05)errors.push('贴花法线偏移必须在 0.001–0.05m');
  if(!Number.isInteger(m.priority)||Math.abs(m.priority)>100)errors.push('贴花绘制优先级必须在 -100–100');
  if(m.style!==undefined){
    const s=m.style;
    if(!s||typeof s!=='object'||Array.isArray(s)||Object.keys(s).some(k=>!['coverage','edgeWidth','irregularity','detail'].includes(k))
      ||!Number.isFinite(s.coverage)||s.coverage<.2||s.coverage>1
      ||!Number.isFinite(s.edgeWidth)||s.edgeWidth<0||s.edgeWidth>.1
      ||!Number.isFinite(s.irregularity)||s.irregularity<0||s.irregularity>1
      ||!Number.isFinite(s.detail)||s.detail<0||s.detail>1)errors.push('贴花形态参数非法：coverage 0.2–1，edgeWidth 0–0.1，irregularity/detail 0–1');
  }
  return errors;
}
