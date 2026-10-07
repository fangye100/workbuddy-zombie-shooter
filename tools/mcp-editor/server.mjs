/** MCP stdio adapter. No business state, filesystem authoring or browser automation. */
import { EDITOR_INSTRUCTIONS } from './workflow.mjs';
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const arg = (name, fallback) => { const i=process.argv.indexOf(name); return i<0?fallback:process.argv[i+1]; };
const base = new URL(arg('--url','http://localhost:5100'));
const caPath=arg('--ca',null);
const ca=caPath?readFileSync(caPath):undefined;
const supported=['2025-03-26','2025-06-18'];
function request(route,body) {
  return new Promise((resolve,reject)=>{
    const url=new URL(route,base),transport=url.protocol==='https:'?https:http;
    const data=body===undefined?null:JSON.stringify(body);
    const req=transport.request(url,{method:data?'POST':'GET',ca,
      // Keep TLS hostname validation, but connect only to this machine's editor.
      lookup:(_host,options,callback)=>options.all?callback(null,[{address:'127.0.0.1',family:4}]):callback(null,'127.0.0.1',4),
      headers:data?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}:{}},res=>{
        let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>{try{resolve(JSON.parse(text));}catch{reject(new Error(`Invalid editor response: HTTP ${res.statusCode}`));}});
      });
    req.setTimeout(50000,()=>req.destroy(new Error('Editor transport timeout; inspect state before retrying writes.')));
    req.on('error',reject);req.end(data);
  });
}
const send = value=>process.stdout.write(JSON.stringify(value)+'\n');
async function handle(req) {
  if(req.id===undefined)return;
  try {
    let result;
    if(req.method==='initialize')result={protocolVersion:supported.includes(req.params?.protocolVersion)?req.params.protocolVersion:supported.at(-1),capabilities:{tools:{}},serverInfo:{name:'aether-editor',version:'0.2.0'},instructions:EDITOR_INSTRUCTIONS};
    else if(req.method==='ping')result={};
    else if(req.method==='tools/list')result=await request('/__editor/tools');
    else if(req.method==='tools/call') {
      const value=await request('/__editor/call',req.params);
      const content=[];
      if(value.ok && value.image) {content.push({type:'image',data:value.image.data,mimeType:'image/png'});delete value.image;}
      content.push({type:'text',text:JSON.stringify(value)});
      result={content,isError:!value.ok,structuredContent:value};
    } else {send({jsonrpc:'2.0',id:req.id,error:{code:-32601,message:'Method not found'}});return;}
    send({jsonrpc:'2.0',id:req.id,result});
  } catch(error) {send({jsonrpc:'2.0',id:req.id,result:{isError:true,content:[{type:'text',text:JSON.stringify({ok:false,code:'EDITOR_UNAVAILABLE',message:String(error)})}]}});}
}
createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{
  try {void handle(JSON.parse(line));}catch {send({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});}
});
