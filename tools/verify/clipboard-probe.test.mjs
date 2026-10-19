import {test} from 'node:test';
import assert from 'node:assert/strict';
import {clickFocusedElement,readClipboardOutcome} from './clipboard-probe.mjs';

const ready = {x:40,y:50,focused:true,visible:true,enabled:true,hit:true};
test('右键/左键均经过浏览器真实输入，拒绝无焦点、隐藏、禁用及遮挡目标',async()=>{
  for (const button of ['right','left']) {
    const sent=[],cdp={send:async(...args)=>sent.push(args),eval:async()=>ready};
    await clickFocusedElement(cdp,'document.querySelector("button")',button);
    assert.deepEqual(sent,[['Page.bringToFront'],
      ['Input.dispatchMouseEvent',{type:'mouseMoved',x:40,y:50}],
      ['Input.dispatchMouseEvent',{type:'mousePressed',x:40,y:50,button,clickCount:1}],
      ['Input.dispatchMouseEvent',{type:'mouseReleased',x:40,y:50,button,clickCount:1}]]);
  }
  for (const key of ['focused','visible','enabled','hit']) {
    const sent=[],cdp={send:async(...args)=>sent.push(args),eval:async()=>({...ready,[key]:false})};
    await assert.rejects(clickFocusedElement(cdp,'null'),/真实焦点/);
    assert.deepEqual(sent,[['Page.bringToFront']]);
  }
});

const copied={readable:true,matches:true,hudMatches:true,focused:true,length:30,error:null,hud:'expected'};
test('读回须等本次 HUD 与剪贴板都匹配，不能只接受其中一项',async()=>{
  const sequence=[{...copied,matches:false,length:0},{...copied,hudMatches:false},copied];let calls=0;
  const cdp={eval:async()=>sequence[calls++]};
  assert.equal(await readClipboardOutcome(cdp,{expected:'path',hudText:'expected',interval:0}),copied);
  assert.equal(calls,3);
});
test('空串、旧值或 HUD 失败均不能通过；超时有界且不打印无关剪贴板内容',async()=>{
  for (const change of [{matches:false,length:0},{matches:false,length:99},{hudMatches:false}]) {
    const cdp={eval:async()=>({...copied,...change})};
    await assert.rejects(readClipboardOutcome(cdp,{expected:'path',hudText:'expected',timeout:15,interval:1}),/剪贴板读回超时/);
  }
});
test('读权限拒绝或失去焦点保留失败原因，不能转为 SKIP/成功',async()=>{
  for (const bad of [{...copied,readable:false,matches:false,error:'NotAllowedError'}, {...copied,focused:false}]) {
    assert.equal(await readClipboardOutcome({eval:async()=>bad},{expected:'path',hudText:'expected'}),bad);
  }
});
test('原生 readText 挂起和 CDP 异常均使验收失败',async()=>{
  await assert.rejects(readClipboardOutcome({eval:()=>new Promise(()=>{})},{expected:'path',hudText:'expected',timeout:15}),/剪贴板读回超时/);
  await assert.rejects(readClipboardOutcome({eval:async()=>{throw new Error('CDP disconnected');}},{expected:'path',hudText:'expected'}),/CDP disconnected/);
});
