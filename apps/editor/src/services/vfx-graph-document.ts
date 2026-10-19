import {migrateVfxGraphAsset,type VfxGraphAsset} from '@aether/scene';
import {compileVfxGraph,sceneFingerprint} from '@aether/runtime';
import {readProjectFile,writeProjectFile} from '../asset-util';

/** Source-only history. Invalid intermediate links remain editable drafts; saving requires compilation. */
export class VfxGraphDocument {
 private baseline:VfxGraphAsset;private clean:VfxGraphAsset;
 private undoStack:VfxGraphAsset[]=[];private redoStack:VfxGraphAsset[]=[];
 value:VfxGraphAsset;busy=false;
 constructor(readonly path:string,source:unknown){this.value=migrateVfxGraphAsset(source);this.baseline=structuredClone(source) as VfxGraphAsset;this.clean=structuredClone(this.value);}
 get sourceVersion(){return this.baseline.graph.version;}
 get dirty(){return sceneFingerprint(this.value)!==sceneFingerprint(this.clean);}
 get compilation(){return compileVfxGraph(this.value);}
 edit(mutate:(next:VfxGraphAsset)=>void){
  const next=structuredClone(this.value);mutate(next);if(next.id!==this.baseline.id)throw new Error('图GUID不可更改');
  this.undoStack.push(this.value);if(this.undoStack.length>128)this.undoStack.shift();this.redoStack=[];this.value=next;
 }
 undo(){const previous=this.undoStack.pop();if(previous){this.redoStack.push(this.value);this.value=previous;}}
 redo(){const next=this.redoStack.pop();if(next){this.undoStack.push(this.value);this.value=next;}}
 async save(port={write:writeProjectFile}){
  if(this.busy)throw new Error('节点图正在保存');const result=this.compilation;if(!result.asset)throw new Error('图尚不可播放，保留草稿：'+result.diagnostics.join('；'));
  const snapshot=structuredClone(this.value);this.busy=true;
  try{const r=await port.write(this.path,{content:JSON.stringify(snapshot,null,2)+'\n',baseHash:sceneFingerprint(this.baseline)});
   if(!r.ok)throw new Error(r.conflict?'磁盘已被外部修改，保留图草稿；请重载或合并':r.error??'图保存失败');
   this.baseline=snapshot;this.clean=structuredClone(snapshot);return '节点图已保存；派生effects仅在内存';
  }finally{this.busy=false;}
 }
 async reload(port={read:readProjectFile}){
  const r=await port.read(this.path);if(!r.ok)throw new Error(r.error??'节点图重载失败');const next=migrateVfxGraphAsset(r.json);
  if(next.id!==this.baseline.id)throw new Error('磁盘图GUID已改变');this.baseline=structuredClone(r.json) as VfxGraphAsset;this.value=next;this.clean=structuredClone(next);this.undoStack=[];this.redoStack=[];
 }
}
