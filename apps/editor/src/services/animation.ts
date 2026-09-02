/**
 * AnimationService —— 蒙皮动画播放控制 + 选中名查询。
 *
 * 当前可播动画的物体：优先「选中且带骨骼」的物体，否则退回角色槽位。
 * 播放 / 暂停 / 停止 / 循环 / 速率 / seek 都作用在 activeSkinObject 的 skinState 上
 * （skin 控制函数来自 @aether/render）。selectedName / selectedSubName 给 HUD 用。
 */
import type { LabRenderer, SceneObject } from '../renderer';
import {
  clipNames,
  currentClip,
  selectClip,
  play,
  pause,
  setLoop,
  setSpeed,
  seek,
} from '@aether/render';

export class AnimationService {
  constructor(private readonly host: LabRenderer) {}

  /** 当前可播动画的物体：优先「选中且带骨骼」的物体，否则退回角色槽位 */
  private activeSkinObject(): SceneObject | null {
    const s = this.host.state;
    if (s.selectedIndex !== null) {
      const o = s.objects[s.selectedIndex];
      if (o !== undefined && o.skinState !== null) return o;
    }
    const c = s.objects[this.host.characterIndex];
    return c !== undefined && c.skinState !== null ? c : null;
  }

  hasAnimation(): boolean {
    return this.activeSkinObject() !== null;
  }

  getClipNames(): string[] {
    const o = this.activeSkinObject();
    return o !== null ? clipNames(o.skinState!) : [];
  }

  getCurrentClip(): number {
    const o = this.activeSkinObject();
    return o !== null ? currentClip(o.skinState!) : -1;
  }

  getAnimationDuration(): number {
    const o = this.activeSkinObject();
    if (o === null) return 0;
    const cs = o.skinState!;
    return cs.clip >= 0 ? cs.clips[cs.clip]!.duration : 0;
  }

  getAnimationTime(): number {
    const o = this.activeSkinObject();
    return o !== null ? o.skinState!.time : 0;
  }

  /** clip：片段下标或名字；省略则继续/从头播放当前片段 */
  playAnimation(clip?: number | string): void {
    const o = this.activeSkinObject();
    if (o === null) return;
    const st = o.skinState!;
    if (typeof clip === 'string') {
      const idx = clipNames(st).indexOf(clip);
      if (idx >= 0) selectClip(st, idx);
    } else if (typeof clip === 'number') {
      selectClip(st, clip);
    } else {
      play(st);
    }
  }

  pauseAnimation(): void {
    const o = this.activeSkinObject();
    if (o !== null) pause(o.skinState!);
  }

  stopAnimation(): void {
    const o = this.activeSkinObject();
    if (o !== null) selectClip(o.skinState!, -1);
  }

  setAnimationLoop(loop: boolean): void {
    const o = this.activeSkinObject();
    if (o !== null) setLoop(o.skinState!, loop);
  }

  setAnimationSpeed(speed: number): void {
    const o = this.activeSkinObject();
    if (o !== null) setSpeed(o.skinState!, speed);
  }

  seekAnimation(time: number): void {
    const o = this.activeSkinObject();
    if (o !== null) seek(o.skinState!, time);
  }

  /** 当前是否正在播放（供 UI 同步播放/暂停按钮） */
  isAnimationPlaying(): boolean {
    const o = this.activeSkinObject();
    return o !== null && o.skinState!.playing;
  }

  /** 当前片段是否循环（供 UI 同步复选框） */
  getAnimationLoop(): boolean {
    const o = this.activeSkinObject();
    return o !== null && o.skinState!.loop;
  }

  /** 当前播放速率倍率（供 UI 同步滑块） */
  getAnimationSpeed(): number {
    const o = this.activeSkinObject();
    return o !== null ? o.skinState!.speed : 1;
  }

  selectedName(): string | null {
    const s = this.host.state;
    return s.selectedIndex === null ? null : s.objects[s.selectedIndex]?.name ?? null;
  }

  /** 选中子网格的名字（HUD 用）；选中的是整物体或无选中则 null */
  selectedSubName(): string | null {
    const s = this.host.state;
    if (s.selectedIndex === null || s.selectedSub === null) return null;
    return s.objects[s.selectedIndex]?.subMeshes[s.selectedSub]?.name ?? null;
  }
}
