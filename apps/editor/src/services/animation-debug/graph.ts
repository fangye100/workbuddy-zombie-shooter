import type { AnimationSnapshot } from './contracts';
export interface DebugGraphNode { id: string; label: string; subtitle: string; active: boolean; warning: boolean; details: string[]; x: number; y: number }
export interface DebugGraph { nodes: DebugGraphNode[]; edges: { from: string; to: string; active: boolean }[]; width: number; height: number }
const n = (id: string, label: string, subtitle: string, x: number, y: number, active = true, warning = false, details: string[] = []): DebugGraphNode => ({ id, label, subtitle, x, y, active, warning, details });
/** Rule/selector edges describe the real resolver, not invented pairwise state transitions. */
export function selectionGraph(s: AnimationSnapshot): DebugGraph {
  const nodes = s.decision.rules.map((r, i) => n(r.id, r.label, `${r.matched ? '条件命中' : '条件未命中'} · ${r.selected ? '采用' : '未采用'}`, 20, 20 + i * 105, r.selected, false, [r.reason,
    r.matched && !r.selected ? '更高优先级规则或缺片回退决定输出；查看选择器详情' : '']));
  const y = Math.max(70, s.decision.rules.length * 105 / 2 - 35);
  nodes.push(n('selector', '实际选择器', s.decision.source, 280, y, true, false, ['手动覆盖优先；自动选择依运行 owner', ...s.decision.rules.map(r => `${r.label}: ${r.reason}`)]),
    n('request', '请求状态 / 片段', s.decision.requested, 540, y - 65, true, false, [s.decision.actionStamp ? `动作 stamp: ${s.decision.actionStamp}` : '无活动动作 stamp']),
    n('actual', '实际动画输出', s.decision.actual, 800, y, true, !!s.decision.fallback || s.status !== 'ready', [s.decision.fallback ?? '请求直接命中', `状态: ${s.status}`, ...s.diagnostics]));
  return { nodes, edges: [...s.decision.rules.map(r => ({ from: r.id, to: 'selector', active: r.selected })),
    { from: 'selector', to: 'request', active: true }, { from: 'request', to: 'actual', active: true }], width: 1060, height: Math.max(310, s.decision.rules.length * 105 + 20) };
}
export function poseGraph(s: AnimationSnapshot): DebugGraph {
  const tr = s.transition, layer = s.layer;
  const ikActive = s.ik.status === 'configured' && s.ik.controls.some(c => c.effectiveWeight > 0);
  const ikX = layer ? 800 : 540, outputX = layer ? 1060 : 800;
  const nodes = [n('base', s.pipeline === 'gpu-palette' ? 'GPU 调色板查表' : s.pipeline === 'proxy' ? '胶囊代理' : '基础动画采样',
    s.clip ? `${s.clip.name} · ${s.clip.time.toFixed(3)}s` : '无骨架片段', 20, 80, true, !s.clip,
    [s.clip ? `phase=${s.clip.phase.toFixed(3)}; duration=${s.clip.duration.toFixed(3)}s; loop=${s.clip.loop ?? '由行为/相位控制'}` : '未执行动画采样', 'retarget / palette baking 属加载期，不是每帧节点']),
    n('transition', '基础姿态过渡', tr ? `${Math.round(tr.weight * 100)}% 实际目标权重` : '无活动过渡', 280, 80, true, false,
      tr ? [`${tr.from} → ${tr.to}`, `elapsed=${tr.elapsed.toFixed(3)} / ${tr.duration.toFixed(3)}s`, `source=${tr.source}`, layer ? '来源是前一基础姿态快照，并非两个片段持续同时播放' : '来源是前一显示姿态快照，并非两个片段持续同时播放'] : ['当前基础姿态直接输出']),
    n('ik', '身体部位 IK', s.ik.status === 'configured' ? `总权重 ${s.ik.weight.toFixed(2)} · ${s.ik.enabled ? '启用' : '禁用'}` :
      ({ unconfigured: '未配置', pending: '加载中', failed: '加载失败', unsupported: '此管线不支持 IK' } as const)[s.ik.status],
      ikX, 80, ikActive, s.ik.status === 'failed', [...s.ik.diagnostics,
        s.ik.status === 'unsupported' ? 'GPU 实例管线未执行身体 IK' : s.ik.status !== 'configured' ? '此角色没有生效的 IK 层' : '区域组合后仅一次 IK，显示当前实际目标/动作乘子/诊断']),
    n('output', '渲染输出', s.pipeline, outputX, 80, true, s.status !== 'ready', [`${s.label} · tick ${s.tick}`, ...s.diagnostics])];
  if (layer) nodes.push(n('layer', '骨骼区域动作混合', `${layer.clip?.name ?? 'base only'} · 权重 ${layer.weight.toFixed(2)}`, 540, 80,
    layer.status === 'ready' && (!!layer.clip || !!layer.transition), layer.status === 'invalid' || !!layer.fallback,
    [`${layer.requested} → ${layer.clip?.name ?? 'base only'}; action=${layer.action}; ${layer.fallback ?? '直接命中'}`,
      layer.clip ? `time=${layer.clip.time.toFixed(3)}s; phase=${layer.clip.phase.toFixed(3)}; loop=${layer.clip.loop}` : '无区域片段',
      `roots=${layer.roots.join(',')}; exclude=${layer.exclude.join(',') || 'none'}; ${layer.nodes.length} nodes`,
      `mask=${layer.bones.join(', ')}`, `status=${layer.status}; weight=${layer.weight.toFixed(2)}`,
      layer.transition ? `过渡 ${layer.transition.from} → ${layer.transition.to}; ${layer.transition.elapsed.toFixed(3)}/${layer.transition.duration.toFixed(3)}s; target=${layer.transition.weight.toFixed(3)}` : '无区域过渡',
      '基础与区域时钟独立；此图仅读取生产状态', ...layer.diagnostics]));
  s.ik.controls.forEach((c, i) => nodes.push(n(`control:${c.id}`, c.part, `有效权重 ${c.effectiveWeight.toFixed(2)} · 目标${c.valid ? '有效' : '无效'}`,
    ikX, 200 + i * 105, c.effectiveWeight > 0, !c.valid || c.diagnostics.length > 0,
    [`${c.id}; enabled=${c.enabled}; 控件权重=${c.weight.toFixed(2)}`, `${c.targetKind} → actor-local ${c.target?.map(v => v.toFixed(3)).join(', ') ?? 'unavailable'}`, ...c.diagnostics])));
  const last = layer ? 'layer' : 'transition';
  return { nodes, edges: [{ from: 'base', to: 'transition', active: true }, ...(layer ? [{ from: 'transition', to: 'layer', active: true }] : []),
    { from: last, to: 'ik', active: ikActive }, { from: 'ik', to: 'output', active: ikActive }, { from: last, to: 'output', active: !ikActive },
    ...s.ik.controls.map(c => ({ from: `control:${c.id}`, to: 'ik', active: c.effectiveWeight > 0 }))],
    width: layer ? 1320 : 1060, height: Math.max(270, 220 + s.ik.controls.length * 105) };
}
