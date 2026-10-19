import {expect,it,vi} from 'vitest';
import type {VfxAsset} from '@aether/scene';
import {sceneFingerprint} from '@aether/runtime';
import {graphFixture} from '../../../packages/scene/test/vfx-graph-fixture';
import {VfxPanel} from '../src/services/vfx-panel';
import {VfxGraphPanel} from '../src/services/vfx-graph-panel';
import {VfxDocument} from '../src/services/vfx-document';
import {VfxGraphDocument} from '../src/services/vfx-graph-document';

// Exercise the original Apply/run/Save methods and real document history/CAS.
// Only DOM value holders and preview side effects are isolated; this is not GPU/UI-layout acceptance.
function author(kind:'asset'|'graph',legacy=false,dirty=false){
  const status={textContent:''},stop=vi.fn();let model:VfxDocument|VfxGraphDocument,panel:any,flow:()=>unknown,baseline:string;
  const params:Record<string,{value:string}>={};
  if(kind==='asset'){
    const raw:VfxAsset={version:9,id:'test',name:'测试',status:'accepted',effects:{flame:{kind:'sprite',texture:{path:'assets/a.svg',guid:'a'},frames:1,duration:.5,size:[1,1],color:'#ffffff',blend:'alpha',...(legacy?{}:{flow:{strength:.2,speed:1}})}}};
    baseline=sceneFingerprint(raw);model=new VfxDocument('assets/test.vfx.json',raw);panel=Object.create(VfxPanel.prototype);
    for(const key of ['width','height','duration','color','orientation','loop','backend','blend','acceleration','rate','speed','spread','maxParticles','sizeCurve','colorCurve','alphaCurve','decalDepth','decalAngle','decalOffset','ribbonMax','ribbonMin','ribbonBreak','ribbonUv','ribbonNode','softEnabled','softDistance','softBias','flowStrength','flowSpeed'])panel[key]={value:'',checked:false};
    Object.assign(panel,{document:model,kind:{value:'flame'},status,stop,refreshRibbonNodes:vi.fn()});panel.fields();
    flow=()=> (model as VfxDocument).value.effects.flame!.flow;
  }else{
    const raw=graphFixture();if(!legacy)raw.graph.nodes.find(n=>n.id==='sprite')!.params.flow={strength:.2,speed:1};
    baseline=sceneFingerprint(raw);model=new VfxGraphDocument('assets/graph.vfx.json',raw);panel=Object.create(VfxGraphPanel.prototype);
    for(const [key,value] of Object.entries({'节点画布X':'0','节点画布Y':'0','节点模拟后端':'cpu','节点混合方式':'alpha','节点流动强度':legacy?'0':'.2','节点流动速度':'1'}))params[key]={value};
    Object.assign(panel,{model,selected:'sprite',status,preview:{stop},port:{locked:()=>false},render:vi.fn(),properties:{querySelector:(selector:string)=>params[selector.match(/"(.+)"/)![1]!]}});
    flow=()=> (model as VfxGraphDocument).value.graph.nodes.find(n=>n.id==='sprite')!.params.flow;
  }
  const clean=structuredClone(model.value);
  if(dirty){if(model instanceof VfxDocument){const next=structuredClone(model.value);next.effects.flame!.duration=.7;model.apply(next);}else model.edit(next=>{next.name='已有未保存修改';});}
  const set=(strength:string,speed='1')=>{if(kind==='asset'){panel.flowStrength.value=strength;panel.flowSpeed.value=speed;panel.formDirty=true;}else{params['节点流动强度']!.value=strength;params['节点流动速度']!.value=speed;panel.parameterDraft=true;}};
  const apply=()=>panel.run(()=>kind==='asset'?panel.apply():panel.applyParameters());
  const draft=()=>kind==='asset'?panel.formDirty:panel.parameterDraft;
  return {model,panel,status,stop,clean,set,apply,draft,flow,baseline};
}

it.each(['-0.1','','   ','NaN','Infinity','-Infinity','.7','0x0'])('both original Apply paths reject strength %j without deleting source, draft, undo or Save guards',async strength=>{
  for(const kind of ['asset','graph'] as const)for(const dirty of [false,true]){
    const h=author(kind,false,dirty),before=structuredClone(h.model.value),save=vi.spyOn(h.model,'save').mockResolvedValue('不得写入');h.set(strength);
    await h.apply();expect(h.status.textContent).toContain('流动强度');expect(h.model.value).toEqual(before);expect(h.flow()).toEqual({strength:.2,speed:1});expect(h.model.dirty).toBe(dirty);expect(h.draft()).toBe(true);expect(h.stop).not.toHaveBeenCalled();
    await h.panel.run(()=>h.panel.save());expect(h.status.textContent).toContain('请先应用');expect(save).not.toHaveBeenCalled();
    h.model.undo();expect(h.model.value).toEqual(h.clean);expect(h.model.dirty).toBe(false);h.model.redo();expect(h.model.value).toEqual(before);expect(h.model.dirty).toBe(dirty);
  }
});

it.each(['',' ','NaN','Infinity','-1','9'])('enabled flow rejects speed %j in both Apply paths before source/history/preview changes',async speed=>{
  for(const kind of ['asset','graph'] as const){const h=author(kind,false,true),before=structuredClone(h.model.value);h.set('.3',speed);await h.apply();expect(h.status.textContent).toContain('流动速度');expect(h.model.value).toEqual(before);expect(h.model.dirty).toBe(true);expect(h.draft()).toBe(true);expect(h.stop).not.toHaveBeenCalled();h.model.undo();expect(h.model.value).toEqual(h.clean);}
});

it.each([['.4','2.5',{strength:.4,speed:2.5}],['.6','8',{strength:.6,speed:8}],['.00001','.1',{strength:.00001,speed:.1}],['0','1',undefined],[' 0 ','1',undefined]] as const)('both Apply paths preserve positive flow and explicit zero, including legacy resources, through undo/CAS Save (%s)',async(strength,speed,expected)=>{
  for(const kind of ['asset','graph'] as const)for(const legacy of [false,true]){
    const h=author(kind,legacy),before=structuredClone(h.model.value),baseline=h.baseline;let saved:unknown;
    const originalSave=h.model.save.bind(h.model);vi.spyOn(h.model,'save').mockImplementation(()=>originalSave({write:async(_path,body)=>{expect(body.baseHash).toBe(baseline);saved=JSON.parse(body.content!);return {ok:true,status:200,error:null};}}));
    h.set(strength,speed);await h.apply();expect(h.draft()).toBe(false);expect(h.flow()).toEqual(expected);expect(h.stop).toHaveBeenCalledOnce();const applied=structuredClone(h.model.value);
    h.model.undo();expect(h.model.value).toEqual(before);h.model.redo();expect(h.model.value).toEqual(applied);await h.panel.run(()=>h.panel.save());expect(saved).toEqual(applied);expect(h.model.dirty).toBe(false);
  }
});
