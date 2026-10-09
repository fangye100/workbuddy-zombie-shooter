import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveBvh } from './derive-clips.mjs';
const source = 'HIERARCHY\nROOT Hips\n{\n OFFSET 0 1 0\n CHANNELS 6 Xposition Yposition Zposition Xrotation Yrotation Zrotation\n}\nMOTION\nFrames: 7\nFrame Time: 0.03333333333333333\n' + Array.from({length:7},(_,i)=>`${i} ${1+i/10} ${i*2} ${170+i*4} 0 0`).join('\n')+'\n';
test('裁剪保留 Y 起伏、去 XZ 位移，输出帧数与帧率保持明确',()=>{
 const out=deriveBvh(source,{startFrame:1,endFrame:5});
 assert.match(out,/Frames: 5/); assert.match(out,/1.000000 1.500000 2.000000 190.000000/);
});
test('循环接缝按四元数最短路径混合，末帧等价首帧',()=>{
 const out=deriveBvh(source,{startFrame:0,endFrame:6,seamFrames:2});
 const rows=out.trim().split('\n').slice(-7).map(s=>s.split(' ').map(Number));
 assert.ok(Math.abs(Math.abs(rows[5][3])-180)<1e-5);
 assert.deepEqual(rows[6],rows[0]);
});
test('越界、空段、过长接缝和非有限行显式失败',()=>{
 for(const recipe of [{startFrame:-1,endFrame:5},{startFrame:0,endFrame:7},{startFrame:2,endFrame:2},{startFrame:0,endFrame:6,seamFrames:3}]) assert.throws(()=>deriveBvh(source,recipe));
 assert.throws(()=>deriveBvh(source.replace('170 0 0','NaN 0 0'),{startFrame:0,endFrame:6}));
});
