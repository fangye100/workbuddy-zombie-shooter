import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSceneContract } from './load-contract.mjs';

test('Node 工具读取真实公共 schema 与独立导航默认值',async()=>{
  const contract=await loadSceneContract();
  assert.equal(contract.SCHEMA_VERSION,17);
  const first=contract.defaultNavigationSettings(),second=contract.defaultNavigationSettings();
  assert.equal(contract.validNavigationSettings(first),true);
  first.maxNeighbors=1;
  assert.equal(second.maxNeighbors,12);
  assert.equal(contract.validNavigationSettings({...second,flowCellBudget:0}),false);
});
