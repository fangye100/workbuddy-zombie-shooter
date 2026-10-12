import { it,expect } from 'vitest';
import { screenMovement,groundAim,GameControls } from "../../src/presentation/game-controls";
import { gameText, setGameLanguage } from "../../src/presentation/game-language";
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
