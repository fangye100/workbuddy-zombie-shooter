import type {VfxGraphAsset,VfxGraphNode,VfxGraphEdge} from '../src/vfx-graph';
export function graphFixture():VfxGraphAsset {
 const entries:Array<[string,VfxGraphNode['type'],Record<string,unknown>]>=[
  ['texture','texture',{ref:{path:'assets/vfx/smoke.svg',guid:'as_texture'},frames:1}],['size','size',{value:[.4,.8]}],['color','color',{value:'#ffaa33'}],['duration','number',{value:.6}],['rate','number',{value:20}],['speed','number',{value:2}],['look','appearance',{}],['emit','emission',{maxParticles:32,spreadDeg:20}],['sprite','sprite',{backend:'cpu',blend:'alpha'}],['out','output',{key:'smoke'}],
 ];
 const links=[['texture','look','texture'],['size','look','size'],['color','look','color'],['duration','look','duration'],['rate','emit','rate'],['speed','emit','speed'],['look','sprite','appearance'],['emit','sprite','emission'],['sprite','out','effect']];
 return {version:8,id:'as_graph',name:'图测试',status:'accepted',graph:{version:2,nodes:entries.map(([id,type,params],i)=>({id,type,params,position:[(i%4)*230,Math.floor(i/4)*180]})),edges:links.map(([node,to,port],i)=>({id:'edge_'+i,from:{node:node!,port:'value'},to:{node:to!,port:port!}} as VfxGraphEdge))}};
}
