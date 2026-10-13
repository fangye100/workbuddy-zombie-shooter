import {DecalPool,type RuntimeDecal} from '@aether/render';
import {CombatDecalPlanner} from '@aether/zombie-game/presentation/combat-decals';
import {combatDecalProjector} from './decal-surfaces';
import type {RuntimeSession} from '@aether/zombie-game';
import type {LabRenderer} from '../renderer';

/** 编辑器宿主适配：注入权威模拟时间、稳定接收节点及 Play 资源账本。 */
export class RuntimeDecals {
  private pool=new DecalPool();private runId:number|null=null;
  private planner=new CombatDecalPlanner(null);
  private readonly project:ReturnType<typeof combatDecalProjector>;
  constructor(private readonly renderer:LabRenderer){this.project=combatDecalProjector(renderer);}
  start(runtime:RuntimeSession|null):void {this.pool.clear();this.pool=new DecalPool(runtime?.desc.decalEmitter?.capacity??512);this.planner=new CombatDecalPlanner(runtime?.desc.decalEmitter??null);this.runId=runtime?.runId??null;this.sync(runtime);}
  sync(runtime:RuntimeSession|null):void {
    if(!runtime)return;
    if(this.runId!==runtime.runId){this.start(runtime);return;}
    const now=runtime.tick*runtime.fixedStep;this.pool.advance(now);
    this.planner.consume(runtime.decalEvents,runtime.runId,now,runtime.fixedStep,this.pool,this.project);
    this.renderer.setRuntimeDecals(this.pool.snapshot());
  }
  command(action:'emit'|'clear',runId:number,input?:RuntimeDecal):void {
    if(runId!==this.runId)throw new Error('运行代次已变更，请重新读取 editor_runtime');
    if(action==='clear'){const now=this.pool.snapshot().time;this.pool.clear();this.pool.advance(now);this.planner.clear();}
    else {
      if(!input)throw new Error('缺少运行贴花');
      if(input.mark.id.startsWith('combat_'))throw new Error('combat_ 是自动战斗痕迹的保留标识前缀');
      const node=this.renderer.getDocument()?.nodes.find(n=>n.id===input.receiver),mesh=node?.components.find(c=>c.kind==='MeshRenderer'&&c.enabled);
      if(mesh?.kind!=='MeshRenderer'||mesh.playBinding||mesh.sharedMotion||mesh.bodyIk||node?.id===this.renderer.getDocument()?.playerStart)throw new Error('运行贴花需要有效静态接收节点');
      this.pool.emit(input);
    }
    this.renderer.setRuntimeDecals(this.pool.snapshot());
  }
  snapshot(){return {...this.pool.snapshot(),runId:this.runId,combat:this.planner.snapshot(),gpu:this.renderer.core.decalSnapshot()};}
  stop():void {this.planner=new CombatDecalPlanner(null);this.pool.clear();this.runId=null;this.renderer.setRuntimeDecals(this.pool.snapshot());this.renderer.core.clearDecalResources();}
}
