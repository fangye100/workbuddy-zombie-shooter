import { AudioFramePlanner, type AudioRequest, type PlaySession } from '@aether/zombie-game';
import type { AudioCue, GameplayAudioConfig } from '@aether/scene';
import { audioResource } from './game-audio-assets';
import { gameText as g } from './game-language';

interface Loaded {buffer:AudioBuffer;start:number;end:number}
interface Voice {source:AudioBufferSourceNode;gain:GainNode;pan:StereoPannerNode;priority:number;bus:AudioCue['bus'];request:AudioRequest;stop(immediate?:boolean):void}

/** Web Audio presentation only. Simulation and animation observers stay independent. */
export class GameAudio {
  readonly control=document.createElement('details');
  private readonly title=document.createElement('summary');
  private readonly panel=document.createElement('div');
  private readonly muteButton=document.createElement('button');
  private readonly volume=document.createElement('input');
  private readonly message=document.createElement('small');
  private readonly planner=new AudioFramePlanner();
  private context:AudioContext|null=null;
  private master:GainNode|null=null;
  private compressor:DynamicsCompressorNode|null=null;
  private owner:PlaySession|null=null;
  private run=-1;
  private config:GameplayAudioConfig|null=null;
  private generation=0;
  private abort:AbortController|null=null;
  private buffers=new Map<string,Loaded>();
  private loops=new Map<string,Voice>();
  private voices=new Set<Voice>();
  private selections=new Map<string,number>();
  private lastCueAt=new Map<string,number>();
  private pending=0;
  private bytes=0;
  private userGain=1;
  private muted=false;
  private gesture=false;
  private failures:string[]=[];
  private played:Record<string,number>={};
  private peakVoices=0;
  private skipped=0;
  private randomState=0x7432121;
  private listener:[number,number,number]=[0,0,0];
  private yaw=0;
  constructor(){
    this.control.className='game-audio';this.panel.className='game-audio-panel';
    this.volume.type='range';this.volume.min='0';this.volume.max='1';this.volume.step='.05';this.volume.value='1';
    this.volume.oninput=()=>{this.userGain=Number(this.volume.value);this.applyGain();};
    this.muteButton.onclick=()=>{this.muted=!this.muted;this.applyGain();void this.unlock();};
    this.panel.append(this.muteButton,this.volume,this.message);this.control.append(this.title,this.panel);
    const gesture=(e:Event)=>{if(e.isTrusted){this.gesture=true;void this.unlock();}};
    document.addEventListener('pointerdown',gesture,{capture:true});document.addEventListener('keydown',gesture,{capture:true});
    document.addEventListener('visibilitychange',()=>{if(document.hidden)this.stopVoices();});
  }
  private report(e:unknown):void {const text=String(e);if(!this.failures.includes(text))this.failures.push(text);if(this.failures.length>8)this.failures.shift();}
  async unlock():Promise<void>{
    if(!this.context || this.context.state==='closed')return;
    try {await this.context.resume();}catch(e){this.report(e);}
  }
  private applyGain():void {if(this.context && this.master)this.master.gain.setTargetAtTime(this.muted?0:(this.config?.masterGain??0)*this.userGain,this.context.currentTime,.015);}
  private attach(session:PlaySession,config:GameplayAudioConfig):void {
    this.release();this.failures=[];this.config=config;this.run=session.runtime!.runId;
    if(this.owner!==session){this.owner=session;session.registerResource('game-audio',()=>{this.release();this.owner=null;});}
    if(!config.enabled)return;
    try {
      this.context=new AudioContext({sampleRate:48000});this.master=this.context.createGain();this.compressor=this.context.createDynamicsCompressor();
      this.compressor.threshold.value=-10;this.compressor.knee.value=12;this.compressor.ratio.value=4;
      this.master.connect(this.compressor);this.compressor.connect(this.context.destination);this.applyGain();
      this.abort=new AbortController();const epoch=this.generation,context=this.context;
      const refs=[...new Map(config.cues.flatMap(c=>c.variants).map(ref=>[ref.guid,ref])).values()];this.pending=refs.length;
      for(const ref of refs)void (async()=>{
        try {
          const resource=audioResource(ref),response=await fetch(resource.url,{signal:this.abort!.signal});
          if(!response.ok)throw new Error(`${response.status}: ${ref.path}`);
          const buffer=await context.decodeAudioData(await response.arrayBuffer());
          if(epoch!==this.generation)return;
          const info=resource.info,size=buffer.length*buffer.numberOfChannels*4;
          if(buffer.numberOfChannels!==info.channels || Math.abs(buffer.duration-info.frames/info.sampleRate)>.001)throw new Error(`Decoded audio metadata mismatch: ${ref.path}`);
          if(this.bytes+size>config.decodedBudgetMiB*1048576)throw new Error(`Audio memory budget exceeded: ${ref.path}`);
          this.bytes+=size;this.buffers.set(ref.guid!,{buffer,start:(info.loopStartSample??0)/info.sampleRate,end:(info.loopEndSample??info.frames)/info.sampleRate});
        }catch(e){if(epoch===this.generation)this.report(e);}finally{if(epoch===this.generation)this.pending--;}
      })();
      if(this.gesture)void this.unlock();
    }catch(e){this.report(e);}
  }
  private position(v:Voice):void {
    const p=v.request.position,ctx=this.context!;
    let attenuation=1,pan=0;
    if(p){const dx=p[0]-this.listener[0],dz=p[2]-this.listener[2],distance=Math.hypot(dx,dz);
      attenuation=Math.max(0,1-distance/(this.config?.distanceM??1));pan=Math.max(-1,Math.min(1,(dx*Math.cos(this.yaw)-dz*Math.sin(this.yaw))/8));}
    const cue=this.config!.cues.find(c=>c.id===v.request.binding.cue)!;
    v.gain.gain.setTargetAtTime(cue.gain*v.request.binding.gain*attenuation,ctx.currentTime,cue.loop?.01:.003);
    v.pan.pan.setTargetAtTime(pan,ctx.currentTime,.01);
  }
  private start(req:AudioRequest):Voice|null {
    const ctx=this.context,config=this.config;
    if(!ctx || !config || ctx.state!=='running' || this.muted || document.hidden)return null;
    const cue=config.cues.find(c=>c.id===req.binding.cue);if(!cue)return null;
    if(req.position && Math.hypot(req.position[0]-this.listener[0],req.position[2]-this.listener[2])>=config.distanceM)return null;
    const cooldownKey=cue.id;const last=this.lastCueAt.get(cooldownKey)??-Infinity;
    if(!cue.loop && ctx.currentTime-last<cue.cooldownSec)return null;
    let random=this.randomState;random^=random<<13;random^=random>>>17;random^=random<<5;this.randomState=random>>>0;
    const previous=this.selections.get(cue.id)??-1;
    const index=cue.variants.length===1?0:previous<0?this.randomState%cue.variants.length:(previous+1+this.randomState%(cue.variants.length-1))%cue.variants.length;
    const loaded=this.buffers.get(cue.variants[index]!.guid!);
    if(!loaded){this.skipped++;return null;}
    const impacts=[...this.voices].filter(v=>v.bus==='impact');
    if(cue.bus==='impact' && impacts.length>=config.maxImpactVoices)return null;
    if(this.voices.size>=config.maxVoices){
      const quiet=[...this.voices].sort((a,b)=>a.priority-b.priority)[0]!;
      if(quiet.priority>=cue.priority)return null;quiet.stop(true);
    }
    this.selections.set(cue.id,index);this.lastCueAt.set(cooldownKey,ctx.currentTime);
    const source=ctx.createBufferSource(),gain=ctx.createGain(),pan=ctx.createStereoPanner();
    gain.gain.value=0;
    source.buffer=loaded.buffer;source.loop=cue.loop;source.loopStart=loaded.start;source.loopEnd=loaded.end;source.playbackRate.value=req.binding.rate;
    source.connect(gain);gain.connect(pan);pan.connect(this.master!);
    let stopped=false,ending=false;
    const voice:Voice={source,gain,pan,priority:cue.priority,bus:cue.bus,request:req,stop:(immediate=false)=>{
      if(stopped)return;
      if(!immediate){if(ending)return;ending=true;gain.gain.cancelScheduledValues(ctx.currentTime);gain.gain.setTargetAtTime(0,ctx.currentTime,.003);source.stop(ctx.currentTime+.015);}
      else {stopped=true;try{source.stop();}catch{/* Already ended. */}source.disconnect();gain.disconnect();pan.disconnect();this.voices.delete(voice);}
      for(const [key,v] of this.loops)if(v===voice)this.loops.delete(key);
    }};
    source.onended=()=>voice.stop(true);this.voices.add(voice);this.position(voice);source.start();
    this.played[cue.id]=(this.played[cue.id]??0)+1;this.peakVoices=Math.max(this.peakVoices,this.voices.size);return voice;
  }
  update(session:PlaySession,yaw:number):void {
    const r=session.runtime,config=r?.desc.runRules?.audio;
    this.control.hidden=!config;
    if(!r || !config){if(this.context)this.release();this.ui();return;}
    if(this.run!==r.runId)this.attach(session,config);
    this.yaw=yaw;const p=r.player();if(p)this.listener=[p.x,0,p.z];
    const suspended=session.state!=='playing' || document.hidden;
    const frame=this.planner.update(r,config,suspended);
    const desired=new Set(frame.loops.map(req=>req.key));
    if(suspended || r.outcome!=='running' || this.muted)this.stopVoices();
    else {
      for(const [key,voice] of this.loops)if(!desired.has(key))voice.stop();
      for(const req of frame.loops){const v=this.loops.get(req.key);if(v){v.request=req;this.position(v);}else {const voice=this.start(req);if(voice)this.loops.set(req.key,voice);}}
      for(const req of frame.shots)this.start(req);
    }
    this.ui();
  }
  private stopVoices():void {for(const v of [...this.voices])v.stop(true);this.loops.clear();}
  private release():void {
    this.generation++;this.abort?.abort();this.abort=null;this.stopVoices();
    const context=this.context;this.context=null;if(context && context.state!=='closed')void context.close().catch(()=>{});
    this.master?.disconnect();this.compressor?.disconnect();this.master=null;this.compressor=null;
    this.buffers.clear();this.bytes=0;this.pending=0;this.run=-1;this.config=null;this.planner.reset();this.selections.clear();this.lastCueAt.clear();
  }
  private ui():void {
    const label=this.muted?'声音：关':this.failures.length?'声音：部分缺失':this.pending?'声音：加载中':this.context?.state==='running'?'声音：开':'声音：点击开启';
    const title=g(label),mute=g(this.muted?'开启声音':'关闭声音'),message=this.failures.join('\n');
    if(this.title.textContent!==title)this.title.textContent=title;
    if(this.muteButton.textContent!==mute)this.muteButton.textContent=mute;
    this.volume.setAttribute('aria-label',g('音量'));
    if(this.message.textContent!==message)this.message.textContent=message;
  }
  snapshot(){return {state:this.context?.state??'closed',runId:this.run,pending:this.pending,buffers:this.buffers.size,decodedBytes:this.bytes,voices:this.voices.size,loops:this.loops.size,peakVoices:this.peakVoices,played:{...this.played},skipped:this.skipped,muted:this.muted,gain:this.userGain,errors:[...this.failures]};}
}
