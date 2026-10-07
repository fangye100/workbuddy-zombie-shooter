import { it,expect } from 'vitest';
import { screenMovement,groundAim } from '../src/services/game-controls';
import { gameText, setGameLanguage } from '../src/services/game-language';
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
