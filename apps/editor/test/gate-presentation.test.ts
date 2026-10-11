import {it,expect} from 'vitest';
import {syncGatePresentation} from '../src/services/gate-presentation';
import type {RuntimeSession} from '@aether/zombie-game';
import type {SceneObject} from '../src/renderer';
it('门表现使用权威世界位置和稳定 NodeId，不影响其他物体或作者姿态对象',()=>{
  const position:[number,number,number]=[4,6,0],object={pos:[4,3,0],removed:false} as SceneObject;
  const runtime={gateSnapshot:()=>[{nodeId:'gate',position}]} as unknown as RuntimeSession;
  syncGatePresentation(runtime,id=>id==='gate'?object:null);expect(object.pos).toEqual([4,6,0]);object.pos[1]=10;expect(position[1]).toBe(6);
  syncGatePresentation(null,()=>{throw Error('停止状态不能再投影');});
});
