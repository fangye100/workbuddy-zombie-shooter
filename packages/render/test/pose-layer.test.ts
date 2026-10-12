import { describe, expect, it } from 'vitest';
import { mat4 } from '@aether/core';
import { createPoseLayerState, createSkinState, selectClip, selectPoseLayer, sampleAnimationPose, advancePoseTransition,
  advancePoseLayerTransition, evalJointMatrices } from '@aether/render';
import type { AnimClip, SkeletonData } from '@aether/scene';
function fixture() {
  const sk: SkeletonData = { joints:[0,1,2,3],jointNames:['mixamorig:Hips','mixamorig:Spine','mixamorig:LeftUpLeg','mixamorig:RightArm'],
    parent:[-1,0,0,1],roots:[0],normalization:mat4(),inverseBind:new Float32Array(64),
    locals:Array.from({length:4},()=>({t:[0,0,0],r:[0,0,0,1],s:[1,1,1]})) };
  for(let i=0;i<4;i++)sk.inverseBind.set(mat4(),i*16);
  const clip=(name:string,x:number):AnimClip=>({name,duration:2,tracks:[0,1,2,3].map(node=>({node,path:'rotation',stride:4,interpolation:'LINEAR',
    times:new Float32Array([0,2]),values:new Float32Array([0,0,0,1,0,0,Math.sin(x*(node+1)/2),Math.cos(x*(node+1)/2)])}))});
  const s=createSkinState(sk,[clip('walk',.3),clip('shoot',1),clip('reload',-.6)]);
  s.poseLayer=createPoseLayerState(sk,{roots:['Spine'],exclude:[],weight:1,transitionSec:.2});
  return s;
}
describe('generic skeletal region composition',()=>{
  it('preserves hips and leg matrices while the upper layer samples its own time',()=>{
    const s=fixture();s.time=.6;const base=sampleAnimationPose(s);const before=new Float32Array(80);evalJointMatrices(s,before);
    selectPoseLayer(s,1);advancePoseLayerTransition(s,.2);s.poseLayer!.time=1.4;
    const pose=sampleAnimationPose(s),after=new Float32Array(80);evalJointMatrices(s,after);
    expect(pose[0]).toEqual(base[0]);expect(pose[2]).toEqual(base[2]);expect(pose[1]).not.toEqual(base[1]);expect(s.time).toBe(.6);
    expect(after.slice(0,16)).toEqual(before.slice(0,16));expect(after.slice(32,48)).toEqual(before.slice(32,48));
    s.time=.8;expect(sampleAnimationPose(s)[2]).not.toEqual(base[2]);expect(s.poseLayer!.time).toBe(1.4);
  });
  it('blends weights and missing tracks, leaves no accumulated pose, and zero weight retains base',()=>{
    const s=fixture();s.time=.7;const base=sampleAnimationPose(s);s.clips[1]!.tracks=s.clips[1]!.tracks.filter(t=>t.node===1);
    selectPoseLayer(s,1);advancePoseLayerTransition(s,.2);s.poseLayer!.time=1;s.poseLayer!.binding.weight=.5;
    const pose=sampleAnimationPose(s);expect(pose[1]).not.toEqual(base[1]);expect(pose[3]).toEqual(base[3]);expect(Math.hypot(...pose[1]!.r)).toBeCloseTo(1);
    expect(sampleAnimationPose(s)).toEqual(pose);const a=new Float32Array(80),b=new Float32Array(80);evalJointMatrices(s,a);evalJointMatrices(s,b);expect(b).toEqual(a);
    s.poseLayer!.binding.weight=0;expect(sampleAnimationPose(s)).toEqual(base);
  });
  it('enters, interrupts and exits continuously without injecting upper pose into base transitions',()=>{
    const s=fixture();s.time=.6;const before=sampleAnimationPose(s);selectPoseLayer(s,1);expect(sampleAnimationPose(s)).toEqual(before);
    s.poseLayer!.time=.8;advancePoseLayerTransition(s,.1);const middle=sampleAnimationPose(s);
    selectPoseLayer(s,2);expect(sampleAnimationPose(s)).toEqual(middle);advancePoseLayerTransition(s,.2);s.poseLayer!.time=1;
    const upper=sampleAnimationPose(s);selectPoseLayer(s,-1);expect(sampleAnimationPose(s)).toEqual(upper);
    advancePoseLayerTransition(s,.2);const base=sampleAnimationPose(s);selectClip(s,2,.2);
    expect(s.transition!.from).toEqual(base);advancePoseTransition(s,.2);
    expect(sampleAnimationPose(s)).not.toEqual(upper);
  });
  it('supports other regions and exclusions while failing explicitly on missing or ambiguous bone names',()=>{
    const s=fixture();expect(createPoseLayerState(s.skeleton,{roots:['Hips'],exclude:['Spine'],weight:1,transitionSec:0}).nodes).toEqual([0,2]);
    for(const roots of [['Absent'],['Spine']]) {
      if(roots[0]==='Spine')s.skeleton.jointNames[3]='Spine';
      s.poseLayer=createPoseLayerState(s.skeleton,{roots,exclude:[],weight:1,transitionSec:0});
      expect(s.poseLayer.nodes).toEqual([]);expect(s.poseLayer.diagnostics.join(' ')).toContain('LAYER_BONES');
      const base=sampleAnimationPose(s);selectPoseLayer(s,1);s.poseLayer.time=1;expect(sampleAnimationPose(s)).toEqual(base);
    }
  });
});
