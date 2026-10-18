import { validateVfxAsset, type VfxAsset } from '@aether/scene';
import { sceneFingerprint } from '@aether/runtime';
import { readProjectFile,writeProjectFile } from '../asset-util';

/** Asset history is separate from scene dirty/history; disk CAS always uses the loaded baseline. */
export class VfxDocument {
  private baseline:VfxAsset;
  value:VfxAsset;
  private undoStack:VfxAsset[]=[];
  private redoStack:VfxAsset[]=[];
  busy=false;
  constructor(readonly path:string,asset:VfxAsset){this.baseline=structuredClone(asset);this.value=structuredClone(asset);}
  get dirty():boolean{return sceneFingerprint(this.value)!==sceneFingerprint(this.baseline);}
  apply(next:VfxAsset):void {const errors=validateVfxAsset(next);if(errors.length)throw new Error(errors.join('；'));if(next.id!==this.baseline.id)throw new Error('不能改变已加载资源 GUID');this.undoStack.push(structuredClone(this.value));this.redoStack=[];this.value=structuredClone(next);}
  undo():void {const previous=this.undoStack.pop();if(previous){this.redoStack.push(this.value);this.value=previous;}}
  redo():void {const next=this.redoStack.pop();if(next){this.undoStack.push(this.value);this.value=next;}}
  async save(port={write:writeProjectFile}):Promise<string>{
    if(this.busy)throw new Error('VFX 保存进行中');this.busy=true;
    const snapshot=structuredClone(this.value);
    try{const errors=validateVfxAsset(snapshot);if(errors.length)throw new Error(errors.join('；'));
      const r=await port.write(this.path,{content:JSON.stringify(snapshot,null,2)+'\n',baseHash:sceneFingerprint(this.baseline)});
      if(!r.ok)throw new Error(r.conflict?'磁盘已被外部修改，保留本地草稿；请重载或合并':r.error??'VFX 保存失败');
      this.baseline=snapshot;return 'VFX 资产已保存（独立于场景绑定）';
    }finally{this.busy=false;}
  }
  async reload():Promise<void>{const r=await readProjectFile(this.path);if(!r.ok)throw new Error(r.error??'重载失败');const errors=validateVfxAsset(r.json);if(errors.length)throw new Error(errors.join('；'));const asset=r.json as VfxAsset;if(asset.id!==this.baseline.id)throw new Error('磁盘 VFX GUID 已改变');this.baseline=structuredClone(asset);this.value=structuredClone(asset);this.undoStack=[];this.redoStack=[];}
}
