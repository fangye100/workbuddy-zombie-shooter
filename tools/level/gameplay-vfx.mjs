/** 正式关卡的表现内容绑定；不改玩法规则、布局或模拟数据。 */
const ref = (name, guid) => ({ path: `assets/vfx/${name}.vfx.json`, guid: `as_vfx_${guid}` });
const pistol = ref('comic-pistol', 'comic_pistol');
const enemies = ref('comic-enemies', 'comic_enemies');
const motion = ref('comic-motion', 'comic_motion');
const binding = (resource, effectKey) => ({ resource: structuredClone(resource), effectKey });

export function applyGameplayVfx(doc) {
  const rulesNode = doc.nodes.find(n => n.components.some(c => c.kind === 'RunRules'));
  if (!rulesNode) return doc; // 编辑用 sandbox 不隐式创建游戏规则。
  const rules = rulesNode.components.find(c => c.kind === 'RunRules');
  for (const weapon of rules.arsenal.definitions) {
    if (['hitscan', 'pellets', 'piercing'].includes(weapon.behavior)) {
      weapon.presentation.vfx = { resource: structuredClone(pistol), muzzle: 'comic-muzzle', trail: 'comic-trail', impact: 'comic-impact' };
    }
  }
  const bindings = {};
  for (const [tag, key] of Object.entries({
    'enemy.acid.flight': 'acid-flight', 'enemy.acid.land': 'acid-land', 'enemy.acid.pool': 'acid-pool',
    'enemy.acid.blocked': 'acid-blocked', 'enemy.explode': 'explode', 'enemy.pounce.impact': 'pounce-impact', 'enemy.mark': 'ground-mark',
  })) bindings[tag] = binding(enemies, key);
  for (const [tag, key] of Object.entries({
    'weapon.flame': 'flame', 'actor.smoke': 'smoke', 'combat.spark': 'sparks', 'enemy.charge.trail': 'charge-dust', 'combat.melee': 'melee-arc',
  })) bindings[tag] = binding(motion, key);
  let component = rulesNode.components.find(c => c.kind === 'VfxBindings');
  if (!component) { component = { kind: 'VfxBindings', enabled: true, bindings: {} }; rulesNode.components.push(component); }
  Object.assign(component.bindings, bindings);
  doc.dependencies = [...new Set([...doc.dependencies, pistol.path, enemies.path, motion.path])];
  return doc;
}
