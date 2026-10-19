/** 剪贴板验收：真实浏览器输入、原生读回；不读取或打印无关剪贴板文本。 */
export async function clickFocusedElement(cdp, expression, button = 'left') {
  await cdp.send('Page.bringToFront');
  const point = await cdp.eval(`(() => {
    const el = (${expression});
    if (!el) throw new Error('剪贴板操作目标不存在');
    el.scrollIntoView({block:'nearest',inline:'nearest'});
    const rect = el.getBoundingClientRect(), x = rect.x + rect.width/2, y = rect.y + rect.height/2;
    return {x,y,focused:document.hasFocus(),visible:rect.width>0&&rect.height>0,
      enabled:!el.disabled,hit:el.contains(document.elementFromPoint(x,y))};
  })()`);
  if (!point.focused || !point.visible || !point.enabled || !point.hit) {
    throw new Error(`剪贴板操作要求真实焦点与可点击目标：${JSON.stringify(point)}`);
  }
  const params = {x:point.x,y:point.y,button,clickCount:1};
  await cdp.send('Input.dispatchMouseEvent', {type:'mouseMoved',x:point.x,y:point.y});
  await cdp.send('Input.dispatchMouseEvent', {type:'mousePressed',...params});
  await cdp.send('Input.dispatchMouseEvent', {type:'mouseReleased',...params});
}

/** 同时等待真实剪贴板与该次操作的 HUD 完成；空/拒绝/不符保留失败诊断。 */
export async function readClipboardOutcome(cdp, {expected,hudText,timeout=5000,interval=50}) {
  let last = {matches:false,hudMatches:false,error:'尚未读回'}, timer, stopped = false;
  const poll = async () => {
    const deadline = Date.now() + timeout;
    do {
      last = await cdp.eval(`(async () => {
        const hud = document.getElementById('model-info')?.textContent ?? '';
        const state = {hud,hudMatches:hud===${JSON.stringify(hudText)},focused:document.hasFocus()};
        try {
          const text = await navigator.clipboard.readText();
          return {...state,readable:true,matches:text===${JSON.stringify(expected)},length:text.length,error:null};
        } catch (error) {
          return {...state,readable:false,matches:false,length:null,error:error.name+': '+error.message};
        }
      })()`);
      if ((last.matches && last.hudMatches && last.focused) || !last.readable || !last.focused) return last;
      if (stopped) return last;
      await new Promise(resolve => setTimeout(resolve, interval));
    } while (!stopped && Date.now() < deadline);
    throw new Error(`剪贴板读回超时：${JSON.stringify(last)}`);
  };
  try {
    return await Promise.race([poll(), new Promise((_,reject) => {
      timer = setTimeout(() => reject(new Error(`剪贴板读回超时：${JSON.stringify(last)}`)), timeout);
    })]);
  } finally { stopped = true; clearTimeout(timer); }
}
