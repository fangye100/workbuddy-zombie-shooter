import { describe, it, expect, vi, afterEach } from 'vitest';
import { PlaySession } from '@aether/zombie-game';
import type { SceneDocument } from '@aether/scene';
vi.mock("../../src/presentation/game-audio-assets",()=>({audioResource:()=>({url:'/test.wav',info:{sampleRate:48000,frames:4800,channels:1,bitDepth:24,loopStartSample:null,loopEndSample:null}})}));
vi.mock("../../src/presentation/game-language",()=>({gameText:(s:string)=>s}));
import { GameAudio } from "../../src/presentation/game-audio";
const scenes=import.meta.glob("../../../../assets/scenes/act1/floor-1.scene.json",{eager:true,import:'default'});
class Node {
  gain={value:0,setTargetAtTime:vi.fn(),cancelScheduledValues:vi.fn()};pan=this.gain;threshold=this.gain;knee=this.gain;ratio=this.gain;playbackRate=this.gain;
  onended:(()=>void)|null=null;connect=vi.fn();disconnect=vi.fn();start=vi.fn();stop=vi.fn();
}
class Context {
  state='suspended';currentTime=0;destination={};close=vi.fn(async()=>{this.state='closed';});resume=vi.fn(async()=>{this.state='running';});
  createGain=()=>new Node();createDynamicsCompressor=()=>new Node();createStereoPanner=()=>new Node();createBufferSource=()=>new Node();
  decodeAudioData=vi.fn(async()=>({length:4800,numberOfChannels:1,duration:.1}));
}
function setup(fetcher:()=>Promise<unknown>) {
  vi.stubGlobal('document',{hidden:false,addEventListener:vi.fn(),createElement:()=>({append:vi.fn(),setAttribute:vi.fn()})});
  const contexts:Context[]=[];
  vi.stubGlobal('AudioContext',class extends Context {constructor(){super();contexts.push(this);}});
  vi.stubGlobal('fetch',fetcher);
  const doc=structuredClone(Object.values(scenes)[0] as SceneDocument);
  const rules=doc.nodes.flatMap(n=>n.components).find(c=>c.kind==='RunRules')!;
  if(rules.kind==='RunRules'){
    // One one-shot cue; fake decoding verifies lifecycle rather than actual source metrics.
    const a=rules.audio!;a.cues=[a.cues[0]!];a.cues[0]!.variants=[a.cues[0]!.variants[0]!];a.ambience=null;a.weapons={pistol:{fire:{cue:a.cues[0]!.id,rate:1,gain:1},loop:null}};a.warnings={};a.fleshHit=null;a.acidLaunch=null;a.acidPool=null;
  }
  const session=new PlaySession();expect(session.play(doc).ok).toBe(true);
  const audio=new GameAudio();audio.update(session,0);
  return {audio,session,contexts};
}
const response=()=>Promise.resolve({ok:true,arrayBuffer:async()=>new ArrayBuffer(1)});
afterEach(()=>vi.unstubAllGlobals());
describe('browser audio lifecycle',()=>{
  it('balances the resource ledger, closes context and ignores decoding after Stop',async()=>{
    let resolve!:(v:unknown)=>void;
    const {audio,session,contexts}=setup(()=>new Promise(r=>{resolve=r;}));
    expect(audio.snapshot().pending).toBe(1);expect(session.ledger.pending).toBe(1);
    session.stop();resolve({ok:true,arrayBuffer:async()=>new ArrayBuffer(1)});
    await vi.waitFor(()=>expect(contexts[0]!.decodeAudioData).toHaveBeenCalled());
    expect(contexts[0]!.close).toHaveBeenCalledOnce();expect(audio.snapshot()).toMatchObject({state:'closed',buffers:0,pending:0,voices:0,loops:0,decodedBytes:0});
    expect(session.ledger).toEqual({registered:1,disposed:1,pending:0});
  });
  it('reports failed requests without interrupting simulation and recovers on a new run',async()=>{
    const {audio,session,contexts}=setup(()=>Promise.reject(new Error('missing WAV')));
    await vi.waitFor(()=>expect(audio.snapshot().pending).toBe(0));
    expect(audio.snapshot().errors.join()).toContain('missing WAV');expect(session.state).toBe('playing');
    vi.stubGlobal('fetch',response);session.reset();audio.update(session,0);
    await vi.waitFor(()=>expect(audio.snapshot().buffers).toBe(1));
    expect(contexts[0]!.close).toHaveBeenCalledOnce();expect(audio.snapshot().errors).toEqual([]);expect(session.ledger.registered).toBe(1);session.stop();
  });
  it('stops active one-shots on pause, without replay on resume',async()=>{
    const {audio,session}=setup(response);await vi.waitFor(()=>expect(audio.snapshot().buffers).toBe(1));await audio.unlock();
    session.runtime!.setFire(true);session.runtime!.step();audio.update(session,0);
    expect(audio.snapshot().voices).toBe(1);session.pause();audio.update(session,0);expect(audio.snapshot().voices).toBe(0);
    session.resume();audio.update(session,0);expect(audio.snapshot().voices).toBe(0);expect(audio.snapshot().played['SFX-WPN-PISTOL-SHOT']).toBe(1);session.stop();
  });
});
