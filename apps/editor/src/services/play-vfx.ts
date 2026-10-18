import { VfxPass } from '@aether/render';
import type { RendererCore } from '@aether/render';
import type { PlaySession } from '@aether/zombie-game';
import { WeaponVfxPlanner } from '@aether/zombie-game/presentation/vfx-planner';
import {EnemyVfxPlanner} from '@aether/zombie-game/presentation/enemy-vfx-planner';
import type {SceneDocument,VfxBinding} from '@aether/scene';
import { CombatOverlay } from '@aether/zombie-game/presentation/combat-overlay';
import { readVfxAsset, readVfxTexture } from './vfx-assets';

/** Play owns every real VFX buffer/texture; generation protects asynchronous image completion. */
export class PlayVfx {
  readonly planner=new WeaponVfxPlanner();
  readonly enemy=new EnemyVfxPlanner(this.planner.pool);
  readonly diagnostics:string[]=[];
  private generation=0;
  private pass:VfxPass|null=null;
  lastReleased:unknown=null;
  constructor(private readonly core:RendererCore){}
  start(session:PlaySession,doc?:SceneDocument):void {
    this.stop();const generation=++this.generation;
    const component=doc?.nodes.flatMap(n=>n.components).find(c=>c.kind==='VfxBindings' && c.enabled);
    const bindings=component?.kind==='VfxBindings'?component.bindings:{};
    if(!session.runtime || !session.runtime.weapons.definitions.some(w=>w.presentation.vfx.resource) && !Object.keys(bindings).length)return;
    const pass=new VfxPass(this.core.device);this.pass=pass;this.core.vfx=pass;
    session.registerResource('vfx-gpu-buffers-and-textures',()=>{if(this.pass===pass)this.stop();else pass.destroy();});
    CombatOverlay.gpuWeaponReady=id=>this.planner.ready.has(id);
    CombatOverlay.gpuEnemyReady=id=>this.enemy.rendered.has(id);
    for(const [tag,binding] of Object.entries(bindings))void this.loadEnemy(tag,binding,pass,generation);
    for(const weapon of session.runtime.weapons.definitions){
      const ref=weapon.presentation.vfx.resource;if(!ref)continue;
      if(weapon.behavior!=='hitscan' && weapon.behavior!=='pellets' && weapon.behavior!=='piercing')continue;
      void (async()=>{
        try {
          const asset=await readVfxAsset(ref);
          for(const kind of ['muzzle','trail','impact'] as const)if(asset.effects[weapon.presentation.vfx[kind]]?.kind!==kind)throw new Error(`VFX 缺少 ${weapon.id}/${kind}`);
          const unique=new Map(Object.values(asset.effects).map(e=>[e.texture.guid,e.texture]));
          for(const [key,texture] of unique){const bitmap=await readVfxTexture(texture);try{if(generation!==this.generation)return;pass.addTexture(key,bitmap);}finally{bitmap.close();}}
          if(generation===this.generation)this.planner.ready.set(weapon.id,asset);
        }catch(error){if(generation===this.generation)this.diagnostics.push(String(error));}
      })();
    }
  }
  private async loadEnemy(tag:string,binding:VfxBinding,pass:VfxPass,generation:number){try{const asset=await readVfxAsset(binding.resource),effect=asset.effects[binding.effectKey];if(!effect)throw new Error(`VFX tag ${tag} 缺少 ${binding.effectKey}`);const bitmap=await readVfxTexture(effect.texture);try{if(generation!==this.generation)return;pass.addTexture(effect.texture.guid,bitmap);}finally{bitmap.close();}if(generation===this.generation)this.enemy.bindings.set(tag,effect);}catch(error){if(generation===this.generation)this.diagnostics.push(String(error));}}
  update(session:PlaySession):void {if(!session.runtime || !this.pass)return;this.planner.update(session.runtime);this.enemy.update(session.runtime,p=>this.pass!.drawable(p));this.pass.instances=this.planner.pool.active;}
  stop():void {
    this.generation++;this.pass?.destroy();if(this.pass)this.lastReleased={...this.pass.stats};
    if(this.core.vfx===this.pass)this.core.vfx=null;this.pass=null;this.enemy.clear();this.planner.clear();this.diagnostics.length=0;CombatOverlay.gpuWeaponReady=()=>false;CombatOverlay.gpuEnemyReady=()=>false;
  }
  snapshot(){return {ready:[...this.planner.ready.keys()],enemy:{ready:[...this.enemy.bindings.keys()],rendered:[...this.enemy.rendered],stats:{...this.enemy.stats},events:this.enemy.recentEvents.map(e=>({...e})),instances:this.planner.pool.active.filter(p=>p.key.startsWith('enemy:')).map(p=>({key:p.key,position:p.position,size:p.effect.size,age:p.age,lifetime:p.lifetime,normal:p.normal}))},pool:{...this.planner.pool.stats,active:this.planner.pool.active.length,kinds:this.planner.pool.active.map(p=>p.effect.kind)},events:this.planner.recentEvents.map(e=>({...e})),gpu:this.pass?{...this.pass.stats}:null,lastReleased:this.lastReleased,diagnostics:[...this.diagnostics]};}
}
