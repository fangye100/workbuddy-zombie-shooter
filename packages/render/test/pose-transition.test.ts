import { describe, expect, it } from 'vitest';
import { mat4 } from '@aether/core';
import { advance, advancePoseTransition, createSkinState, evalJointMatrices, sampleAnimationPose, selectClip,
  PalettePoseTransitions, type BakedPalette } from '@aether/render';
import type { AnimClip, SkeletonData } from '@aether/scene';

function fixture() {
  const sk: SkeletonData = { joints: [0], jointNames: ['Bone'], parent: [-1], roots: [0],
    locals: [{ t: [0,0,0], r: [0,0,0,1], s: [1,1,1] }], normalization: mat4(), inverseBind: mat4() };
  const clip = (name: string, x: number, angle: number, scale: number): AnimClip => ({ name, duration: 2, tracks: [
    { node: 0, path: 'translation', times: new Float32Array([0,2]), values: new Float32Array([x,0,0,x+2,0,0]), stride: 3, interpolation: 'LINEAR' },
    { node: 0, path: 'rotation', times: new Float32Array([0]), values: new Float32Array([0,0,Math.sin(angle/2),Math.cos(angle/2)]), stride: 4, interpolation: 'LINEAR' },
    { node: 0, path: 'scale', times: new Float32Array([0]), values: new Float32Array([scale,scale,scale]), stride: 3, interpolation: 'LINEAR' },
  ] });
  return createSkinState(sk, [clip('A',0,170*Math.PI/180,1),clip('B',10,-170*Math.PI/180,2),clip('C',-10,0,1)]);
}
describe('local pose transitions', () => {
  it('starts continuously, blends TRS with shortest-arc rotation, and completes at the moving target', () => {
    const s = fixture(); s.time = 1;
    const before = sampleAnimationPose(s); selectClip(s,1,1);
    expect(sampleAnimationPose(s)).toEqual(before);
    s.time = .5; advancePoseTransition(s,.5);
    const pose = sampleAnimationPose(s)[0]!;
    expect(pose.t[0]).toBeCloseTo(5.75); expect(pose.s[0]).toBeCloseTo(1.5);
    expect(Math.abs(pose.r[2])).toBeCloseTo(1); expect(Math.hypot(...pose.r)).toBeCloseTo(1);
    advancePoseTransition(s,.5); expect(s.transition).toBeUndefined();
    expect(sampleAnimationPose(s)[0]!.t[0]).toBeCloseTo(10.5);
  });
  it('restarts an interrupted transition from the current mixed pose and rejects invalid switches', () => {
    const s = fixture(); selectClip(s,1,1); advancePoseTransition(s,.4);
    const before = sampleAnimationPose(s); selectClip(s,2,.6);
    expect(sampleAnimationPose(s)).toEqual(before);
    const transition = s.transition; selectClip(s,99,.2); selectClip(s,0,NaN);
    expect(s.transition).toBe(transition); expect(s.clip).toBe(2);
    selectClip(s,0,0); expect(s.transition).toBeUndefined(); expect(s.time).toBe(0);
  });
  it('uses one clock, freezes while paused, and evaluates without accumulating pose changes', () => {
    const s = fixture(); selectClip(s,1,.2); s.playing = false; advance(s,.1);
    expect(s.transition!.elapsed).toBe(0);
    const a = new Float32Array(32), b = new Float32Array(32); evalJointMatrices(s,a); evalJointMatrices(s,b); expect(a).toEqual(b);
    s.playing = true; advance(s,.1); expect(s.transition!.elapsed).toBeCloseTo(.1);
    advance(s,.1); expect(s.transition).toBeUndefined();
    selectClip(s,0,.2); for(let i=0;i<6;i++) advancePoseTransition(s,1/30);
    expect(s.transition).toBeUndefined(); // Six fixed ticks must not need an extra floating-point tick.
  });
});

function palette(): BakedPalette {
  const data = new Float32Array(4*16);
  for (let i=0;i<4;i++) { data.set(mat4(),i*16); data[i*16+12]=i*10; }
  return { jointCount: 1, clips: [], clipBasePose: [], data };
}
describe('instanced palette transitions', () => {
  it('blends to moving sampled poses and snapshots the displayed blend on interruption', () => {
    const p=palette(), t=new PalettePoseTransitions();
    expect(t.sample('1:2:3',p,0,0,0,1).weight).toBe(1);
    const start=t.sample('1:2:3',p,1,1,.1,1); expect(start.weight).toBe(0); expect(start.from![12]).toBe(0);
    const mid=t.sample('1:2:3',p,1,2,.6,1); expect(mid.weight).toBeCloseTo(.5);
    const interrupted=t.sample('1:2:3',p,2,3,.6,1); expect(interrupted.weight).toBe(0); expect(interrupted.from![12]).toBeCloseTo(10);
    const complete=t.sample('1:2:3',p,2,3,1.6,1); expect(complete.weight).toBe(1); expect(complete.from).toBeNull();
  });
  it('preserves repeated-tick sources and isolates identities, restarts, palettes, and zero duration', () => {
    const p=palette(),t=new PalettePoseTransitions(); t.sample('a',p,0,0,0,1);
    const a=t.sample('a',p,1,1,.1,1), repeated=t.sample('a',p,1,1,.1,1); expect(repeated.from).toBe(a.from); expect(repeated.weight).toBe(0);
    expect(t.sample('b',p,1,1,.1,1).weight).toBe(1);
    expect(t.sample('a',p,2,2,.2,0).weight).toBe(1);
    expect(t.sample('a',p,1,1,0,1).weight).toBe(1);
    expect(t.sample('a',palette(),0,0,.1,1).weight).toBe(1);
    t.prune(new Set()); expect(t.sample('a',p,1,1,.2,1).weight).toBe(1);
    t.clear(); expect(t.sample('a',p,0,0,.3,1).weight).toBe(1);
  });
});
