import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { deriveBvh, hash, publish } from './derive-clips.mjs';
import { sampleBvh, measureDerivedNominal } from './clip-conditioning.mjs';
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

const root = resolve(import.meta.dirname, '../..');
const recipe = JSON.parse(readFileSync(resolve(root, 'assets/animations/gameplay/ani-20261008.recipe.json'), 'utf8'));
const raw = id => readFileSync(resolve(root, `assets/animations/mixamo/${id}.bvh`), 'utf8');
const motionRows = text => text.slice(text.indexOf('Frame Time:')).trim().split(/\r?\n/).slice(1).map(line => line.split(/\s+/).map(Number));
const p = (motion, bone, frame) => Array.from(motion.worldPositions[bone].slice(frame * 3, frame * 3 + 3));
const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));

test('未配置调节的左右完整循环保持原发布字节', () => {
  const hashes = { game_walk_l: 'sha256:94c3ab2d4da6a1bdafb4ab415e535013946bf23158cb600cb6189bb3cd988dbc',
    game_walk_r: 'sha256:d31caea0b74ea534d6e870564ade6fd3d992c0df50890ca2719e0f85bfa64845' };
  for (const item of recipe.clips.filter(c => c.conditioning)) {
    const { conditioning, ...old } = item;
    assert.equal(hash(deriveBvh(raw(item.source), old)), hashes[item.id]);
  }
});

test('真实左右源收紧横向足距，保持最低足高、骨长、膝/脚通道和完整循环', () => {
  for (const item of recipe.clips.filter(c => c.conditioning)) {
    const { conditioning, ...old } = item, baseline = deriveBvh(raw(item.source), old), output = deriveBvh(raw(item.source), item);
    const before = sampleBvh(baseline, conditioning.sampling), after = sampleBvh(output, conditioning.sampling);
    const originalRows = motionRows(baseline), rows = motionRows(output);
    assert.deepEqual(Array.from(after.times), Array.from(before.times));
    assert.deepEqual(rows[0], rows.at(-1));
    const changedColumns = new Set(); // rootY / 两个 UpLeg Zrotation；其它通道必须逐值保留。
    const header = baseline.slice(0, baseline.indexOf('MOTION'));
    const joints = [...header.matchAll(/(?:ROOT|JOINT)\s+(\S+)[\s\S]*?CHANNELS\s+\d+\s+([^\n]+)/g)];
    let column = 0;
    for (const joint of joints) {
      const channels = joint[2].trim().split(/\s+/);
      if (joint[1] === 'Hips') changedColumns.add(column + channels.indexOf('Yposition'));
      if (['LeftUpLeg','RightUpLeg'].includes(joint[1])) changedColumns.add(column + channels.indexOf('Zrotation'));
      column += channels.length;
    }
    for (let f = 0; f < rows.length; f++) {
      for (let c = 0; c < rows[f].length; c++) if (!changedColumns.has(c)) assert.equal(rows[f][c], originalRows[f][c], `${item.id}/${f}/${c}`);
      const footMin = motion => Math.min(...['LeftFoot','RightFoot'].map(b => p(motion,b,f)[1]));
      assert.ok(Math.abs(footMin(after)-footMin(before)) < 1e-6);
      for (const side of ['Left','Right']) for (const [a,b] of [[`${side}UpLeg`,`${side}Leg`],[`${side}Leg`,`${side}Foot`]]) assert.ok(Math.abs(distance(p(after,a,f),p(after,b,f))-distance(p(before,a,f),p(before,b,f))) < 1e-7);
    }
    const peak = motion => Math.max(...Array.from({length:rows.length},(_,f)=>Math.abs(p(motion,'LeftFoot',f)[0]-p(motion,'RightFoot',f)[0])));
    assert.ok(peak(after) < peak(before)*.87);
    assert.ok(Object.values(after.worldPositions).every(values => values.every(Number.isFinite)));
    const measured = measureDerivedNominal(output, conditioning);
    assert.ok(measured.samples > 10 && measured.nominalSpeedMps > .5 && measured.nominalSpeedMps < 2.5);
    assert.equal(hash(output), JSON.parse(readFileSync(resolve(root, `assets/animations/gameplay/${item.id}.bvh.meta.json`), 'utf8')).sourceHash);
  }
});

test('非法通道、未知骨、重复项、单位/幅度/足高边界失败；没有足速样本不沿用旧值', () => {
  const item = recipe.clips.find(c => c.id === 'game_walk_l'), original = raw(item.source);
  const invalid = [
    c => { c.unknown = true; }, c => { c.rotationChannels[0].bone = 'Missing'; },
    c => { c.rotationChannels[0].channel = 'Xposition'; }, c => { c.rotationChannels[0].scale = -1; },
    c => { c.rotationChannels[0].scale = 1.1; }, c => { c.rotationChannels[0].scale = NaN; },
    c => { c.rotationChannels.push({...c.rotationChannels[0]}); }, c => { c.sampling.unitScale = 0; },
    c => { c.sampling.upAxis = 'x'; }, c => { c.preserveFootHeight.bones = ['Missing']; },
    c => { c.preserveFootHeight.maxCorrectionM = .001; }, c => { c.nominalSpeed.bones = ['Missing']; },
    c => { c.nominalSpeed.heightToleranceM = .2; },
  ];
  for (const change of invalid) { const conditioning = structuredClone(item.conditioning); change(conditioning); assert.throws(() => deriveBvh(original, {...item,conditioning})); }
  const conditioning = structuredClone(item.conditioning); conditioning.nominalSpeed.minSpeedMps = 100;
  assert.throws(() => measureDerivedNominal(deriveBvh(original, {...item,conditioning}), conditioning), /no low-foot samples/);
});

test('定向发布只更新指定片段与对应 nominal，保留 profile/其它派生并记录来源', () => {
  const temp = mkdtempSync(resolve(tmpdir(), 'aether-motion-derive-'));
  const write = (path, value) => { const full = resolve(temp,path); mkdirSync(resolve(full,'..'),{recursive:true}); writeFileSync(full,value); };
  const json = path => JSON.parse(readFileSync(resolve(temp,path),'utf8'));
  try {
    const item = recipe.clips.find(c=>c.id==='game_walk_l'), source = raw(item.source), recipePath = 'recipe.json';
    write(`assets/animations/mixamo/${item.source}.bvh`,source);
    write(`assets/animations/mixamo/${item.source}.bvh.meta.json`,JSON.stringify({guid:`as_motion_${item.source}`,sourceHash:hash(source),userData:{original:true}}));
    const recipeText=JSON.stringify({schemaVersion:1,clips:[item,{id:'game_walk_r',source:'ani_p_strafe_r'}],profiles:{player:{walk_l:item.id}}});
    write(recipePath,recipeText); write('assets/animations/gameplay/game_walk_r.bvh','KEEP');
    const library={id:'lib',clips:{[item.source]:{nominalSpeedMps:99},game_aim_ready:{},game_walk_r:{nominalSpeedMps:88}},profiles:{player:{ready:'game_aim_ready',walk_r:'game_walk_r'}}};
    write('assets/animations/mixamo/shared.motion.json',JSON.stringify(library)); write('assets/animations/mixamo/shared.motion.json.meta.json',JSON.stringify({sourceHash:'old'}));
    assert.throws(()=>publish(temp,recipePath,{clipIds:['Missing']}));
    publish(temp,recipePath,{clipIds:[item.id]});
    const updated=json('assets/animations/mixamo/shared.motion.json'),meta=json(`assets/animations/gameplay/${item.id}.bvh.meta.json`);
    assert.deepEqual(updated.profiles,library.profiles); assert.deepEqual(updated.clips.game_walk_r,library.clips.game_walk_r);
    assert.equal(readFileSync(resolve(temp,'assets/animations/gameplay/game_walk_r.bvh'),'utf8'),'KEEP');
    assert.equal(meta.userData.derivedRecipeHash,hash(recipeText)); assert.equal(meta.userData.derivedSourceHash,hash(source));
    assert.equal(updated.clips[item.id].nominalSpeedMps,meta.userData.nominalSpeedMeasure.nominalSpeedMps);
    assert.ok(updated.clips[item.id].nominalSpeedMps<3);
    const {conditioning,...plain}=item;write(recipePath,JSON.stringify({schemaVersion:1,clips:[plain],profiles:{}}));
    publish(temp,recipePath,{clipIds:[item.id]});
    const restored=json(`assets/animations/gameplay/${item.id}.bvh.meta.json`);
    assert.equal(restored.userData.conditioning,undefined);assert.equal(restored.userData.nominalSpeedMeasure,undefined);assert.equal(restored.userData.derivedRecipeHash,undefined);
    assert.equal(restored.userData.original,true);
  } finally { rmSync(temp,{recursive:true,force:true}); }
});
