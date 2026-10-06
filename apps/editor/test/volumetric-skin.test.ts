import { describe, expect, it } from 'vitest';
import { computeVolumetricWeights } from '../src/services/binding/volumetric-skin';
import { buildSolidVolume } from '../src/services/binding/volumetric-volume';
import { BindingSession } from '../src/services/binding/binding-session';
import { rigToTPose } from '../src/services/binding/binding-export';
import { HUMANIK_ORDER, tposeWorldPositions } from '../src/services/binding/humanik-template';

function boxes(centers: number[]) {
  const positions: number[] = [], indices: number[] = [];
  for (const x of centers) {
    const start = positions.length / 15;
    for (const p of [[-.08,-.4,-.08],[.08,-.4,-.08],[.08,.4,-.08],[-.08,.4,-.08],[-.08,-.4,.08],[.08,-.4,.08],[.08,.4,.08],[-.08,.4,.08]]) {
      positions.push(p[0]!+x,p[1]!,p[2]!,...Array<number>(12).fill(0));
    }
    // Outward orientation, six closed faces.
    for (const i of [0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,0,4,7,0,7,3,1,2,6,1,6,5]) indices.push(start+i);
  }
  return { vertices: new Float32Array(positions), indices: new Uint32Array(indices) };
}
const options = { resolution: 16, depth: 1, tolerance: .001 };
function placed() {
  const p = tposeWorldPositions();
  for (const key of HUMANIK_ORDER) p[key] = [20,20,20];
  p.LeftArm = [-.12,-.3,0]; p.LeftForeArm = [-.12,.3,0];
  p.RightArm = [.12,-.3,0]; p.RightForeArm = [.12,.3,0];
  return p;
}
describe('Adaptive volumetric diffusion', () => {
  it('keeps two near surfaces disconnected, refines boundaries, and preserves geometry', () => {
    const mesh = boxes([-.12,.12]), before = mesh.vertices.slice();
    const volume = buildSolidVolume(mesh.vertices,15,mesh.indices,16,1);
    expect(volume.refinedCells).toBeGreaterThan(0);
    expect(new Set(volume.cells.map(c=>c.size)).size).toBe(2);
    for (let i=0;i<volume.neighbors.length;i++) for (const [j,w] of volume.neighbors[i]!) {
      expect(w).toBeGreaterThan(0); expect(volume.neighbors[j]!.get(i)).toBe(w);
    }
    const result = computeVolumetricWeights(mesh.vertices,15,mesh.indices,placed(),options);
    expect(result.volumetric.components).toBe(2);
    expect(result.volumetric.converged).toBe(true);
    expect(result.volumetric.fallbackVertices).toBe(0);
    for(let v=0;v<16;v++) {
      let sum=0,wrong=0;
      for(let k=0;k<4;k++) {
        const w=result.skin.weights[v*4+k]!,bone=HUMANIK_ORDER[result.skin.joints[v*4+k]!]!;
        expect(Number.isFinite(w)).toBe(true);expect(w).toBeGreaterThanOrEqual(0);
        expect(bone.endsWith('Tip')).toBe(false);sum+=w;
        if(v<8?bone.startsWith('Right'):bone.startsWith('Left'))wrong+=w;
      }
      expect(sum).toBeCloseTo(1,5);expect(wrong).toBeLessThan(.001);
    }
    expect(mesh.vertices).toEqual(before);
  });
  it('reports unseeded disconnected parts and outside bones with finite fallback weights', () => {
    const mesh = boxes([0]), result = computeVolumetricWeights(mesh.vertices,15,mesh.indices,tposeWorldPositions(),options);
    expect(result.volumetric.outsideBones.length).toBeGreaterThan(0);
    expect(Array.from(result.skin.weights).every(Number.isFinite)).toBe(true);
    const p=placed();for(const key of HUMANIK_ORDER)p[key]=[20,20,20];
    expect(computeVolumetricWeights(mesh.vertices,15,mesh.indices,p,options).volumetric.unseededComponents).toBeGreaterThan(0);
  });
  it('retains open thin sheets with explicit surface diagnostics', () => {
    const mesh=boxes([0]);mesh.indices=mesh.indices.slice(0,6);
    const result=computeVolumetricWeights(mesh.vertices,15,mesh.indices,placed(),options);
    expect(result.volumetric.surfaceOnlyCells).toBeGreaterThan(0);
    for(let i=0;i<mesh.vertices.length/15;i++)expect(Array.from(result.skin.weights.slice(i*4,i*4+4)).reduce((a,b)=>a+b,0)).toBeCloseTo(1,5);
  });
  it('rejects invalid parameters, indices, degenerate and nonfinite meshes', () => {
    const mesh=boxes([0]);
    expect(()=>computeVolumetricWeights(mesh.vertices,15,mesh.indices,placed(),{...options,depth:9})).toThrow('参数');
    expect(()=>buildSolidVolume(mesh.vertices,15,new Uint32Array([0,1,99]),16,0)).toThrow('越界');
    expect(()=>buildSolidVolume(new Float32Array(45),15,new Uint32Array([0,1,2]),16,0)).toThrow('有效表面');
    const bad=mesh.vertices.slice();bad[0]=NaN;
    expect(()=>buildSolidVolume(bad,15,mesh.indices,16,0)).toThrow('非有限');
    expect(()=>buildSolidVolume(mesh.vertices,15,mesh.indices,16,0,1)).toThrow('上限');
  });
  it('session/export share exact weights, and settings survive save, Undo and model reset', () => {
    const mesh=boxes([-.12,.12]),s=new BindingSession();s.setModel('boxes',mesh.vertices,mesh.indices);
    s.hydrate({positions:placed(),weightMode:'volumetric',volumetric:options,smoothWeights:false});
    const skin=s.computeSkin()!;
    const out=rigToTPose({name:'boxes',...mesh,image:null,placed:s.positions,bindPose:'source',weightMode:'volumetric',volumetric:options,smoothWeights:false});
    expect(out.skin).toEqual(skin.skin);expect(out.stats.volumetric?.algorithm).toBe('adaptive-volume-diffusion-v1');
    const copy=new BindingSession();copy.setModel('boxes',mesh.vertices,mesh.indices);copy.hydrate(s.getEditorData());
    expect(copy.getVolumetricOptions()).toEqual(options);expect(copy.getWeightMode()).toBe('volumetric');
    const sig=s.editSig();s.applyOptions({volumetric:{...options,depth:0}});expect(s.editSig()).not.toBe(sig);
    expect(s.getCachedSkin()).toBeNull();s.undo();expect(s.getVolumetricOptions()).toEqual(options);
    const history=s.historyDepth();expect(()=>s.applyOptions({weightMode:'distance',volumetric:{...options,resolution:1000}})).toThrow();
    expect(s.historyDepth()).toEqual(history);expect(s.getWeightMode()).toBe('volumetric');
    expect(()=>s.hydrate({weightMode:'distance',volumetric:{...options,depth:7}})).toThrow();expect(s.getWeightMode()).toBe('volumetric');
    s.setModel('new',mesh.vertices,mesh.indices);expect(s.getVolumetricOptions()).toEqual({resolution:48,depth:1,tolerance:.001});
  });
  it('Worker result cannot overwrite edits or a replacement model; success installs the cache', async () => {
    const mesh=boxes([0]),s=new BindingSession();s.setModel('box',mesh.vertices,mesh.indices);
    s.applyOptions({weightMode:'volumetric',volumetric:options,smoothWeights:false});
    const raw=computeVolumetricWeights(mesh.vertices,15,mesh.indices,s.positions,options);
    let finish!: (value: typeof raw)=>void;
    const pending=s.computeSkinAsync(()=>new Promise(resolve=>{finish=resolve;}));
    s.poseJoint('Head',[0,2,0]);finish(raw);await expect(pending).rejects.toThrow('已变更');expect(s.getCachedSkin()).toBeNull();
    const next=s.computeSkinAsync(()=>new Promise(resolve=>{finish=resolve;}));
    s.setModel('new',mesh.vertices.slice(),mesh.indices);finish(raw);await expect(next).rejects.toThrow('已变更');
    s.applyOptions({weightMode:'volumetric',volumetric:options,smoothWeights:false});
    const done=await s.computeSkinAsync(async()=>raw);expect(s.getCachedSkin()).toBe(done);
    const history=s.historyDepth();s.clearSkinCache();expect(s.getCachedSkin()).toBeNull();expect(s.historyDepth()).toEqual(history);
  });
});
