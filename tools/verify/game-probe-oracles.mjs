import fs from 'node:fs';

export const GAME_PROBE_SCENE='assets/scenes/sandbox/game-probes.scene.json';
export const readProbeScene=scene=>JSON.parse(fs.readFileSync(scene,'utf8'));

/** 独立按稳定父引用归组，不复用被测运行时的wave分派结果作为期望。 */
export function roomWaves(doc,roomId) {
  const byId=new Map(doc.nodes.map(n=>[n.id,n]));
  const waves=new Map();
  for(const node of doc.nodes)for(const spawn of node.components){
    if(spawn.kind!=='SpawnPoint'||!spawn.enabled||spawn.trigger!=='room-enter'||spawn.count<=0)continue;
    let parent=byId.get(node.parent),room=null;const seen=new Set();
    while(parent&&!seen.has(parent.id)){
      seen.add(parent.id);
      if(parent.components.some(c=>c.kind==='RoomVolume')){room=parent.id;break;}
      parent=byId.get(parent.parent);
    }
    if(room!==roomId)continue;
    const wave=Math.max(1,Math.trunc(spawn.wave));
    const group=waves.get(wave)??{};
    group[spawn.characterId]=(group[spawn.characterId]??0)+spawn.count;waves.set(wave,group);
  }
  return [...waves].sort((a,b)=>a[0]-b[0]).map(([wave,counts])=>({wave,counts,total:Object.values(counts).reduce((a,b)=>a+b,0)}));
}

export function actorDemand(doc,manifest) {
  const demand=new Set(doc.nodes.flatMap(n=>n.components.filter(c=>c.kind==='SpawnPoint'&&c.enabled&&c.count>0).map(c=>c.characterId)));
  const rigged=new Set(manifest.characters.filter(c=>c.lods?.some(l=>l.label.includes('+动画')||l.label.includes('+骨骼'))).map(c=>c.id));
  return {actors:[...demand].filter(id=>rigged.has(id)).sort(),missing:[...demand].filter(id=>!rigged.has(id)).sort()};
}

export function sameCounts(actual,expected) {
  const sorted=counts=>Object.entries(counts).sort(([a],[b])=>a.localeCompare(b));
  return JSON.stringify(sorted(actual))===JSON.stringify(sorted(expected));
}

/** GPU实例的精确局部pose/全局矩阵边界，未知/NaN/u32溢出不能放过。 */
export function validSkinRow(row,actor,totalMatrices) {
  if(!actor)return row.flags===0&&row.base===0&&row.stride===0&&row.pose===0;
  const {base,poses,joints}=actor;
  return row.flags===1&&row.base===base&&row.stride===joints&&
    Number.isInteger(row.pose)&&row.pose>=0&&row.pose<poses&&
    base+(row.pose+1)*joints<=base+poses*joints&&base+(row.pose+1)*joints<=totalMatrices;
}

/** 故障只能落在受控GET GLB请求；meta/BVH/其他角色及其他接口一律继续。 */
export function shouldFailAssetRequest(request,assetPath) {
  try {const url=new URL(request.url);return request.method==='GET'&&url.pathname==='/__fs/file'&&url.searchParams.get('path')===assetPath;}
  catch{return false;}
}
