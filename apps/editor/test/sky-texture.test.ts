import {expect,it,vi} from 'vitest';
import {SkyTextureLoader} from '../src/services/sky-texture';
const ref=(name:string)=>({path:`assets/${name}.png`,guid:`as_${name}0000`});
it('closes stale decoded images and does not upload over the next scene',async()=>{
 let resolveA!:(b:ImageBitmap)=>void;
 const a={close:vi.fn()} as unknown as ImageBitmap,b={close:vi.fn()} as unknown as ImageBitmap;
 const upload=vi.fn();
 const loader=new SkyTextureLoader(upload,r=>r.path.includes('first')?new Promise(resolve=>{resolveA=resolve;}):Promise.resolve(b));
 loader.sync(ref('first'));loader.sync(ref('second'));await loader.ready();
 resolveA(a);await Promise.resolve();await Promise.resolve();
 expect(upload.mock.calls.filter(c=>c[0]!==null).map(c=>c[0])).toEqual([b]);
 expect(a.close).toHaveBeenCalledOnce();expect(b.close).toHaveBeenCalledOnce();expect(loader.pending).toBe(false);
});
it('reports decode errors and clears them when the reference is disabled',async()=>{
 const upload=vi.fn();const loader=new SkyTextureLoader(upload,async()=>{throw new Error('GUID mismatch');});
 loader.sync(ref('bad'));await loader.ready();expect(loader.diagnostic).toContain('GUID mismatch');expect(loader.pending).toBe(false);
 loader.sync(null);expect(loader.diagnostic).toBe('');expect(upload).toHaveBeenLastCalledWith(null);
});
it('does not reallocate for scalar edits or upload after destroy',async()=>{
 let resolve!:(b:ImageBitmap)=>void;const bitmap={close:vi.fn()} as unknown as ImageBitmap;
 const decode=vi.fn(()=>new Promise<ImageBitmap>(r=>{resolve=r;})),upload=vi.fn();
 const loader=new SkyTextureLoader(upload,decode);loader.sync(ref('same'));loader.sync({...ref('same')});loader.destroy();
 resolve(bitmap);await loader.ready();expect(decode).toHaveBeenCalledOnce();expect(upload).toHaveBeenCalledTimes(1);expect(bitmap.close).toHaveBeenCalledOnce();
});
