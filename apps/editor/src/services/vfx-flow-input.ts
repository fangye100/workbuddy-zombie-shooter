import type {VfxEffectDefinition} from '@aether/scene';

/** Parse before editing the source/history: only an explicit finite zero disables flow. */
export function parseVfxFlowInput(strengthText:string,speedText:string):VfxEffectDefinition['flow'] {
  const number=(text:string,label:string,min:number,max:number)=>{
    const raw=text.trim(),value=Number(raw);
    if(!raw || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw) || !Number.isFinite(value) || value<min || value>max)
      throw new Error(`${label}必须是 ${min}–${max} 的有限数值；保留原配置与未应用草稿`);
    return value;
  };
  const strength=number(strengthText,'流动强度',0,.6);
  return strength===0?undefined:{strength,speed:number(speedText,'流动速度',.1,8)};
}
