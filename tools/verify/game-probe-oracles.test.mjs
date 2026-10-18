import {test} from 'node:test';
import assert from 'node:assert/strict';
import {roomWaves,actorDemand,sameCounts,validSkinRow,shouldFailAssetRequest,GAME_PROBE_SCENE,readProbeScene} from './game-probe-oracles.mjs';
import {smokePlan,runSmokePlan} from './editor-smoke-all.mjs';

test('房间/稀疏波次按稳定父引用归组，排除禁用、其他房间和非room-enter',()=>{
  const room=id=>({id,parent:null,components:[{kind:'RoomVolume'}]});
  const spawn=(id,parent,wave,count,extra={})=>({id,parent,components:[{kind:'SpawnPoint',enabled:true,characterId:'E-01',trigger:'room-enter',wave,count,...extra}]});
  const doc={nodes:[room('a'),room('b'),{id:'nested',parent:'a',components:[]},spawn('s1','nested',5,3),spawn('s2','a',1,2),spawn('s3','b',1,100),spawn('s4','a',1,99,{enabled:false}),spawn('s5','a',1,100,{trigger:'manual'})]};
  assert.deepEqual(roomWaves(doc,'a'),[{wave:1,counts:{'E-01':2},total:2},{wave:5,counts:{'E-01':3},total:3}]);
  assert.ok(sameCounts({'E-02':2,'E-01':1},{'E-01':1,'E-02':2}));
  assert.ok(!sameCounts({'E-01':1},{'E-01':2}));
});
test('装配oracle覆盖未来波次的rig-only和动画档，缺档代理不可伪装已装配',()=>{
  const doc=readProbeScene(GAME_PROBE_SCENE);
  const manifest={characters:[{id:'E-01',lods:[{label:'LOD +骨骼'}]},{id:'E-02',lods:[{label:'LOD +动画'}]},{id:'B-02',lods:[{label:'LOD0'}]},{id:'unused',lods:[{label:'+动画'}]}]};
  assert.deepEqual(actorDemand(doc,manifest),{actors:['E-01','E-02'],missing:['B-02']});
  assert.equal(roomWaves(doc,'nd_probe_room')[0].total,6);
  assert.equal(roomWaves(doc,'nd_probe_room')[1].total,4);
});
test('实例flags与矩阵完整stride边界，拒绝局部pose越界、错误base/stride及NaN',()=>{
  const actor={base:80,poses:3,joints:10},row={base:80,pose:2,stride:10,flags:1};
  assert.ok(validSkinRow(row,actor,110));
  for(const bad of [{...row,pose:3},{...row,pose:-1},{...row,pose:NaN},{...row,pose:.5},{...row,stride:9},{...row,base:0},{...row,flags:0},{...row,flags:-1},{...row,flags:0x100000001}])assert.ok(!validSkinRow(bad,actor,110));
  assert.ok(!validSkinRow(row,actor,109));
  assert.ok(validSkinRow({base:0,pose:0,stride:0,flags:0},null,110));
  assert.ok(!validSkinRow({...row,flags:0},null,110));
});
test('聚合入口将headed/url/window参数逐套传递，并隔离输出目录',()=>{
  const plan=smokePlan(['--','--headed','--out','tmp/result','--url','https://test:5100','--window-size','1600,1000'],'win32');
  assert.equal(plan.suites.length,4);assert.equal(new Set(plan.suites.map(s=>s.args.at(-1))).size,4);
  for(const suite of plan.suites)assert.deepEqual(suite.args.slice(0,-2),['--headed','--url','https://test:5100','--window-size','1600,1000']);
  assert.throws(()=>smokePlan([],'win32'),/headed/);assert.throws(()=>smokePlan(['--headed','--out'],'win32'),/目录/);
});
test('聚合入口保留失败退出码，后续未执行套件不得记为通过',()=>{
  const plan=smokePlan(['--headed'],'win32');let calls=0;
  const failed=runSmokePlan(plan,()=>({status:++calls===2?1:0}));assert.equal(failed.ok,false);assert.equal(calls,2);assert.equal(failed.notRun.length,2);
  const ok=runSmokePlan(plan,()=>({status:0}));assert.equal(ok.ok,true);assert.equal(ok.results.length,4);
  const crashed=runSmokePlan(plan,()=>({status:null,signal:'SIGTERM'}));assert.equal(crashed.ok,false);assert.equal(crashed.results[0].status,1);
});

test('故障注入只拦截精确GET资产，meta/BVH/其他接口及非GET不受影响',()=>{
  const asset='assets/characters/models/B-02/rigged/model.glb',request={method:'GET',url:'https://test/__fs/file?path='+encodeURIComponent(asset)};
  assert.equal(shouldFailAssetRequest(request,asset),true);
  for(const bad of [{...request,method:'POST'},{...request,url:request.url+'.meta.json'},{...request,url:'https://test/other?path='+encodeURIComponent(asset)},{...request,url:'not-a-url'},{...request,url:request.url.replace('B-02','E-01')}])assert.equal(shouldFailAssetRequest(bad,asset),false);
});
