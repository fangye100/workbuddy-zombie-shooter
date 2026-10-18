import { VfxPass } from '@aether/render';
import type { RendererCore } from '@aether/render';
import type { PlaySession } from '@aether/zombie-game';
import { WeaponVfxPlanner } from '@aether/zombie-game/presentation/vfx-planner';
import { CombatOverlay } from '@aether/zombie-game/presentation/combat-overlay';
import { readVfxAsset, readVfxTexture } from './vfx-assets';

/** Play owns every real VFX buffer/texture; generation protects asynchronous image completion. */
export class PlayVfx {
  readonly planner=new WeaponVfxPlanner();
  readonly diagnostics:string[]=[];
  private generation=0;
  private pass:VfxPass|null=null;
  lastReleased:unknown=null;
  constructor(private readonly core:RendererCore){}
  start(session:PlaySession):void {
    this.stop();const generation=++this.generation;
    if(!session.runtime || !session.runtime.weapons.definitions.some(w=>w.presentation.vfx.resource))return;
    const pass=new VfxPass(this.core.device);this.pass=pass;this.core.vfx=pass;
    session.registerResource('vfx-gpu-buffers-and-textures',()=>{if(this.pass===pass)this.stop();else pass.destroy();});
    CombatOverlay.gpuWeaponReady=id=>this.planner.ready.has(id);
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
  update(session:PlaySession):void {if(!session.runtime || !this.pass)return;this.planner.update(session.runtime);this.pass.instances=this.planner.pool.active;}
  stop():void {
    this.generation++;this.pass?.destroy();if(this.pass)this.lastReleased={...this.pass.stats};
    if(this.core.vfx===this.pass)this.core.vfx=null;this.pass=null;this.planner.clear();this.diagnostics.length=0;CombatOverlay.gpuWeaponReady=()=>false;
  }
  snapshot(){return {ready:[...this.planner.ready.keys()],pool:{...this.planner.pool.stats,active:this.planner.pool.active.length,kinds:this.planner.pool.active.map(p=>p.effect.kind)},gpu:this.pass?{...this.pass.stats}:null,lastReleased:this.lastReleased,diagnostics:[...this.diagnostics]};}
}
