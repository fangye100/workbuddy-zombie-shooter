/** Small deterministic asset writer; content and placements are supplied by authoring tools. */
import { deflateSync } from 'node:zlib';
export function pngRgb(width,height,pixel) {
  const raw=Buffer.alloc((width*3+1)*height);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const rgb=pixel(x,y),at=y*(width*3+1)+1+x*3;
    for(let c=0;c<3;c++)raw[at+c]=Math.round(Math.max(0,Math.min(255,rgb[c])));
  }
  function chunk(type,data){
    const body=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;
    for(const byte of body){crc^=byte;for(let i=0;i<8;i++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;}
    const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);body.copy(b,4);b.writeUInt32BE((crc^0xffffffff)>>>0,b.length-4);return b;
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
export function authoredGlb(name,positions,normals,uvs,indices,png) {
  const p=new Float32Array(positions),n=new Float32Array(normals),uv=new Float32Array(uvs),ix=new Uint32Array(indices);
  const parts=[Buffer.from(p.buffer),Buffer.from(n.buffer),Buffer.from(uv.buffer),Buffer.from(ix.buffer),png];
  let offset=0;const views=parts.map(bytes=>{const v={buffer:0,byteOffset:offset,byteLength:bytes.length};offset+=(bytes.length+3)&~3;return v;});
  const bin=Buffer.alloc(offset);parts.forEach((bytes,i)=>bytes.copy(bin,views[i].byteOffset));
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(let i=0;i<p.length;i++){const k=i%3;min[k]=Math.min(min[k],p[i]);max[k]=Math.max(max[k],p[i]);}
  const json={asset:{version:'2.0',generator:'Aether authored comic backdrop v1'},scene:0,scenes:[{nodes:[0]}],nodes:[{name,mesh:0}],
    meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:1,TEXCOORD_0:2},indices:3,material:0}]}],
    accessors:[{bufferView:0,componentType:5126,count:p.length/3,type:'VEC3',min,max},{bufferView:1,componentType:5126,count:n.length/3,type:'VEC3'},
      {bufferView:2,componentType:5126,count:uv.length/2,type:'VEC2'},{bufferView:3,componentType:5125,count:ix.length,type:'SCALAR'}],
    bufferViews:views,buffers:[{byteLength:bin.length}],materials:[{name,pbrMetallicRoughness:{baseColorTexture:{index:0},metallicFactor:0,roughnessFactor:1}}],
    textures:[{source:0}],images:[{bufferView:4,mimeType:'image/png'}]};
  const raw=Buffer.from(JSON.stringify(json)),js=Buffer.alloc((raw.length+3)&~3,32);raw.copy(js);
  const glb=Buffer.alloc(28+js.length+bin.length);glb.writeUInt32LE(0x46546c67);glb.writeUInt32LE(2,4);glb.writeUInt32LE(glb.length,8);
  glb.writeUInt32LE(js.length,12);glb.writeUInt32LE(0x4e4f534a,16);js.copy(glb,20);glb.writeUInt32LE(bin.length,20+js.length);glb.writeUInt32LE(0x004e4942,24+js.length);bin.copy(glb,28+js.length);
  return glb;
}
