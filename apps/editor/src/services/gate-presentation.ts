import type { SceneObject } from '../renderer';
import type { RuntimeSession } from '@aether/zombie-game';

/** 只消费权威运行姿态，不解释门逻辑；作者状态恢复由 PlayController 的快照负责。 */
export function syncGatePresentation(runtime:RuntimeSession|null,objectForNode:(id:string)=>SceneObject|null):void {
  for(const gate of runtime?.gateSnapshot()??[]){
    const object=objectForNode(gate.nodeId);if(object&&!object.removed)object.pos=[...gate.position];
  }
}
