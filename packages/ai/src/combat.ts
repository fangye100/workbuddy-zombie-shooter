/**
 * 战斗层：Montage / AnimNotify（动画与战斗的唯一契约） + 扫掠命中 + 伤害管线 + 攻击名额。
 *
 * 三条硬规则（文档 §3.3 / §6.2 / §6.4）：
 *  1. 命中窗口由**动画时间轴**定义，不用代码计时器 —— 改动画长度时判定自动跟随。
 *  2. 判定用**扫掠**而非单帧重叠 —— 60fps 下单帧 overlap 会漏判快速挥击。
 *  3. 判定频率跟随**固定步长**，不跟随渲染帧 —— 否则高刷屏与低帧设备的判定密度不同。
 */

export const enum NotifyKind {
  HitWindowOpen = 0,
  HitWindowClose = 1,
  CancelWindowOpen = 2,
  Vfx = 3,
  Sfx = 4,
  FootStep = 5,
}

export interface AnimNotify {
  /** 归一化时间 0..1 */
  readonly t: number;
  readonly kind: NotifyKind;
  /** hitboxIndex / vfxId / sfxId / footIndex / cancelGroupId */
  readonly a: number;
  /** vfx 挂点 socket / 备用 */
  readonly b: number;
}

export const enum HitboxShape {
  Sphere = 0,
  Capsule = 1,
}

export interface HitboxDef {
  readonly bone: number;
  readonly shape: HitboxShape;
  readonly radius: number;
  readonly halfHeight: number;
  readonly maxTargets: number;
  /** 同一次窗口内对同一目标只命中一次 */
  readonly hitOnce: boolean;
}

export interface AttackDef {
  readonly id: number;
  readonly montageId: number;
  /** 归一化时间：之后可被更高优先级动作打断 */
  readonly interruptibleAfter: number;
  readonly cancelGroup: number;
  readonly hitboxes: readonly HitboxDef[];
  readonly damage: number;
  readonly poise: number;
  readonly cooldown: number;
  /** 三段式，仅供编辑器可视化与调试；真实窗口由 AnimNotify 开合 */
  readonly telegraphEnd: number;
  readonly activeEnd: number;
}

// ---------------------------------------------------------------------------
// Montage：一次性动作（攻击 / 受击 / 死亡）
// ---------------------------------------------------------------------------

export interface MontageDef {
  readonly id: number;
  readonly duration: number;
  /** 必须按 t 升序 */
  readonly notifies: readonly AnimNotify[];
  readonly interruptibleAfter: number;
  /** 群体单位一律 false：root motion 会和避让、流场速度打架产生滑步 */
  readonly rootMotion: boolean;
}

export interface NotifySink {
  onHitWindowOpen(agent: number, attackId: number, hitboxIndex: number): void;
  onHitWindowClose(agent: number, attackId: number, hitboxIndex: number): void;
  onCancelWindow(agent: number, cancelGroup: number): void;
  onVfx(agent: number, vfxId: number, socket: number): void;
  onSfx(agent: number, sfxId: number): void;
  onFootStep(agent: number, foot: number): void;
  onMontageEnd(agent: number, montageId: number): void;
}

/** SoA 管理大量并发 Montage 实例，零 per-instance 分配 */
export class MontageRuntime {
  count = 0;
  readonly agent: Int32Array;
  readonly montageId: Int32Array;
  readonly attackId: Int32Array;
  readonly time: Float32Array;
  readonly cursor: Uint16Array;
  readonly active: Uint8Array;

  constructor(readonly capacity: number) {
    this.agent = new Int32Array(capacity).fill(-1);
    this.montageId = new Int32Array(capacity).fill(-1);
    this.attackId = new Int32Array(capacity).fill(-1);
    this.time = new Float32Array(capacity);
    this.cursor = new Uint16Array(capacity);
    this.active = new Uint8Array(capacity);
  }

  play(slot: number, agent: number, montage: MontageDef, attackId: number): void {
    this.agent[slot] = agent;
    this.montageId[slot] = montage.id;
    this.attackId[slot] = attackId;
    this.time[slot] = 0;
    this.cursor[slot] = 0;
    this.active[slot] = 1;
  }

  stop(slot: number): void {
    this.active[slot] = 0;
    this.agent[slot] = -1;
    this.montageId[slot] = -1;
    this.attackId[slot] = -1;
    this.cursor[slot] = 0;
  }

  normalizedTime(slot: number, defs: readonly MontageDef[]): number {
    const def = defs[this.montageId[slot]!];
    if (def === undefined || def.duration <= 0) return 0;
    return this.time[slot]! / def.duration;
  }

  /**
   * 推进时间轴并按序消费 Notify。
   * **关键**：一帧内可能跨过多个 Notify（低帧率时），必须逐个触发，不能只取最后一个。
   */
  advance(dt: number, defs: readonly MontageDef[], sink: NotifySink): void {
    for (let s = 0; s < this.capacity; s++) {
      if (this.active[s] === 0) continue;

      const def = defs[this.montageId[s]!];
      if (def === undefined) {
        this.stop(s);
        continue;
      }

      const t = this.time[s]! + dt;
      const norm = t / def.duration;
      const agent = this.agent[s]!;
      const attackId = this.attackId[s]!;

      let cursor = this.cursor[s]!;
      while (cursor < def.notifies.length && def.notifies[cursor]!.t <= norm) {
        const n = def.notifies[cursor]!;
        switch (n.kind) {
          case NotifyKind.HitWindowOpen:
            sink.onHitWindowOpen(agent, attackId, n.a);
            break;
          case NotifyKind.HitWindowClose:
            sink.onHitWindowClose(agent, attackId, n.a);
            break;
          case NotifyKind.CancelWindowOpen:
            sink.onCancelWindow(agent, n.a);
            break;
          case NotifyKind.Vfx:
            sink.onVfx(agent, n.a, n.b);
            break;
          case NotifyKind.Sfx:
            sink.onSfx(agent, n.a);
            break;
          case NotifyKind.FootStep:
            sink.onFootStep(agent, n.a);
            break;
        }
        cursor++;
      }
      this.cursor[s] = cursor;

      if (norm >= 1) {
        sink.onMontageEnd(agent, def.id);
        this.stop(s);
      } else {
        this.time[s] = t;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 命中窗口表 + 去重缓冲
// ---------------------------------------------------------------------------

/**
 * 全局去重环形缓冲。
 * 若每个招式窗口都 new Set()，500 NPC 同帧开窗口会产生明显的 GC 压力；
 * 这里用一段预分配的 Int32 数组，关闭窗口时只回退写指针 —— 等价于"清空集合"但零 GC。
 *
 * 前提：窗口严格嵌套（同一攻击者同一时刻只有一个招式窗口），实际用法满足。
 */
export class HitDedupeBuffer {
  private readonly attacker: Uint32Array;
  private readonly victim: Uint32Array;
  private head = 0;

  constructor(readonly capacity = 4096) {
    this.attacker = new Uint32Array(capacity);
    this.victim = new Uint32Array(capacity);
  }

  open(): number {
    return this.head;
  }

  close(start: number): void {
    if (start >= 0 && start <= this.head) this.head = start;
  }

  contains(start: number, attacker: number, victim: number): boolean {
    for (let k = start; k < this.head; k++) {
      if (this.attacker[k] === attacker && this.victim[k] === victim) return true;
    }
    return false;
  }

  record(attacker: number, victim: number): void {
    if (this.head >= this.capacity) return;
    this.attacker[this.head] = attacker;
    this.victim[this.head] = victim;
    this.head++;
  }
}

export class HitWindowTable {
  count = 0;
  readonly agent: Int32Array;
  readonly attackId: Int32Array;
  readonly hitboxIndex: Int32Array;
  readonly dedupeStart: Int32Array;
  readonly prevX: Float32Array;
  readonly prevY: Float32Array;
  readonly prevZ: Float32Array;
  readonly currX: Float32Array;
  readonly currY: Float32Array;
  readonly currZ: Float32Array;
  readonly radius: Float32Array;
  readonly halfHeight: Float32Array;
  readonly hitOnce: Uint8Array;
  readonly maxTargets: Uint8Array;
  readonly hitCount: Uint8Array;

  constructor(readonly capacity: number) {
    this.agent = new Int32Array(capacity);
    this.attackId = new Int32Array(capacity);
    this.hitboxIndex = new Int32Array(capacity);
    this.dedupeStart = new Int32Array(capacity);
    this.prevX = new Float32Array(capacity);
    this.prevY = new Float32Array(capacity);
    this.prevZ = new Float32Array(capacity);
    this.currX = new Float32Array(capacity);
    this.currY = new Float32Array(capacity);
    this.currZ = new Float32Array(capacity);
    this.radius = new Float32Array(capacity);
    this.halfHeight = new Float32Array(capacity);
    this.hitOnce = new Uint8Array(capacity);
    this.maxTargets = new Uint8Array(capacity);
    this.hitCount = new Uint8Array(capacity);
  }

  open(
    agent: number,
    attackId: number,
    hitboxIndex: number,
    dedupeStart: number,
    box: HitboxDef,
    x: number,
    y: number,
    z: number,
  ): number {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    this.agent[i] = agent;
    this.attackId[i] = attackId;
    this.hitboxIndex[i] = hitboxIndex;
    this.dedupeStart[i] = dedupeStart;
    this.prevX[i] = x;
    this.prevY[i] = y;
    this.prevZ[i] = z;
    this.currX[i] = x;
    this.currY[i] = y;
    this.currZ[i] = z;
    this.radius[i] = box.radius;
    this.halfHeight[i] = box.halfHeight;
    this.hitOnce[i] = box.hitOnce ? 1 : 0;
    this.maxTargets[i] = box.maxTargets;
    this.hitCount[i] = 0;
    return i;
  }

  close(i: number): void {
    const last = --this.count;
    if (i !== last) {
      this.agent[i] = this.agent[last]!;
      this.attackId[i] = this.attackId[last]!;
      this.hitboxIndex[i] = this.hitboxIndex[last]!;
      this.dedupeStart[i] = this.dedupeStart[last]!;
      this.prevX[i] = this.prevX[last]!;
      this.prevY[i] = this.prevY[last]!;
      this.prevZ[i] = this.prevZ[last]!;
      this.currX[i] = this.currX[last]!;
      this.currY[i] = this.currY[last]!;
      this.currZ[i] = this.currZ[last]!;
      this.radius[i] = this.radius[last]!;
      this.halfHeight[i] = this.halfHeight[last]!;
      this.hitOnce[i] = this.hitOnce[last]!;
      this.maxTargets[i] = this.maxTargets[last]!;
      this.hitCount[i] = this.hitCount[last]!;
    }
  }
}

export interface DamageHit {
  instigator: number;
  victim: number;
  attackId: number;
  hitboxIndex: number;
  hitX: number;
  hitY: number;
  hitZ: number;
}

export interface DamageSink {
  onHit(hit: DamageHit): void;
}

/**
 * 形状扫掠由物理层提供（胶囊沿线段扫掠）。
 * 返回命中数量，命中实体写入 out。
 */
export type ShapeCastFn = (
  fromX: number,
  fromY: number,
  fromZ: number,
  toX: number,
  toY: number,
  toZ: number,
  radius: number,
  halfHeight: number,
  out: Int32Array,
  maxOut: number,
) => number;

export class SweepHitSystem {
  private readonly out = new Int32Array(32);

  constructor(
    private readonly dedupe: HitDedupeBuffer,
    private readonly cast: ShapeCastFn,
  ) {}

  /** 每个固定步长调用一次；骨骼世界坐标由动画层在 Extract 之前更新 */
  update(table: HitWindowTable, sink: DamageSink): void {
    for (let i = 0; i < table.count; i++) {
      if (table.hitCount[i]! >= table.maxTargets[i]!) continue;

      const n = this.cast(
        table.prevX[i]!,
        table.prevY[i]!,
        table.prevZ[i]!,
        table.currX[i]!,
        table.currY[i]!,
        table.currZ[i]!,
        table.radius[i]!,
        table.halfHeight[i]!,
        this.out,
        this.out.length,
      );

      const attacker = table.agent[i]!;
      const start = table.dedupeStart[i]!;
      for (let k = 0; k < n; k++) {
        const victim = this.out[k]!;
        if (victim === attacker) continue;
        if (table.hitOnce[i] === 1 && this.dedupe.contains(start, attacker, victim)) continue;
        if (table.hitCount[i]! >= table.maxTargets[i]!) break;

        this.dedupe.record(attacker, victim);
        table.hitCount[i] = table.hitCount[i]! + 1;
        sink.onHit({
          instigator: attacker,
          victim,
          attackId: table.attackId[i]!,
          hitboxIndex: table.hitboxIndex[i]!,
          hitX: table.currX[i]!,
          hitY: table.currY[i]!,
          hitZ: table.currZ[i]!,
        });
      }

      // 推进扫掠起点：下一固定步长从当前位置开始
      table.prevX[i] = table.currX[i]!;
      table.prevY[i] = table.currY[i]!;
      table.prevZ[i] = table.currZ[i]!;
    }
  }
}

// ---------------------------------------------------------------------------
// 伤害管线
// ---------------------------------------------------------------------------

export interface DamageEvent {
  instigator: number;
  target: number;
  amount: number;
  poise: number;
  type: number;
  dirX: number;
  dirZ: number;
  hitBone: number;
}

export type DamageModifier = (e: DamageEvent, ctx: DamageModifierContext) => void;

export interface DamageModifierContext {
  /** 仅在 debug 构建开启，记录每一步倍率供调试面板打印完整链路 */
  readonly trail: number[] | null;
  readonly targetHealth01: number;
}

export class DamagePipeline {
  private readonly mods: DamageModifier[] = [];
  private readonly trail: number[] | null;

  constructor(
    private readonly sink: (e: DamageEvent) => void,
    enableTrail = false,
  ) {
    this.trail = enableTrail ? [] : null;
  }

  add(mod: DamageModifier): void {
    this.mods.push(mod);
  }

  apply(base: DamageEvent, targetHealth01: number): void {
    const ctx: DamageModifierContext = { trail: this.trail, targetHealth01 };
    if (this.trail !== null) this.trail.length = 0;
    // 修正链有序 —— 肉鸽词条按注册顺序叠加，调试时可完整追溯
    for (let i = 0; i < this.mods.length; i++) {
      this.mods[i]!(base, ctx);
    }
    this.sink(base);
  }
}

// ---------------------------------------------------------------------------
// 攻击名额与包围圈配额（群战手感的核心）
// ---------------------------------------------------------------------------

/**
 * 没有这个，玩家会被瞬间秒杀，而且完全无法理解发生了什么。
 * 拿到名额的才起手（telegraph），拿不到的进 Circle 状态在周围游走伺机。
 */
export class AttackTokenPool {
  private readonly holder: Int32Array;

  constructor(readonly total: number, reserved: number) {
    this.holder = new Int32Array(total).fill(-1);
    // 精英 / Boss 拥有保留名额，永远能打
    for (let i = 0; i < Math.min(reserved, total); i++) this.holder[i] = -2;
  }

  request(agent: number): boolean {
    if (this.has(agent)) return true;
    for (let i = 0; i < this.total; i++) {
      if (this.holder[i] === -1) {
        this.holder[i] = agent;
        return true;
      }
    }
    return false;
  }

  has(agent: number): boolean {
    for (let i = 0; i < this.total; i++) {
      if (this.holder[i] === agent) return true;
    }
    return false;
  }

  /** 在 recovery 结束时归还（不是命中时），否则会出现连续无缝的攻击墙 */
  release(agent: number): void {
    for (let i = 0; i < this.total; i++) {
      if (this.holder[i] === agent) this.holder[i] = -1;
    }
  }

  get activeCount(): number {
    let n = 0;
    for (let i = 0; i < this.total; i++) {
      if (this.holder[i]! >= 0) n++;
    }
    return n;
  }
}

/**
 * 包围圈配额：玩家周围按角度分 N 个扇区，每扇区最多站 K 个。
 * 超出的去相邻扇区排队 —— 这样玩家永远有"缺口"可以冲出去，
 * 这是让尸潮"有压迫感但不憋屈"的关键设计。
 */
export class SurroundQuota {
  private readonly counts: Uint16Array;

  constructor(
    readonly sectors: number,
    readonly perSector: number,
    readonly innerRadius: number,
  ) {
    this.counts = new Uint16Array(sectors);
  }

  reset(): void {
    this.counts.fill(0);
  }

  private sectorOf(x: number, z: number, cx: number, cz: number): number {
    const a = Math.atan2(z - cz, x - cx);
    const norm = (a + Math.PI * 2) % (Math.PI * 2);
    return Math.min(this.sectors - 1, ((norm / (Math.PI * 2)) * this.sectors) | 0);
  }

  /**
   * 该 NPC 是否获准进入内圈。
   * 扇区满员时返回 false，调用方应让 NPC 停在 ringRadius 外游走。
   */
  tryClaim(x: number, z: number, cx: number, cz: number): boolean {
    const s = this.sectorOf(x, z, cx, cz);
    if (this.counts[s]! >= this.perSector) return false;
    this.counts[s] = this.counts[s]! + 1;
    return true;
  }

  /** 相对玩家的期望停留半径：内圈满员时退到外环 */
  desiredRadius(x: number, z: number, cx: number, cz: number, outerRadius: number): number {
    const s = this.sectorOf(x, z, cx, cz);
    return this.counts[s]! >= this.perSector ? outerRadius : this.innerRadius;
  }
}
