import {test} from 'node:test';import assert from 'node:assert/strict';import {elbowEvidence} from './weapon-elbows.mjs';
const binding={controls:[{part:'leftHand',pole:[1,-.35,0]},{part:'rightHand',pole:[-1,-.35,0]}]};
const chain=(side,sign)=>[{name:side+'Arm',position:[sign*.2,1.4,0]},{name:side+'ForeArm',position:[sign*.4,1.2,.2]},{name:side+'Hand',position:[sign*.2,1.4,.4]}];
test('镜像肘在链轴正交方向朝向侧向pole；翻入/缺骨明确失败',()=>{
 const good=[...chain('Left',1),...chain('Right',-1)];assert.equal(elbowEvidence(good,binding).ok,true);good[1].position[0]=0;assert.equal(elbowEvidence(good,binding).ok,false);assert.equal(elbowEvidence([],binding).ok,false);
});
test('近伸直链不强求肘跨越肩X；可达握点也不能掩盖肘弯向内',()=>{
 const straight=[...chain('Left',1),...chain('Right',-1)];straight[1].position=[.2,1.4,.2];straight[4].position=[-.2,1.4,.2];assert.equal(elbowEvidence(straight,binding).ok,true);assert.ok(elbowEvidence(straight,binding).chains.every(c=>c.straight));
});
