import type { PlayController } from './play-controller';

/** 白盒与编辑器 Play 的门控制面板；业务命令仍进入同一 RuntimeSession。 */
export class GatePanel {
  private readonly root=document.createElement('section');
  private key='';
  constructor(private readonly play:PlayController,private readonly nameOf:(id:string)=>string=id=>id){
    this.root.setAttribute('aria-label','动态导航门');
    this.root.style.cssText='position:fixed;left:16px;bottom:86px;z-index:45;background:#18232ded;color:#eee;padding:10px;border:1px solid #65798a;border-radius:6px;font:12px sans-serif;max-width:340px';
    document.body.append(this.root);this.update();
  }
  update():void {
    const rt=this.play.session.runtime,gates=rt?.gateSnapshot()??[];
    this.root.hidden=!gates.length;if(!gates.length){this.key='';return;}
    const key=JSON.stringify([rt?.player()?.runId,rt?.outcome,gates.map(g=>[g.nodeId,g.state,Math.round(g.progress*100),g.targetOpen])]);if(key===this.key)return;this.key=key;
    this.root.replaceChildren();const title=document.createElement('strong');title.textContent='动态导航门 · Play 控制';this.root.append(title);
    const labels:Record<string,string>={closed:'已关闭',open:'已打开',opening:'打开中',closing:'关闭中',waiting:'等待角色离开'};
    for(const gate of gates){
      const row=document.createElement('div');row.style.marginTop='7px';
      const label=document.createElement('span');label.textContent=`${this.nameOf(gate.nodeId)} · ${labels[gate.state]} ${Math.round(gate.progress*100)}% `;row.append(label);
      for(const open of [true,false]){const button=document.createElement('button');button.textContent=open?'打开':'关闭';button.setAttribute('aria-label',`${open?'打开':'关闭'} ${gate.nodeId}`);button.disabled=gate.targetOpen===open||rt?.outcome!=='running';button.onclick=()=>{rt?.setGateOpen(gate.nodeId,open);this.key='';this.update();};row.append(button);}
      this.root.append(row);
    }
  }
  dispose():void {this.root.remove();}
}
