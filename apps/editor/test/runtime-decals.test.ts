import {describe,it,expect,vi} from 'vitest';import raw from '../../../assets/scenes/sandbox/procedural-decal-whitebox.scene.json';
import {RuntimeDecals} from '../src/services/runtime-decals';import {loadLevelRuntime,RuntimeSession} from '@aether/zombie-game';import type {SceneDocument} from '@aether/scene';import type {LabRenderer} from '../src/renderer';
describe('运行贴花宿主生命周期',()=>{
  it('使用权威 tick；暂停/读诊断不推进、淡出到期、reset 拒绝旧 runId、Stop释放且不改作者',()=>{
    const doc=structuredClone(raw) as unknown as SceneDocument,before=JSON.stringify(doc),clear=vi.fn(),publish=vi.fn();
    const r={getDocument:()=>doc,setRuntimeDecals:publish,core:{clearDecalResources:clear,decalSnapshot:()=>({instances:12,drawCalls:1,bufferBytes:4096})}} as unknown as LabRenderer;
    const rt=new RuntimeSession({desc:loadLevelRuntime(doc).desc!,seed:1}),host=new RuntimeDecals(r);host.start(rt);const id=rt.player()!.runId;
    const c=doc.nodes.find(n=>n.id==='nd_nav3d_low')!.components.find(c=>c.kind==='Decal')!;if(c.kind!=='Decal')throw Error('fixture');
    const input={receiver:'nd_nav3d_low',mark:{...c.marks[0]!,id:'rt'},ttlSec:2,fadeSec:1};host.command('emit',id,input);
    rt.run(45);host.sync(rt);expect(host.snapshot().marks[0]!.mark.opacity).toBeCloseTo(.45);const s=host.snapshot();host.sync(rt);expect(host.snapshot()).toEqual(s);
    expect(()=>host.command('emit',id,{...input,receiver:'missing'})).toThrow();expect(host.snapshot()).toEqual(s);
    rt.run(20);host.sync(rt);expect(host.snapshot().count).toBe(0);host.command('clear',id);expect(host.snapshot().time).toBeCloseTo(rt.tick*rt.fixedStep);
    rt.reset();host.start(rt);expect(()=>host.command('emit',id,input)).toThrow('代次');host.stop();expect(clear).toHaveBeenCalledTimes(1);expect(host.snapshot().count).toBe(0);expect(host.snapshot().runId).toBeNull();expect(JSON.stringify(doc)).toBe(before);
  });
});
