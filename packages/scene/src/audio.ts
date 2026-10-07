import type { AssetRef } from './document';

export interface AudioAssetInfo {
  sampleRate: number; frames: number; channels: number; bitDepth: number;
  loopStartSample: number | null; loopEndSample: number | null;
}
export function validAudioAssetInfo(value: unknown): value is AudioAssetInfo {
  if (!value || typeof value !== 'object') return false;
  const a=value as AudioAssetInfo;
  return Number.isInteger(a.sampleRate) && a.sampleRate>=8000 && a.sampleRate<=192000
    && Number.isInteger(a.frames) && a.frames>0 && a.frames<=a.sampleRate*120
    && [1,2].includes(a.channels) && [16,24,32].includes(a.bitDepth)
    && (a.loopStartSample===null && a.loopEndSample===null || Number.isInteger(a.loopStartSample) && Number.isInteger(a.loopEndSample)
      && a.loopStartSample!>=0 && a.loopStartSample!<a.loopEndSample! && a.loopEndSample!<=a.frames);
}
export interface AudioCue {
  id:string; variants:AssetRef[]; loop:boolean; gain:number; priority:number;
  cooldownSec:number; bus:'weapon'|'impact'|'enemy'|'ambience';
}
export interface AudioBinding { cue:string; rate:number; gain:number }
export interface GameplayAudioConfig {
  enabled:boolean; masterGain:number; maxVoices:number; maxImpactVoices:number;
  decodedBudgetMiB:number; distanceM:number; warningDistanceM:number;
  cues:AudioCue[];
  ambience:AudioBinding|null;
  weapons:Record<string,{fire:AudioBinding|null;loop:AudioBinding|null}>;
  warnings:Record<string,AudioBinding>;
  fleshHit:AudioBinding|null; acidLaunch:AudioBinding|null; acidPool:AudioBinding|null;
}
const n=(x:unknown,min:number,max:number):x is number=>typeof x==='number' && Number.isFinite(x) && x>=min && x<=max;
export function validGameplayAudio(value:unknown):value is GameplayAudioConfig {
  if(!value || typeof value!=='object')return false;
  const a=value as GameplayAudioConfig;
  if(typeof a.enabled!=='boolean' || !n(a.masterGain,0,1) || !Number.isInteger(a.maxVoices) || !n(a.maxVoices,1,64)
    || !Number.isInteger(a.maxImpactVoices) || !n(a.maxImpactVoices,1,a.maxVoices) || !n(a.decodedBudgetMiB,1,64)
    || !n(a.distanceM,1,100) || !n(a.warningDistanceM,1,100) || !Array.isArray(a.cues) || a.cues.length<1 || a.cues.length>128)return false;
  const ids=new Set<string>();
  for(const c of a.cues){
    if(!c || typeof c.id!=='string' || !/^SFX-[A-Z0-9-]+$/.test(c.id) || ids.has(c.id) || typeof c.loop!=='boolean'
      || !n(c.gain,0,1) || !Number.isInteger(c.priority) || !n(c.priority,0,10) || !n(c.cooldownSec,0,10)
      || !['weapon','impact','enemy','ambience'].includes(c.bus) || !Array.isArray(c.variants) || c.variants.length<1 || c.variants.length>16)return false;
    ids.add(c.id);
    for(const r of c.variants)if(!r || typeof r.path!=='string' || !r.path.startsWith('assets/audio/') || !r.path.endsWith('.wav')
      || r.path.includes('\\') || r.path.split('/').some(p=>!p || p==='.' || p==='..') || typeof r.guid!=='string' || !r.guid)return false;
  }
  const binding=(b:AudioBinding|null,loop:boolean)=>b===null || !!b && ids.has(b.cue) && n(b.rate,.5,2) && n(b.gain,0,1) && a.cues.find(c=>c.id===b.cue)!.loop===loop;
  if(!binding(a.ambience,true) || !binding(a.fleshHit,false) || !binding(a.acidLaunch,false) || !binding(a.acidPool,true))return false;
  if(!a.weapons || Array.isArray(a.weapons) || typeof a.weapons!=='object' || !a.warnings || Array.isArray(a.warnings) || typeof a.warnings!=='object')return false;
  return Object.entries(a.weapons).every(([id,w])=>/^[a-z][a-z0-9-]{0,63}$/.test(id) && !!w && binding(w.fire,false) && binding(w.loop,true))
    && Object.entries(a.warnings).every(([id,b])=>/^[EB]-\d{2}$/.test(id) && b!==null && binding(b,false));
}
