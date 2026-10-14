import { it,expect,vi,afterEach } from 'vitest';
import { PlaySession } from '../../src/play-session';
import { motionDirection } from '@aether/runtime';
import type { SceneDocument } from '@aether/scene';
import { screenMovement,groundAim,GameControls } from "../../src/presentation/game-controls";
import { gameText, setGameLanguage } from "../../src/presentation/game-language";
class Surface {
  hidden=false;disabled=false;textContent='';className='';onclick:(()=>void)|null=null;
  style={setProperty:()=>{}};classList={toggle:()=>{}};
  listeners=new Map<string,((e:any)=>void)[]>();
  append(..._:unknown[]){}addEventListener(name:string,fn:(e:any)=>void){this.listeners.set(name,[...(this.listeners.get(name)??[]),fn]);}
  emit(name:string,e:any){for(const fn of this.listeners.get(name)??[])fn(e);}
}
afterEach(()=>vi.unstubAllGlobals());
const TRIAL=import.meta.glob('../../../../assets/scenes/sandbox/weapon-assembly-trial.scene.json',{eager:true});
function controlsSession(touch=false){
  const canvas=new Surface(),win=new Surface(),doc=new Surface();
  Object.assign(doc,{createElement:()=>new Surface(),getElementById:()=>new Surface()});
  vi.stubGlobal('window',win);vi.stubGlobal('document',doc);vi.stubGlobal('HTMLElement',Surface);vi.stubGlobal('matchMedia',()=>({matches:touch}));
  const session=new PlaySession();expect(session.play(structuredClone((Object.values(TRIAL)[0] as {default:SceneDocument}).default)).ok).toBe(true);
  let cameraYaw=-Math.PI/2,point:[number,number]|null=null;
  const controls=new GameControls(canvas as never,()=>point?{o:[point[0],1.9,point[1]],d:[0,-1,0]}:null,()=>cameraYaw);
  const runtime=session.runtime!,step=(x:number,z=0)=>{controls.update(runtime,false,x,z);runtime.step();return runtime.player()!;};
  return {controls,session,runtime,step,canvas,win,setPoint:(v:[number,number]|null)=>{point=v;},setYaw:(v:number)=>{cameraYaw=v;}};
}
it('真实trial桌面无pointer的A/D沿相机左右移动且保持独立面向；touch move-only沿原移动朝向',()=>{
  const f=controlsSession();
  for(const x of [-1,1])for(let i=0;i<12;i++){
    const before=f.runtime.player()!,p=f.step(x);expect(Math.abs(p.yaw)).toBeLessThan(.02);expect(Math.abs(p.x-before.x)).toBeLessThan(1e-5);expect(Math.sign(p.z-before.z)).toBe(x);
    expect(motionDirection(p.x-before.x,p.z-before.z,p.yaw)).toBe(x<0?'l':'r');
  }
  f.controls.clear();expect(f.runtime.firing).toBe(false);
  const t=controlsSession(true),p=t.step(-1);expect(p.yaw).toBeCloseTo(-Math.PI/2);expect(t.controls.targetWorld(1)).toBeNull();
});
it('真实pointer更新方向，离开/无效ray/零长aim保留方向；Pause/观察清输入不重置会话朝向',()=>{
  const f=controlsSession();f.step(0);const p=f.runtime.player()!;
  f.setPoint([p.x+10,p.z+10]);f.canvas.emit('pointermove',{pointerType:'mouse',clientX:10,clientY:10});
  expect(f.step(0).yaw).toBeCloseTo(Math.PI/4);f.setPoint(null);expect(f.step(0).yaw).toBeCloseTo(Math.PI/4);
  f.setPoint([f.runtime.player()!.x,f.runtime.player()!.z]);expect(f.step(0).yaw).toBeCloseTo(Math.PI/4);
  f.controls.update(f.runtime,true,0,0);f.controls.clear();f.setYaw(0);
  expect(f.step(0).yaw).toBeCloseTo(Math.PI/4);f.win.emit('blur',{});expect(f.step(0).yaw).toBeCloseTo(Math.PI/4);
  f.controls.update(null,false,0,0);expect(f.controls.targetWorld(1)).toBeNull();
  // 新 runtime 身份才重新取当前相机前方，不延用上次鼠标方向。
  f.session.stop();expect(f.session.play(structuredClone((Object.values(TRIAL)[0] as {default:SceneDocument}).default)).ok).toBe(true);
  f.controls.update(f.session.runtime!,false,0,0);f.session.runtime!.step();expect(f.session.runtime!.player()!.yaw).toBeCloseTo(-Math.PI/2);
});
it('screen-relative movement and elevated aim ray use the real camera conventions',()=>{
  expect(screenMovement(1,0,0)).toEqual([1,0]);
  const up=screenMovement(0,-1,Math.PI/2);expect(up[0]).toBeCloseTo(-1);expect(up[1]).toBeCloseTo(0);
  expect(groundAim({o:[0,10,0],d:[1,-1,0]},1)).toEqual([9,0]);
  expect(groundAim({o:[0,1,0],d:[1,0,0]},1)).toBeNull();
  expect(groundAim({o:[0,1,0],d:[0,1,0]},0)).toBeNull();
});
it('game translation switches without changing runtime content and covers built-in upgrades and HUD',()=>{
  setGameLanguage('en');
  expect(gameText('第二层 · 尸潮 · 第 2 波 · 消灭敌人')).toBe('Floor 2 · Swarm · Wave  2  · Eliminate enemies');
  expect(gameText('重型弹头 · 流派成型！')).toBe('Heavy rounds · Build complete!');
  expect(gameText('命中恢复实际伤害的 8% 生命。')).not.toMatch(/[\u4e00-\u9fff]/);
  expect(gameText('废料 12 · 尸髓 5 · 击杀 4')).toBe('Scrap 12 · Essence 5 · Kills 4');
  setGameLanguage('zh');expect(gameText('再来一局')).toBe('再来一局');
});
it('近景pointer的torso/head只升高同帧gameAim，不重新相交到玩家背后',()=>{
  const ray={o:[.8197,1.6832,1.0515],d:[.33235,-.3945,-.85669]};
  const aim=groundAim(ray,.9)!;
  // Actual audit player Z=-.618: game aim is forward, head-plane ray is behind.
  expect(aim[1]).toBeLessThan(-.618);expect(groundAim(ray,1.5)![1]).toBeGreaterThan(-.618);
  const controls=Object.create(GameControls.prototype) as GameControls;
  Object.assign(controls,{aimWorld:aim,mouse:[570,644],ray:()=>{throw new Error('不能另采ray');}});
  expect(controls.targetWorld(1.3)).toEqual([aim[0],1.3,aim[1]]);
  expect(controls.targetWorld(1.5)).toEqual([aim[0],1.5,aim[1]]);
  Object.assign(controls,{aimWorld:null});expect(controls.targetWorld(1.3)).toBeNull();
});
