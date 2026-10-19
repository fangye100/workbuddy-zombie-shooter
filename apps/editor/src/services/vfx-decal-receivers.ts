import {composeQuat,mat4} from '@aether/core';
import {SceneGraph,type SceneDocument} from '@aether/scene';
import type {DecalReceiver} from '@aether/render';
import type {LabRenderer} from '../renderer';
/** Exposes existing rendered CPU geometry, never rebuilds or owns scene content. */
export function decalReceivers(renderer:LabRenderer,doc:SceneDocument):DecalReceiver[]{
 const graph=SceneGraph.fromDocument(doc),out:DecalReceiver[]=[];
 for(const n of doc.nodes){const c=n.components.find(c=>c.kind==='MeshRenderer');if(c?.kind!=='MeshRenderer')continue;const o=renderer.state.objects.find(o=>o.nodeId===n.id && !o.removed),world=graph.getNode(n.id)!.world;let unsupported='';
  if(!o || !o.visible || !c.enabled || !c.visible || !graph.isEffectivelyVisible(n.id))unsupported='接收几何未就绪/不可见';
  else if(c.source.type==='asset' && o.loadedAssetPath!==c.source.ref.path)unsupported='GLB接收资产尚未真实解码，禁止占位几何';
  else if(o.skeleton || o.animations.length || c.playBinding || o.bob!==0)unsupported='接收仅支持静态非蒙皮/非动画/非bob节点';
  else if(Math.max(...world.scale)-Math.min(...world.scale)>1e-6)unsupported='产品接收不支持非均匀世界缩放；视口仅统一缩放，请使用builtin尺寸参数';
  const matrix=mat4();if(o)composeQuat(matrix,...o.pos,o.quat,o.scale);else matrix.set(graph.worldMatrix(n.id));
  out.push({nodeId:n.id,layer:c.layer,matrix,vertices:o?.mesh.vertices??new Float32Array(),indices:o?.mesh.indices??new Uint32Array(),stride:15,ranges:o?.subMeshes.filter(s=>s.visible).map(s=>({start:s.indexStart,count:s.indexCount}))??[],...(unsupported?{unsupported}:{})});
 }
 return out;
}
