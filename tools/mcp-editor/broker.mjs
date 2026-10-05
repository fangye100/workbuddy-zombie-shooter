import { randomUUID } from 'node:crypto';
import { EDITOR_TOOLS } from './catalog.mjs';

/** Vite transport only. Every business command executes against one live editor owner. */
export function editorAgentPlugin() {
  return { name: 'aether-editor-agent', configureServer(server) {
    const instances = new Map(), pending = new Map();
    server.ws.on('aether:hello', (data, client) => {
      if (!data || typeof data.instanceId !== 'string') return;
      const previous = instances.get(data.instanceId);
      // A duplicated tab must not hijack an existing live instance identity.
      if (previous && previous.client !== client && server.ws.clients.has(previous.client)) return;
      instances.set(data.instanceId, {client, metadata:data, seen:Date.now()});
    });
    server.ws.on('aether:reply', (data, client) => {
      const entry = pending.get(data?.requestId);
      if (!entry || entry.client !== client) return;
      clearTimeout(entry.timer); pending.delete(data.requestId); entry.resolve(data.result);
    });
    server.httpServer?.once('close', () => {
      for(const entry of pending.values()) { clearTimeout(entry.timer); entry.resolve({ok:false,code:'EDITOR_DISCONNECTED',message:'Editor server stopped; inspect state before retrying a write.'}); }
      pending.clear(); instances.clear();
    });
    server.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/__editor/')) return next();
      const respond = (status, body) => { res.statusCode=status; res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body)); };
      const address=req.socket.remoteAddress;
      // stdio proxy is local. Remote web pages cannot use this control endpoint.
      if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address) || req.headers.origin) return respond(403,{ok:false,code:'LOCAL_ONLY'});
      if(req.method==='GET' && req.url==='/__editor/tools') return respond(200,{tools:EDITOR_TOOLS});
      if(req.method!=='POST'||req.url!=='/__editor/call') return respond(404,{ok:false,code:'NOT_FOUND'});
      try {
        let body=''; for await(const chunk of req) { body+=chunk; if(Buffer.byteLength(body)>2*1024*1024) return respond(413,{ok:false,code:'PAYLOAD_TOO_LARGE'}); }
        const {name,arguments:args={}}=JSON.parse(body);
        const tool=EDITOR_TOOLS.find(t=>t.name===name);
        if(!tool) return respond(400,{ok:false,code:'UNKNOWN_TOOL',message:String(name)});
        if(!args||typeof args!=='object'||Array.isArray(args))return respond(400,{ok:false,code:'INVALID_ARGUMENTS'});
        if(tool.inputSchema.required.some(key=>!(key in args)) || Object.keys(args).some(key=>!(key in tool.inputSchema.properties))) return respond(400,{ok:false,code:'INVALID_ARGUMENTS',message:'Missing required or unknown argument'});
        for(const [id,entry] of instances) if(!server.ws.clients.has(entry.client))instances.delete(id);
        if(name==='editor_instances') return respond(200,{ok:true,instances:[...instances.values()].map(e=>({...e.metadata,lastSeen:e.seen}))});
        const entry=instances.get(args.instanceId);
        if(!entry) return respond(409,{ok:false,code:'EDITOR_DISCONNECTED',message:'Choose a connected instance from editor_instances.'});
        const requestId=randomUUID();
        const result=await new Promise(resolve=>{
          const timer=setTimeout(()=>{pending.delete(requestId);resolve({ok:false,code:'TIMEOUT',message:'No editor reply. The command may have run; inspect revision/state before retrying.',requestId});},45000);
          pending.set(requestId,{resolve,timer,client:entry.client});
          entry.client.send('aether:request',{requestId,name,args});
        });
        respond(200,result);
      } catch(error) {respond(400,{ok:false,code:'BAD_REQUEST',message:String(error)});}
    });
  }};
}
