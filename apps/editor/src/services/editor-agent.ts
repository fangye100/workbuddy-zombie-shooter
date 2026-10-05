import { createEmptySceneDocument, validateSceneDocument, type EnvironmentData, type SceneNode } from '@aether/scene';
import { removeNodeTree, sceneFingerprint, validateAuthorNodes, type EditResult, type SpawnEditStore } from '@aether/runtime';
import type { AuthorSaveResult } from './author-scene-save';
import { readSceneChoices, checkScene } from './scene-workspace';

export interface EditorAgentPort {
  store(): SpawnEditStore | null;
  path(): string | null;
  busy(): boolean;
  draft(): boolean;
  playing(): boolean;
  pendingAssets(): number;
  open(path: string): Promise<unknown>;
  rebuild(): Promise<void>;
  environmentChanged(): void;
  history(redo: boolean): Promise<EditResult>;
  save(): Promise<AuthorSaveResult>;
  play(action: string, steps: number): void;
  runtime(): unknown;
  capture(): Promise<string>;
}
class AgentError extends Error { constructor(readonly code: string, message: string) {super(message);} }
function fail(code:string,message:string):never {throw new AgentError(code,message);}
const record = (value:unknown): value is Record<string,unknown> => !!value && typeof value==='object'&&!Array.isArray(value);

/** Commands share the live editor's store. This class owns neither a scene copy nor another undo stack. */
export class EditorAgent {
  constructor(private readonly port: EditorAgentPort) {}
  state() {
    const store=this.port.store();
    return {path:this.port.path(),name:store?.document.name??null,revision:store?sceneFingerprint(store.document):null,
      dirty:store?.dirty??false,hasDraft:this.port.draft(),busy:this.port.busy(),pendingAssets:this.port.pendingAssets(),playing:this.port.playing()};
  }
  async call(name:string,args:Record<string,unknown>):Promise<Record<string,unknown>> {
    try {
      if(name==='scene_list')return {ok:true,scenes:await readSceneChoices(),state:this.state()};
      const store=this.port.store(); if(!store)fail('NOT_READY','No author scene is loaded.');
      if(name==='scene_get')return {ok:true,document:structuredClone(store.document),state:this.state()};
      if(name==='editor_runtime')return {ok:true,runtime:this.port.runtime(),state:this.state()};
      if(name==='scene_validate') {
        const diagnostics=validateSceneDocument(store.document), author=validateAuthorNodes(store.document);
        return {ok:true,valid:!author&&!diagnostics.some(d=>d.severity==='error'),diagnostics,authorError:author,state:this.state()};
      }
      if(this.port.busy()||this.port.pendingAssets()>0)fail('NOT_READY','Wait for projection and pending assets to finish.');
      if(name==='editor_capture')return {ok:true,image:{data:await this.port.capture()},scope:'GPU viewport only; DOM HUD excluded',state:this.state()};
      if(typeof args.expectedRevision!=='string'||args.expectedRevision!==sceneFingerprint(store.document))fail('REVISION_CONFLICT','Read scene_get and rebase the intended edit.');
      if(this.port.draft() && !(name==='scene_open'&&args.discardUnsaved===true))fail('UI_DRAFT','Apply or discard the active human form draft before changing its scene.');
      if(name==='editor_play') {
        if(typeof args.action!=='string'||!['start','resume','pause','step','stop'].includes(args.action))fail('INVALID_ARGUMENTS','Unknown play action');
        const steps=args.steps??1;
        if(!Number.isInteger(steps)||Number(steps)<1||Number(steps)>600)fail('INVALID_ARGUMENTS','steps must be an integer from 1 to 600');
        this.port.play(args.action,Number(steps)); return {ok:true,runtime:this.port.runtime(),state:this.state()};
      }
      if(this.port.playing())fail('PLAY_LOCKED','Stop Play before changing author content.');
      if(name==='scene_open') {
        if(typeof args.path!=='string')fail('INVALID_ARGUMENTS','path is required');
        if(store.dirty&&!args.discardUnsaved)fail('UNSAVED_CHANGES','Save first or explicitly set discardUnsaved=true.');
        const choices=await readSceneChoices(); if(!choices.some(c=>c.path===args.path))fail('UNREGISTERED_SCENE','Scene must be registered in aether.project.json.');
        await checkScene(args.path);
        // Recheck after I/O: a human may have edited while preflight was running.
        if(this.port.store()!==store||sceneFingerprint(store.document)!==args.expectedRevision||this.port.playing())fail('REVISION_CONFLICT','Editor changed during scene preflight.');
        const loaded=await this.port.open(args.path);return {ok:true,loaded,state:this.state()};
      }
      if(name==='scene_create') {
        if(typeof args.path!=='string'||typeof args.name!=='string'||!args.name.trim())fail('INVALID_ARGUMENTS','path and non-empty name are required');
        const doc=args.copyCurrent?structuredClone(store.document):createEmptySceneDocument(args.name);
        doc.name=args.name;doc.id=`sc_${crypto.randomUUID().replaceAll('-','')}`;
        const resp=await fetch('/__fs/create-scene',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:args.path,document:doc})});
        const result=await resp.json() as {ok?:boolean;error?:string};
        if(!resp.ok||!result.ok)fail('CREATE_FAILED',result.error??`HTTP ${resp.status}`);
        return {ok:true,path:args.path,sceneId:doc.id,state:this.state()};
      }
      if(name==='scene_edit_nodes') {
        const operations=args.operations;
        if(!Array.isArray(operations)||!operations.length||operations.length>128)fail('INVALID_ARGUMENTS','operations must contain 1 to 128 node commands');
        const result=store.editNodes(typeof args.label==='string'?args.label:'Agent scene edit',nodes=>{
          for(const op of operations) {
            if(!record(op)||typeof op.nodeId!=='string')fail('INVALID_ARGUMENTS','Each operation needs a stable nodeId');
            const index=nodes.findIndex(n=>n.id===op.nodeId);
            if(op.op==='remove') {
              if(index<0)fail('NODE_NOT_FOUND',op.nodeId);
              if(op.cascade)removeNodeTree(nodes,op.nodeId);else nodes.splice(index,1);
            } else if(op.op==='add'||op.op==='replace') {
              if(!record(op.node)||op.node.id!==op.nodeId)fail('INVALID_ARGUMENTS','node.id must equal nodeId');
              if(op.op==='add'&&index>=0)fail('DUPLICATE_NODE',op.nodeId);
              if(op.op==='replace'&&index<0)fail('NODE_NOT_FOUND',op.nodeId);
              const node=structuredClone(op.node) as unknown as SceneNode;
              if(op.op==='add')nodes.push(node);else nodes[index]=node;
            } else fail('INVALID_ARGUMENTS','Unknown node operation');
          }
        });
        if(!result.ok)fail('VALIDATION_FAILED',result.error??'Node edit rejected');
        await this.port.rebuild();return {ok:true,edit:result.edit,state:this.state()};
      }
      if(name==='scene_set_environment') {
        if(!record(args.environment))fail('INVALID_ARGUMENTS','environment must be an object');
        const result=store.setEnvironment(args.environment as unknown as EnvironmentData);
        if(!result.ok)fail('VALIDATION_FAILED',result.error??'Environment rejected');
        this.port.environmentChanged();return {ok:true,edit:result.edit,state:this.state()};
      }
      if(name==='scene_history') {
        if(args.action!=='undo'&&args.action!=='redo')fail('INVALID_ARGUMENTS','Expected undo or redo');
        const result=await this.port.history(args.action==='redo');
        if(!result.ok)fail('HISTORY_REJECTED',result.error??'History operation rejected');
        return {ok:true,edit:result.edit,state:this.state()};
      }
      if(name==='scene_save') {
        const result=await this.port.save();return {...result,code:result.ok?'SAVED':result.status.toUpperCase(),state:this.state()};
      }
      fail('UNKNOWN_TOOL',name);
    } catch(error) {return {ok:false,code:error instanceof AgentError?error.code:'COMMAND_FAILED',message:String(error instanceof Error?error.message:error),state:this.state()};}
  }
}

/** Instance-addressed Vite channel; requests are serial, not concurrent state mutations. */
export function connectEditorAgent(agent:EditorAgent): {afterFrame(canvas:HTMLCanvasElement):void; capture():Promise<string>} {
  const hot=import.meta.hot;
  const instanceId=crypto.randomUUID();
  document.documentElement.dataset.editorInstanceId=instanceId;
  let queue=Promise.resolve();
  let capture: {resolve(value:string):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}|null=null;
  const hello=()=>hot?.send('aether:hello',{instanceId,url:location.href,...agent.state()});
  const receive=(request:{requestId:string;name:string;args:Record<string,unknown>})=>{
    if(request.args.instanceId!==instanceId)return;
    queue=queue.then(async()=>{const result=await agent.call(request.name,request.args);hot?.send('aether:reply',{requestId:request.requestId,result});hello();});
  };
  hot?.on('aether:request',receive);hot?.on('vite:ws:connect',hello);hello();
  const timer=setInterval(hello,5000);
  hot?.dispose(()=>{clearInterval(timer);hot.off('aether:request',receive);hot.off('vite:ws:connect',hello);if(capture){clearTimeout(capture.timer);capture.reject(new Error('Editor reloaded'));capture=null;}});
  return {
    capture:()=>new Promise((resolve,reject)=>{if(capture){reject(new Error('Capture already pending'));return;}
      capture={resolve,reject,timer:setTimeout(()=>{capture=null;reject(new Error('No GPU frame within 15 seconds; bring this editor instance into view.'));},15000)};
    }),
    afterFrame(canvas){if(!capture)return;const pending=capture;capture=null;clearTimeout(pending.timer);
      try {pending.resolve(canvas.toDataURL('image/png').split(',')[1]!);}catch(error){pending.reject(new Error(String(error)));}},
  };
}
