/** Core-owned scene depth. Play consumers borrow its stable view, never own/destroy the texture. */
export class SceneDepth {
 texture:GPUTexture|null=null;view:GPUTextureView|null=null;
 readonly stats={generation:0,created:0,destroyed:0,width:0,height:0};
 private disposed=false;
 constructor(private readonly device:GPUDevice){}
 resize(width:number,height:number){if(this.disposed)return;const w=Math.max(1,Math.floor(width)),h=Math.max(1,Math.floor(height));if(this.texture && w===this.stats.width && h===this.stats.height)return;
  this.release();this.texture=this.device.createTexture({label:'scene-depth-sampleable',size:[w,h],format:'depth24plus',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});this.view=this.texture.createView();Object.assign(this.stats,{generation:this.stats.generation+1,created:this.stats.created+1,width:w,height:h});
 }
 private release(){if(this.texture){this.texture.destroy();this.stats.destroyed++;}this.texture=null;this.view=null;}
 destroy(){if(this.disposed)return;this.disposed=true;this.release();}
}
