export type GameLanguage = 'zh' | 'en';
let language: GameLanguage = 'zh';
try { language = localStorage.getItem('zombie.game.language') === 'en' ? 'en' : 'zh'; } catch { /* Optional persistence. */ }
export function gameLanguage(): GameLanguage { return language; }
export function setGameLanguage(next: GameLanguage): void {
  language = next;
  try { localStorage.setItem('zombie.game.language', next); } catch { /* Continue in memory. */ }
}
const phrases: Record<string, string> = {
  '火场公路': 'Burning highway', '尸潮仓储区': 'Warehouse swarm', '暗巷撤离站': 'Alley extraction',
  '本局结算 · 流派归零，尸髓保留': 'Run results · Build reset, essence retained', '楼层结算 · 成长带入下一层': 'Floor results · Carry your build onward',
  '本局累计尸髓':'Run essence', '永久尸髓余额':'Permanent essence balance', '已解锁':'Unlocked', '解锁':'Unlock',
  '（加入后续强化选项，不直接增加属性）':' (Adds an upgrade option; no direct stat boost)',
  '存档失败：':'Save failed: ', '结算保存失败：':'Result save failed: ', '。奖励仍保留在本局。':'. Rewards remain in this run.', '重试结算':'Retry save',
  '鼠标 / J 开火':'Mouse / J to fire',
  'WASD / 方向键移动 · 鼠标瞄准 · 左键射击 · R 换弹 · 1–7 换武器 · E 交互 · 空格暂停': 'WASD / arrows: move · Mouse: aim · Left click: fire · R: reload · 1–7: weapons · E: interact · Space: pause',
  '左摇杆移动 · 右摇杆瞄准射击 · 点击按钮换弹与交互': 'Left stick: move · Right stick: aim and fire · Tap buttons to reload and interact',
  '准备好了 · 继续战斗': 'Ready · Resume', '全部楼层已完成': 'Campaign complete', '继续下一层': 'Next floor',
  '房间已完成 · 沿道路继续前进': 'Room cleared · Continue down the street', '前往下一个房间': 'Move to the next room',
  '按 E 交互，完成事件房': 'Interact (E) to complete this event', '探索并清理房间': 'Explore and clear the room',
  '击败精英目标': 'Defeat the elite', '消灭敌人': 'Eliminate enemies', '本局结束 · 再试一次': 'Run over · Try again',
  '本层通关！': 'Floor cleared!', '再来一局': 'Retry', '返回编辑': 'Back to editor', '交互 E': 'Interact E',
  '已暂停': 'Paused', '游戏状态': 'Game status', '生命值': 'Health', '附近敌人雷达 · 范围 20 米': 'Enemy radar · 20 m',
  '本局成长与补给': 'Run upgrades and supplies', '选择一项强化': 'Choose an upgrade',
  '取消购买': 'Cancel purchase', '击杀敌人，解锁首个流派': 'Kill enemies to unlock your first build',
  '补给站 · 选择购买的强化': 'Supply station · Choose an upgrade', '选择强化 · 战斗已暂停': 'Choose an upgrade · Combat paused',
  '重型弹头': 'Heavy rounds', '快速供弹': 'Rapid feed', '尸髓回流': 'Essence siphon', '震荡弹池': 'Shock rounds',
  '破片弹药': 'Fragment rounds', '轻装步伐': 'Lightfoot',
  '每层伤害 +35%；叠满三层形成高伤流派。': '+35% damage per stack; three stacks complete the build.',
  '每层射速 +30%，持续压制尸潮。': '+30% fire rate per stack to suppress the horde.',
  '命中恢复实际伤害的 8% 生命。': 'Recover 8% of actual hit damage as health.',
  '解锁新的范围流派选项：每层 2 米半额冲击波。': 'Unlock area damage: a 2 m half-damage shockwave per stack.',
  '命中造成半额范围伤害；每层扩大 1.2 米。': 'Hits deal half damage in an area; +1.2 m per stack.',
  '每层移动速度 +15%，更容易拉开距离。': '+15% movement speed per stack to keep your distance.',
  '第一层': 'Floor 1', '第二层': 'Floor 2', '第三层': 'Floor 3', '火场': 'Fire', '尸潮': 'Swarm', '暗巷': 'Dark alleys',
  '战斗房': 'Combat room', '事件房': 'Event room', '精英房': 'Elite room', '战斗': 'Combat', '事件': 'Event', '精英': 'Elite',
  '辅助瞄准：': 'Aim assist: ', '按住 J 开火': 'Mouse / J to fire', '换弹中': 'Reloading', '换弹 R': 'Reload R',
  '弹药': 'Ammo', '废料': 'Scrap', '尸髓': 'Essence', '击杀': 'Kills', '敌人': 'Enemies', '房间': 'Rooms',
  '急救': 'Heal', '购买强化': 'Buy upgrade', '补充': 'Restocked', '发备用': ' reserve ',
  '补给恢复': 'Supply restored', '生命': 'health', '补给箱': 'Supply crate', '楼层完成': 'Floor complete',
  '流派成型！': 'Build complete!', '撤离！': 'Evacuate! ', '倒下': 'Down', '击杀！': 'Kill!',
  '暂停': 'Pause', '继续': 'Resume', '换弹': 'Reload', '交互': 'Interact', '射击': 'Fire', '移动': 'Move',
  '调试范围': 'Debug ranges', '游戏视图': 'Game view', '编辑器视图': 'Editor view', '触控': 'Touch', '键鼠': 'Mouse/keys',
  '开': 'ON', '关': 'OFF', '第': 'Wave ', '波': '',
};
const ordered = Object.keys(phrases).sort((a,b) => b.length-a.length);
/** Translate authored presentation without changing simulation strings or persisted scene data. */
export function gameText(value: string): string {
  if (language === 'zh') return value;
  const pattern = new RegExp(ordered.map(s => s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'g');
  return value.replace(pattern, match => phrases[match]!);
}
