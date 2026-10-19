import type {SceneGraph,VfxEmitterComponent} from '@aether/scene';
/** One scene transform convention for authored Play and selected-node resource previews. */
export function vfxAuthorAnchor(graph:SceneGraph,nodeId:string,component:VfxEmitterComponent){
 const m=graph.worldMatrix(nodeId),d=component.direction;
 return {matrix:new Float32Array(m),position:[...graph.getNode(nodeId)!.world.position] as [number,number,number],direction:[m[0]!*d[0]+m[4]!*d[1]+m[8]!*d[2],m[1]!*d[0]+m[5]!*d[1]+m[9]!*d[2],m[2]!*d[0]+m[6]!*d[1]+m[10]!*d[2]] as [number,number,number],normal:[m[4]!,m[5]!,m[6]!] as [number,number,number]};
}
