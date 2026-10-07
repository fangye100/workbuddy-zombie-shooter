/** Offline art authoring only. Scene files remain the runtime source of truth. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {authoredGlb,pngRgb} from '../level/authored-glb.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const write=(p,v)=>fs.writeFileSync(path.join(root,p),JSON.stringify(v,null,2)+'\n');
const hash=b=>createHash('sha256').update(b).digest('hex');
const template=read('assets/art/models/ENV-MID-01/game_ready/ENV-MID-01_lod0.glb.meta.json');
function asset(file,bytes){
 const absolute=path.join(root,file);fs.mkdirSync(path.dirname(absolute),{recursive:true});fs.writeFileSync(absolute,bytes);
 const side=absolute+'.meta.json';
 const meta=fs.existsSync(side)?JSON.parse(fs.readFileSync(side,'utf8')):{...structuredClone(template),guid:'as_'+hash(Buffer.from(file)).slice(0,12),bindings:[],rig:null,animations:null,userData:{}};
 meta.sourceHash='sha256:'+hash(bytes);meta.userData={...meta.userData,status:'authored',provenance:'tools/art/refine-streets.mjs'};
 meta.importer={...meta.importer,normalizeHeightM:null,upAxisFlip:false};write(file+'.meta.json',meta);
 return {path:file,guid:meta.guid};
}
const texture=(kind)=>pngRgb(1024,kind==='yard'?1024:512,(x,y)=>{
 const grain=((Math.imul(x+7,374761393)^Math.imul(y+19,668265263))>>>0)%7-3;
 const tile=kind==='paving'?(x%64<2||y%64<2?-14:0):kind==='yard'?(x%8<1||y%8<1?-13:0):0;
 const patch=kind==='yard'&&((Math.floor(x/170)+Math.floor(y/95))%5===2)?-7:0;
 const base=(kind==='paving'?131:kind==='yard'?99:79)+grain+tile+patch;
 return [base-3,base,base+1];
});
function meshBoxes(name,boxes,png){
 const p=[],n=[],uv=[],ix=[];
 const faces=[[[1,0,0],[[1,-1,-1],[1,1,-1],[1,1,1],[1,-1,1]]],
 [[-1,0,0],[[-1,-1,1],[-1,1,1],[-1,1,-1],[-1,-1,-1]]],
 [[0,1,0],[[-1,1,-1],[-1,1,1],[1,1,1],[1,1,-1]]],
 [[0,-1,0],[[-1,-1,1],[-1,-1,-1],[1,-1,-1],[1,-1,1]]],
 [[0,0,1],[[1,-1,1],[1,1,1],[-1,1,1],[-1,-1,1]]],
 [[0,0,-1],[[-1,-1,-1],[-1,1,-1],[1,1,-1],[1,-1,-1]]]];
 for(const {position,size,uvRect=[0,0,1,1]} of boxes)for(const [normal,corners]of faces){const start=p.length/3;
  corners.forEach((c,k)=>{p.push(...c.map((v,a)=>v*size[a]/2+position[a]));n.push(...normal);const t=[[0,0],[0,1],[1,1],[1,0]][k];uv.push(uvRect[0]+t[0]*(uvRect[2]-uvRect[0]),uvRect[1]+t[1]*(uvRect[3]-uvRect[1]));});
  ix.push(start,start+1,start+2,start,start+2,start+3);
 }
 return authoredGlb(name,p,n,uv,ix,png);
}
function material(color,extra={}){return [{match:{by:'index',value:0},material:{type:'override',base:{type:'shared',id:'s1'},patch:{
 albedo:color,roughness:.96,metallic:0,specMix:0,outlineScale:.12,halftoneScale:.05,...extra}}}];}
function ref(file){return {path:file,guid:read(file+'.meta.json').guid};}
export function refineStreet(doc){
 const depth=Number(/floor(\d+)/.exec(doc.id)?.[1]),prefix=`nd_f${depth}`;
 if(![1,2,3].includes(depth))throw new Error('Unsupported street scene');
 const find=id=>doc.nodes.find(n=>n.id===id),mesh=n=>n.components.find(c=>c.kind==='MeshRenderer');
 // Merge only unreferenced, mesh-only, axis-aligned decoration. Never gameplay nodes.
 for(const [kind,pattern]of [['curbs',/_curb_[-1]+$/],['paint',/_(?:lane_\d+|edge_[ns])$/],['walks',/_walk_[-1]+$/]]){
  const members=doc.nodes.filter(n=>pattern.test(n.id)&&mesh(n)?.source.type==='builtin');
  if(!members.length)continue; // Already baked: retain stable author identities and bytes.
  const removed=new Set(members.slice(1).map(n=>n.id));
  const outside=JSON.stringify(doc.nodes.filter(n=>!members.includes(n)));
  if([...removed].some(id=>outside.includes(JSON.stringify(id))))throw new Error('Referenced decoration cannot be combined');
  const boxes=members.map(n=>{
   if(n.components.length!==1||mesh(n).source.type!=='builtin'||mesh(n).source.shape!=='box'||JSON.stringify(n.transform.rotation)!=='[0,0,0,1]')throw new Error(`Nondecorative or transformed batch input: ${n.id}`);
   const position=[...n.transform.position];if(n.parent){const parent=find(n.parent);if(!parent||parent.parent||JSON.stringify(parent.transform.rotation)!=='[0,0,0,1]'||JSON.stringify(parent.transform.scale)!=='[1,1,1]')throw new Error('Unsupported decoration parent');for(let a=0;a<3;a++)position[a]+=parent.transform.position[a];}
   return {position,size:mesh(n).source.params.map((v,a)=>v*n.transform.scale[a]),...(kind==='paint'?{uvRect:n.id.includes('_lane_')?[.125,.25,.375,.75]:[.625,.25,.875,.75]}:{})};
  });
  // Continuous raised sidewalk, including room-to-room and entry/exit gaps.
  if(kind==='walks')boxes.splice(0,boxes.length,{position:[33,.045,-9.7],size:[160,.22,2.8]},{position:[33,.045,9.7],size:[160,.22,2.8]});
  const file=`assets/art/models/streets/game_ready/floor-${depth}-${kind}.glb`;
  const source=asset(file,meshBoxes(`${doc.id} ${kind}`,boxes,kind==='paint'?pngRgb(32,16,x=>x<16?[190,140,42]:[207,204,186]):texture('paving')));
  const anchor=members[0];anchor.parent=null;anchor.transform={position:[0,0,0],rotation:[0,0,0,1],scale:[1,1,1]};
  anchor.name=kind==='walks'?'连续铺装人行道':kind==='paint'?'道路涂装 · 合批':'连续路缘 · 合批';
  mesh(anchor).source={type:'asset',ref:source};mesh(anchor).importScale=1;mesh(anchor).materials=material('#ffffff',{outlineScale:0,halftoneScale:0});
  doc.nodes=doc.nodes.filter(n=>!removed.has(n.id));
 }
 // GLB import centers X/Z and grounds Y even when metric scale is retained.
 // Restore the baked world pivot through the scene transform, not loader state.
 for(const kind of ['curbs','paint','walks']){
  const file=`assets/art/models/streets/game_ready/floor-${depth}-${kind}.glb`;
  const anchor=doc.nodes.find(n=>mesh(n)?.source.ref?.path===file);
  if(!anchor)throw new Error(`Missing street batch ${kind}`);
  const bytes=fs.readFileSync(path.join(root,file));
  const json=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());
  const bounds=json.accessors[json.meshes[0].primitives[0].attributes.POSITION];
  anchor.transform.position=[(bounds.min[0]+bounds.max[0])/2,bounds.min[1],(bounds.min[2]+bounds.max[2])/2];
 }
 const yard=find(`${prefix}_void`);
 const yardSource=asset(`assets/art/models/streets/game_ready/floor-${depth}-yard.glb`,meshBoxes('Street apron',[{position:[0,0,0],size:[190,.12,250]}],texture('yard')));
 mesh(yard).source={type:'asset',ref:yardSource};mesh(yard).materials=material('#c3c9ca',{outlineScale:0,halftoneScale:0});yard.transform.scale=[1,1,1];yard.transform.position=[33,-.14,-30];
 // Hide semantic floor projections only in Play; the single street underlay prevents seams.
 for(const n of doc.nodes.filter(n=>/^nd_f\d[rc]\d$/.test(n.id)))mesh(n).editorOnly=true;
 const road=pngRgb(2048,512,(x,y)=>{
  const grain=((Math.imul(x+11,374761393)^Math.imul(y+29,668265263))>>>0)%5-2;
  const repair=(Math.floor(x/340)%3===1&&y>180&&y<280)?-9:0;
  const seam=Math.abs(y-(280+25*Math.sin(x*.018)+6*Math.sin(x*.05)))<1.5?-16:0;
  const hatch=repair&&((x+y)%28<2)?-4:0;
  const base=77+grain+repair+seam+hatch;return[base-6,base,base+4];
 });
 const street=find(`${prefix}_street`);
 mesh(street).source={type:'asset',ref:asset(`assets/art/models/streets/game_ready/floor-${depth}-road.glb`,meshBoxes('Continuous hand-painted asphalt',[{position:[0,0,0],size:[160,.12,18]}],road))};
 street.transform.position=[33,-.12,0];street.transform.scale=[1,1,1];mesh(street).materials=material('#ffffff',{outlineScale:0,halftoneScale:.04});
 function place(id,assetId,lod,x,z,{yaw=0,scale=1,color='#ffffff',name}={}){
  let node=find(id);if(!node){node={id,parent:null,prefab:null,components:[]};doc.nodes.push(node);}
  Object.assign(node,{name:name??`${assetId} · 街区`,parent:null,visible:true,pickable:true,category:assetId.includes('FAR')?'远景':'街景',
   transform:{position:[x,0,z],rotation:[0,Math.sin(yaw/2),0,Math.cos(yaw/2)],scale:[scale,scale,scale]},
   components:[{kind:'MeshRenderer',enabled:true,visible:true,layer:3,importScale:1,
    source:{type:'asset',ref:ref(`assets/art/models/${assetId}/game_ready/${assetId}_lod${lod}.glb`)},
    aoMin:0,aoMax:.55,materials:material(color,{outlineScale:assetId.includes('FAR')?0:.12,halftoneScale:.04})}]});
 }
 const row=depth===1?['ENV-MID-03','ENV-MID-01','ENV-MID-02','ENV-MID-04','ENV-MID-03','ENV-MID-04','ENV-MID-01']:
  depth===2?['ENV-MID-04','ENV-MID-03','ENV-MID-04','ENV-MID-04','ENV-MID-03','ENV-MID-04','ENV-MID-03']:
  ['ENV-MID-03','ENV-MID-01','ENV-MID-02','ENV-MID-04','ENV-MID-01','ENV-MID-03','ENV-MID-02'];
 const xs=[-25,-7,14,36,58,80,103];
 row.forEach((id,i)=>place(i===1?`${prefix}_art_mid01`:i===2?`${prefix}_art_mid02`:i===4?`${prefix}_art_mid03`:`${prefix}_street_building_${i}`,id,1,xs[i],-19.5,{color:depth===3?'#e7eaf6':'#ffffff'}));
 place(`${prefix}_backdrop`,'ENV-FAR-01',1,0,-63,{scale:.85,color:'#c5d5e2'});
 place(`${prefix}_art_far_repeat`,'ENV-FAR-01',2,76,-65,{scale:.85,color:'#c5d5e2'});
 place(`${prefix}_art_far02`,'ENV-FAR-02',1,35,-100,{scale:.6,color:'#b8c9dc'});
 // Low foreground boundaries stay below player/interaction sightlines.
 for(let i=0;i<8;i++)place(`${prefix}_street_wall_${i}`,'ENV-MID-05',2,-21+i*17,13.5,{scale:.62,yaw:i%2?Math.PI:0,color:'#d7d4cd',name:'破损砖墙 · 街区前景边界'});
 place(`${prefix}_street_overpass`,'ENV-MID-06',1,-30,-3,{yaw:Math.PI/2,scale:.8,color:'#d5e2e2',name:'高架桥 · 城市入口'});
 doc.environment.comic={...doc.environment.comic,contactShadowOpacity:.48,halftoneStrength:.1};
 doc.environment.hemisphere={...doc.environment.hemisphere,skyIntensity:.36,groundIntensity:.18};
 const paths=new Set();
 const visit=value=>{if(!value||typeof value!=='object')return;if(typeof value.path==='string'&&typeof value.guid==='string')paths.add(value.path);for(const child of Object.values(value))visit(child);};
 visit(doc.nodes);visit(doc.environment);doc.dependencies=[...paths];
 const count=doc.nodes.filter(n=>mesh(n)).length;if(count>64)throw new Error(`Static budget exceeded ${doc.id}: ${count}`);
 return doc;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))for(const depth of [1,2,3]){
 const file=`assets/scenes/act1/floor-${depth}.scene.json`;write(file,refineStreet(read(file)));
 console.log(file,'static',read(file).nodes.filter(n=>n.components.some(c=>c.kind==='MeshRenderer')).length);
}
