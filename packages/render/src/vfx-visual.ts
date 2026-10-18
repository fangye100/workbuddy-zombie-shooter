import type {VfxInstance} from '@aether/runtime';
import {sampleVfxCurve} from '@aether/runtime';
const linear=(n:number)=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4;
const rgb=(hex:string)=>[1,3,5].map(k=>linear(parseInt(hex.slice(k,k+2),16)/255));
/** Pure curve sampling in linear color; normalized age is independent from flipbook cycling. */
export function sampleVfxVisual(p:VfxInstance){
 const e=p.effect,t=Math.min(1,Math.max(0,p.age/(p.lifetime??e.duration)));let color=rgb(e.color);
 if(e.colorCurve){for(let i=1;i<e.colorCurve.length;i++){const a=e.colorCurve[i-1]!,b=e.colorCurve[i]!;if(t<=b.t){const f=(t-a.t)/(b.t-a.t),c=rgb(a.color),d=rgb(b.color);color=c.map((v,k)=>(v+(d[k]!-v)*f)*color[k]!);break;}}}
 return {position:p.position.map((v,i)=>v+(p.velocity?.[i]??0)*p.age),size:sampleVfxCurve(e.sizeCurve,t),color,alpha:sampleVfxCurve(e.alphaCurve,t)};
}
