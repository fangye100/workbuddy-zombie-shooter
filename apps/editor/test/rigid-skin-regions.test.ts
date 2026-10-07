import { describe, expect, it } from 'vitest';
import { applyRigidRegions, skinSelectionHash, validateRigidRegions, type RigidSkinRegion } from '../src/services/binding/rigid-skin-regions';
import { BindingSession } from '../src/services/binding/binding-session';
import { rigToTPose } from '../src/services/binding/binding-export';
import { HUMANIK_ORDER } from '../src/services/binding/humanik-template';
const region:RigidSkinRegion={name:'held prop',bone:'LeftHand',start:[0,0,0],end:[0,1,0],radius:.05};
const vertices=new Float32Array(45); vertices[15]=.025; vertices[16]=.4; vertices[30]=.2;
const indices=new Uint32Array([0,1,2]);
describe('Authored rigid prop skin constraints',()=>{
 it('keeps feather boundaries normalized and guards exact selections against stale meshes',()=>{
  const skin={joints:new Uint16Array(12).fill(2),weights:new Float32Array([1,0,0,0,1,0,0,0,1,0,0,0])};
  const v=vertices.slice();v[15]=.075;
  const soft=applyRigidRegions(skin,v,15,[{...region,feather:.05}]);
  expect(soft.weights[4]).toBeCloseTo(.5);expect(soft.weights[5]).toBeCloseTo(.5);
  const exact={...region,vertices:[2],selectionHash:skinSelectionHash(vertices)};
  const out=applyRigidRegions(skin,vertices,15,[exact]);expect(out.joints[0]).toBe(2);expect(out.joints[8]).toBe(HUMANIK_ORDER.indexOf('LeftHand'));
  expect(()=>applyRigidRegions(skin,v,15,[exact])).toThrow('不匹配');
  const s=new BindingSession();s.setModel('mesh',vertices,indices);const before=s.editSig();
  expect(()=>s.applyOptions({rigidRegions:[{...exact,vertices:[3]}]})).toThrow();expect(s.editSig()).toBe(before);
  expect(()=>s.hydrate({...s.getEditorData(),rigidRegions:[{...exact,selectionHash:skinSelectionHash(v)}]})).toThrow('不匹配');expect(s.editSig()).toBe(before);
 });
 it('locks capsule interiors after smoothing, leaves exterior untouched and never mutates input',()=>{
  const skin={joints:new Uint16Array(12).fill(2),weights:new Float32Array([1,0,0,0,1,0,0,0,1,0,0,0])};
  const out=applyRigidRegions(skin,vertices,15,[region]);
  expect(out.joints[0]).toBe(HUMANIK_ORDER.indexOf('LeftHand'));expect(out.weights.slice(0,4)).toEqual(new Float32Array([1,0,0,0]));
  expect(out.joints[8]).toBe(2);expect(skin.joints[0]).toBe(2);
  expect(applyRigidRegions(skin,vertices,15,[region,{...region,bone:'RightHand'}]).joints[0]).toBe(HUMANIK_ORDER.indexOf('RightHand'));
 });
 it('rejects malformed, tip, prototype and nonfinite constraints before state changes',()=>{
  for(const bad of [null,{},[{...region,bone:'constructor'}],[{...region,bone:'LeftHandTip'}],[{...region,start:[NaN,0,0]}],[{...region,radius:-1}],[{...region,extra:2}]])expect(()=>validateRigidRegions(bad)).toThrow();
  const s=new BindingSession();s.setModel('mesh',vertices,indices);const before=s.getEditorData(),history=s.historyDepth();
  expect(()=>s.hydrate({...before,rigidRegions:[{...region,radius:0}]})).toThrow();expect(s.historyDepth()).toEqual(history);expect(s.getRigidRegions()).toEqual([]);
 });
 it('persists and undoes constraints; UI/session and direct export have identical final weights',()=>{
  const s=new BindingSession();s.setModel('mesh',vertices,indices);s.applyOptions({weightMode:'distance',smoothIters:6,rigidRegions:[region]});s.sealHistory();
  const skin=s.computeSkin()!;const out=rigToTPose({name:'mesh',vertices,indices,placed:s.positions,image:null,bindPose:'source',weightMode:'distance',smoothIters:6,rigidRegions:[region]});expect(out.skin).toEqual(skin.skin);
  const saved=s.getEditorData(),copy=new BindingSession();copy.setModel('copy',vertices,indices);copy.hydrate(saved);expect(copy.getRigidRegions()).toEqual([region]);
  saved.rigidRegions![0]!.radius=1;expect(s.getRigidRegions()[0]!.radius).toBe(.05);
  const sig=s.editSig();s.applyOptions({rigidRegions:[]});expect(s.editSig()).not.toBe(sig);s.undo();expect(s.getRigidRegions()).toEqual([region]);s.redo();expect(s.getRigidRegions()).toEqual([]);
  s.setModel('next',vertices,indices);expect(s.getRigidRegions()).toEqual([]);
 });
 it('applies the same constraints to asynchronous Worker results',async()=>{
  const s=new BindingSession();s.setModel('mesh',vertices,indices);s.applyOptions({weightMode:'volumetric',smoothWeights:false,rigidRegions:[region]});
  const skin={joints:new Uint16Array(12),weights:new Float32Array([1,0,0,0,1,0,0,0,1,0,0,0])};
  const result=await s.computeSkinAsync(async()=>({skin,volumetric:{algorithm:'adaptive-volume-diffusion-v1',cells:1,refinedCells:0,cellSize:1,components:1,unseededComponents:0,outsideBones:[],fallbackVertices:0,surfaceOnlyCells:0,maxResidual:0,maxIterations:0,converged:true,elapsedMs:1}}));
  expect(result!.skin.joints[0]).toBe(HUMANIK_ORDER.indexOf('LeftHand'));expect(result!.skin.weights[0]).toBe(1);expect(skin.joints[0]).toBe(0);
 });
});
