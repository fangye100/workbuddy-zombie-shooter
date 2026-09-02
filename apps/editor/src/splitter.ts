/**
 * 可拖拽分界线：所有「面板边界不锁死、自由拖」的能力都走这一个 helper。
 *
 * 约定：
 *   - 尺寸一律写成 documentElement 上的 CSS 变量（--panel-w / --insp-w / --dock-h / --tree-w），
 *     布局全靠 var() 引用，拖的时候只改一个变量，不碰任何元素的 style；
 *   - Pointer Events 统一鼠标/触屏；拖动期间 setPointerCapture 保证划出把手也不丢；
 *   - persistKey 给了就自动 localStorage 持久化 + 启动时恢复。
 */

export interface SplitterOptions {
  /** 要写入的 CSS 变量名（挂在 :root），例如 '--dock-h' */
  cssVar: string;
  /** 从指针事件算目标像素值（由调用方决定方向：宽/高、顺/逆） */
  valueFromPointer(e: PointerEvent): number;
  min: number;
  /** 上限；函数形式 = 每次拖动现算（依赖 window 尺寸的上限必须用这种，否则窗口缩放后夹取过期） */
  max: number | (() => number);
  /** localStorage 键；不传则不持久化 */
  persistKey?: string;
  /** 拖动开始回调（可以用来给 body 加 resizing 类禁用选择/iframe 吞事件） */
  onStart?(): void;
  onEnd?(): void;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 启动时恢复持久化的尺寸变量；没有持久化值就用 fallback */
export function restoreCssVar(cssVar: string, persistKey: string, fallbackPx: number): number {
  const raw = localStorage.getItem(persistKey);
  const v = raw === null ? NaN : Number(raw);
  const px = Number.isFinite(v) && v > 0 ? v : fallbackPx;
  document.documentElement.style.setProperty(cssVar, `${px}px`);
  return px;
}

export function readCssVarPx(cssVar: string, fallbackPx: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
  const v = Number(raw.replace('px', ''));
  return Number.isFinite(v) && v > 0 ? v : fallbackPx;
}

/** 把一个把手元素变成拖拽分界线 */
export function makeSplitter(handle: HTMLElement, opts: SplitterOptions): void {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // 合成的 PointerEvent（自动化测试）没有活动指针，setPointerCapture 会抛 NotFoundError；
    // 真指针路径下捕获失败也无妨（move/up 仍挂在 handle 上）
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* 合成事件无活动指针，忽略 */
    }
    handle.classList.add('dragging');
    document.body.classList.add('splitting');
    opts.onStart?.();

    // 抓取点偏移补偿：按下时的「值」与「当前尺寸」都记下来，拖动 = 起始尺寸 + 指针位移。
    // 不按这个算的话，从把手中央抓起会把尺寸凭空顶出去半个把手宽。
    const startPointer = opts.valueFromPointer(e);
    const startValue = readCssVarPx(opts.cssVar, opts.min);

    const move = (ev: PointerEvent): void => {
      const hi = typeof opts.max === 'function' ? opts.max() : opts.max;
      const px = clamp(startValue + (opts.valueFromPointer(ev) - startPointer), opts.min, hi);
      document.documentElement.style.setProperty(opts.cssVar, `${Math.round(px)}px`);
      if (opts.persistKey !== undefined) localStorage.setItem(opts.persistKey, String(Math.round(px)));
    };
    const up = (ev: PointerEvent): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      try {
        if (handle.hasPointerCapture(ev.pointerId)) handle.releasePointerCapture(ev.pointerId);
      } catch {
        /* 同上 */
      }
      handle.classList.remove('dragging');
      document.body.classList.remove('splitting');
      opts.onEnd?.();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}
