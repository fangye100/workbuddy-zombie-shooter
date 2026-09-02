/**
 * Game Editor 参数定义（原 Shader Lab）。
 *
 * 全部参数集中在一处，UI 面板按 PARAM_GROUPS 声明式生成，
 * 渲染器按同一份数据写 uniform。改参数只需改这里。
 */

// MaterialState（材质数据契约）已上提进引擎层包体，编辑器的真源是 @aether/render。
// 这里只做类型 re-export，保证既有 `from './params'` 引用（renderer / ui / binding / presets）全绿。
import type { MaterialState } from '@aether/render';
export type { MaterialState } from '@aether/render';

export interface LabParams {
  keyAzimuth: number;
  keyElevation: number;
  keyIntensity: number;
  keyColor: string;

  fillSkyColor: string;
  fillSkyIntensity: number;
  fillGroundColor: string;
  fillGroundIntensity: number;

  rimColor: string;
  rimIntensity: number;
  rimPower: number;
  rimTopBias: number;

  ambientColor: string;
  ambientIntensity: number;

  pointEnabled: boolean;
  pointColor: string;
  pointIntensity: number;
  pointRange: number;
  pointOrbit: boolean;

  fogColor: string;
  fogDensity: number;

  shadowEnd: number;
  specStart: number;
  edgeSoftness: number;
  shadowMult: number;
  shadowMix: number;
  shadowSat: number;
  litSat: number;
  specMix: number;
  shadowTint: string;
  specTint: string;

  outlineEnabled: boolean;
  outlineWidth: number;
  outlineDistanceComp: boolean;
  outlinePostExempt: boolean;
  inkColor: string;

  halftoneEnabled: boolean;
  halftoneSize: number;
  halftoneStrength: number;
  halftoneThreshold: number;

  tonemapMode: number;
  exposure: number;
  bloomEnabled: boolean;
  bloomThreshold: number;
  bloomIntensity: number;
  vignette: number;

  gradeEnabled: boolean;
  gradeShadowRange: number;
  gradeMidRange: number;
  gradeEdge: number;
  gradeShadowMult: number;
  gradeShadowMix: number;
  gradeShadowSat: number;
  gradeMidSat: number;
  gradeLightMult: number;
  gradeLightMix: number;
  gradeLightSat: number;

  debugMode: number;
  cameraElevation: number;
  autoOrbit: boolean;

  editTarget: number;
  materials: MaterialState[];
}

export type ParamKey = Exclude<keyof LabParams, 'materials'>;

export interface SliderDef {
  kind: 'slider';
  key: ParamKey;
  label: string;
  min: number;
  max: number;
  step: number;
  hint?: string;
}

export interface ColorDef {
  kind: 'color';
  key: ParamKey;
  label: string;
  hint?: string;
}

export interface ToggleDef {
  kind: 'toggle';
  key: ParamKey;
  label: string;
  hint?: string;
}

export interface SelectDef {
  kind: 'select';
  key: ParamKey;
  label: string;
  options: { label: string; value: number }[];
  hint?: string;
}

export interface MaterialSliderDef {
  kind: 'material-slider';
  field: keyof MaterialState;
  label: string;
  min: number;
  max: number;
  step: number;
  hint?: string;
}

export interface MaterialColorDef {
  kind: 'material-color';
  field: keyof MaterialState;
  label: string;
  hint?: string;
}

export interface MaterialToggleDef {
  kind: 'material-toggle';
  field: keyof MaterialState;
  label: string;
  hint?: string;
}

/**
 * 「Mesh 材质」面板的控件：与 material-* 一一对应，但读写目标是**当前选中子网格**
 * 的生效材质（override > instance > shared），而不是 params.materials[editTarget]。
 */
export interface SlotSliderDef {
  kind: 'slot-slider';
  field: keyof MaterialState;
  label: string;
  min: number;
  max: number;
  step: number;
  hint?: string;
}

export interface SlotColorDef {
  kind: 'slot-color';
  field: keyof MaterialState;
  label: string;
  hint?: string;
}

export interface SlotToggleDef {
  kind: 'slot-toggle';
  field: keyof MaterialState;
  label: string;
  hint?: string;
}

export type ControlDef =
  | SliderDef
  | ColorDef
  | ToggleDef
  | SelectDef
  | MaterialSliderDef
  | MaterialColorDef
  | MaterialToggleDef
  | SlotSliderDef
  | SlotColorDef
  | SlotToggleDef;

export interface GroupDef {
  id: string;
  title: string;
  open: boolean;
  controls: ControlDef[];
  /**
   * 面板归属：'left' = 左侧层级/资源栏；'right' = 右侧属性 Inspector。
   * 右侧再按 tab 落到具体分页（检视 / 场景光照 / 渲染），实现游戏软件常识性的左右拆分。
   */
  side: 'left' | 'right';
  /** side==='right' 时生效：落到哪个右侧分页 */
  tab?: 'inspector' | 'scene' | 'render';
}

/** 选中物体的可编辑状态 —— 由 renderer.getObjectState 填充，面板用这个同步控件 */
export interface SelectionInfo {
  name: string;
  /** 世界坐标（米） */
  pos: [number, number, number];
  /** 欧拉角（弧度，XYZ） */
  rot: [number, number, number];
  scale: number;
  /** 当前使用的材质索引（0-5） */
  materialIndex: number;
  stats: { vertices: number; triangles: number; boundaryEdges: number; components: number };
}

/** 选择面板里「材质」下拉：与 defaultParams().materials 索引一一对应 */
export const MATERIAL_OPTIONS = [
  { label: '0 · 僵尸绿（skin）', value: 0 },
  { label: '1 · 地面灰（cloth）', value: 1 },
  { label: '2 · 皮肤（skin）', value: 2 },
  { label: '3 · 金属（metal）', value: 3 },
  { label: '4 · 自发光（emissive）', value: 4 },
  { label: '5 · 布料（cloth）', value: 5 },
];

export const TONEMAP_OPTIONS = [
  { label: 'None（线性截断）', value: 0 },
  { label: 'Reinhard', value: 1 },
  { label: 'ACES（Narkowicz 近似）', value: 2 },
  { label: 'AgX（推荐）', value: 3 },
];

export const DEBUG_OPTIONS = [
  { label: '最终画面', value: 0 },
  { label: 'Albedo', value: 1 },
  { label: '世界法线', value: 2 },
  { label: 'NdotL（灰度）', value: 3 },
  { label: '分阶 ID', value: 4 },
  { label: '灯光贡献分解', value: 5 },
  { label: '描边 mask', value: 6 },
  { label: 'UV 坐标（RG）', value: 7 },
  { label: 'UV 棋盘格', value: 8 },
];

export const EDIT_TARGETS = [
  { label: '角色（中心胶囊）', value: 0 },
  { label: '地面', value: 1 },
  { label: '球体（skin）', value: 2 },
  { label: '立方体（metal）', value: 3 },
  { label: '圆柱（emissive）', value: 4 },
  { label: '胶囊（cloth）', value: 5 },
];

export const PARAM_GROUPS: GroupDef[] = [
  {
    id: 'hierarchy',
    title: '场景层级 Hierarchy',
    open: true,
    side: 'left',
    controls: [],
  },
  {
    id: 'model',
    title: '模型预览',
    open: true,
    side: 'left',
    controls: [],
  },
  {
    id: 'selection',
    title: '对象选择与变换',
    open: true,
    side: 'right',
    tab: 'inspector',
    controls: [],
  },
  {
    id: 'preset',
    title: '关卡灯光预设',
    open: true,
    side: 'right',
    tab: 'scene',
    controls: [],
  },
  {
    id: 'key',
    title: 'Key 主光（唯一分阶）',
    open: true,
    side: 'right',
    tab: 'scene',
    controls: [
      { kind: 'slider', key: 'keyAzimuth', label: '方位角', min: -180, max: 180, step: 1 },
      {
        kind: 'slider',
        key: 'keyElevation',
        label: '仰角',
        min: 0,
        max: 90,
        step: 1,
        hint: 'god view 55° 下禁止超过 60°，否则角色正面 NdotL 处处接近 1，会变成没有结构的平色。',
      },
      { kind: 'slider', key: 'keyIntensity', label: '强度', min: 0, max: 3, step: 0.01 },
      { kind: 'color', key: 'keyColor', label: '颜色' },
    ],
  },
  {
    id: 'fill',
    title: 'Fill 半球环境（不分阶）',
    open: true,
    side: 'right',
    tab: 'scene',
    controls: [
      { kind: 'color', key: 'fillSkyColor', label: '天空色' },
      { kind: 'slider', key: 'fillSkyIntensity', label: '天空强度', min: 0, max: 1.5, step: 0.01 },
      { kind: 'color', key: 'fillGroundColor', label: '地面反弹色' },
      { kind: 'slider', key: 'fillGroundIntensity', label: '地面强度', min: 0, max: 1.5, step: 0.01 },
      { kind: 'color', key: 'ambientColor', label: '常数环境' },
      { kind: 'slider', key: 'ambientIntensity', label: '环境强度', min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    id: 'rim',
    title: 'Rim 边缘光（不分阶）',
    open: true,
    side: 'right',
    tab: 'scene',
    controls: [
      { kind: 'color', key: 'rimColor', label: '颜色' },
      {
        kind: 'slider',
        key: 'rimIntensity',
        label: '强度',
        min: 0,
        max: 2,
        step: 0.01,
        hint: '暗幕（Act3 地铁）下这是可读性刚需，深色敌人没有 rim 会直接消失在背景里。',
      },
      { kind: 'slider', key: 'rimPower', label: '锐度（power）', min: 0.5, max: 8, step: 0.1 },
      {
        kind: 'slider',
        key: 'rimTopBias',
        label: '顶边缘偏置',
        min: 0,
        max: 1,
        step: 0.01,
        hint: '俯视角下把 rim 往头顶轮廓偏，补偿 god view 的观察角度。',
      },
    ],
  },
  {
    id: 'point',
    title: '局部点光（调试用）',
    open: false,
    side: 'right',
    tab: 'scene',
    controls: [
      { kind: 'toggle', key: 'pointEnabled', label: '启用点光' },
      { kind: 'color', key: 'pointColor', label: '颜色' },
      { kind: 'slider', key: 'pointIntensity', label: '强度', min: 0, max: 6, step: 0.01 },
      { kind: 'slider', key: 'pointRange', label: '半径', min: 0.5, max: 12, step: 0.1 },
      { kind: 'toggle', key: 'pointOrbit', label: '自动环绕' },
      {
        kind: 'slider',
        key: 'fogDensity',
        label: '雾密度',
        min: 0,
        max: 0.12,
        step: 0.001,
        hint: '雾颜色必须与 fill 天空色同色系，否则远处物体会跳出雾。',
      },
      { kind: 'color', key: 'fogColor', label: '雾颜色' },
    ],
  },
  {
    id: 'toon',
    title: 'Toon 分阶',
    open: true,
    side: 'right',
    tab: 'render',
    controls: [
      { kind: 'slider', key: 'shadowEnd', label: '暗部上界', min: 0, max: 1, step: 0.005 },
      { kind: 'slider', key: 'specStart', label: '高光下界', min: 0, max: 1, step: 0.005 },
      {
        kind: 'slider',
        key: 'edgeSoftness',
        label: '软边宽度',
        min: 0,
        max: 0.2,
        step: 0.001,
        hint: '实际软边 = fwidth(NdotL) * 0.5 + 此值。屏幕空间导数自适应是抗锯齿的关键。',
      },
      { kind: 'slider', key: 'shadowMult', label: '暗部亮度倍率', min: 0, max: 1.5, step: 0.01 },
      {
        kind: 'slider',
        key: 'shadowMix',
        label: '暗部染色比例',
        min: 0,
        max: 1,
        step: 0.01,
        hint: '暗部要往紫蓝色相偏移，而不是压成灰 —— 这是保住高饱和撞色的核心。',
      },
      { kind: 'slider', key: 'shadowSat', label: '暗部饱和度', min: 0, max: 2, step: 0.01 },
      { kind: 'slider', key: 'litSat', label: '亮部饱和度', min: 0, max: 2, step: 0.01 },
      { kind: 'slider', key: 'specMix', label: '高光混色比例', min: 0, max: 1, step: 0.01 },
      { kind: 'color', key: 'shadowTint', label: '暗部染色（night-deep）' },
      { kind: 'color', key: 'specTint', label: '高光混色（bone）' },
    ],
  },
  {
    id: 'outline',
    title: '描边（inverted hull）',
    open: true,
    side: 'right',
    tab: 'render',
    controls: [
      { kind: 'toggle', key: 'outlineEnabled', label: '启用描边' },
      {
        kind: 'slider',
        key: 'outlineWidth',
        label: '线宽（px @1080p）',
        min: 0,
        max: 12,
        step: 0.5,
        hint: 'tokens：hero/elite 6px，普通僵尸 4px，近处道具 3px，远处道具 2px。',
      },
      {
        kind: 'toggle',
        key: 'outlineDistanceComp',
        label: '屏幕空间恒定补偿',
        hint: '世界外扩量正比于到相机距离，远处描边才不会细到看不见。',
      },
      {
        kind: 'toggle',
        key: 'outlinePostExempt',
        label: '后处理豁免',
        hint: '描边像素跳过 grading / 半调 / 暗角，否则纯 ink 色会被 tonemap 冲淡成灰。',
      },
      { kind: 'color', key: 'inkColor', label: '描边色（禁止纯黑）' },
    ],
  },
  {
    id: 'halftone',
    title: '半调网点',
    open: true,
    side: 'right',
    tab: 'render',
    controls: [
      { kind: 'toggle', key: 'halftoneEnabled', label: '启用网点' },
      { kind: 'slider', key: 'halftoneSize', label: '网点尺寸（px）', min: 2, max: 16, step: 0.5 },
      {
        kind: 'slider',
        key: 'halftoneStrength',
        label: '强度',
        min: 0,
        max: 0.6,
        step: 0.01,
        hint: '硬上限 0.25。超过就从印刷质感变成波普艺术了。',
      },
      {
        kind: 'slider',
        key: 'halftoneThreshold',
        label: '亮度阈值',
        min: 0,
        max: 1,
        step: 0.01,
        hint: '只叠暗部。默认 0.45。',
      },
    ],
  },
  {
    id: 'post',
    title: '后处理',
    open: true,
    side: 'right',
    tab: 'render',
    controls: [
      { kind: 'select', key: 'tonemapMode', label: 'Tonemap', options: TONEMAP_OPTIONS },
      { kind: 'slider', key: 'exposure', label: '曝光', min: 0.1, max: 4, step: 0.01 },
      { kind: 'toggle', key: 'gradeEnabled', label: '启用 Grading' },
      { kind: 'toggle', key: 'bloomEnabled', label: '启用 Bloom' },
      { kind: 'slider', key: 'bloomThreshold', label: 'Bloom 阈值', min: 0, max: 4, step: 0.01 },
      { kind: 'slider', key: 'bloomIntensity', label: 'Bloom 强度', min: 0, max: 2, step: 0.01 },
      { kind: 'slider', key: 'vignette', label: '暗角', min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    id: 'grading',
    title: 'Grading 三段调色',
    open: false,
    side: 'right',
    tab: 'render',
    controls: [
      { kind: 'slider', key: 'gradeShadowRange', label: '暗部上界', min: 0, max: 1, step: 0.01 },
      { kind: 'slider', key: 'gradeMidRange', label: '中间调上界', min: 0, max: 1, step: 0.01 },
      { kind: 'slider', key: 'gradeEdge', label: '段间过渡', min: 0, max: 0.3, step: 0.005 },
      { kind: 'slider', key: 'gradeShadowMult', label: '暗部倍率', min: 0, max: 2, step: 0.01 },
      { kind: 'slider', key: 'gradeShadowMix', label: '暗部染紫蓝', min: 0, max: 1, step: 0.01 },
      { kind: 'slider', key: 'gradeShadowSat', label: '暗部饱和度', min: 0, max: 2, step: 0.01 },
      { kind: 'slider', key: 'gradeMidSat', label: '中间调饱和度', min: 0, max: 2, step: 0.01 },
      { kind: 'slider', key: 'gradeLightMult', label: '亮部倍率', min: 0, max: 2, step: 0.01 },
      { kind: 'slider', key: 'gradeLightMix', label: '亮部混 bone', min: 0, max: 1, step: 0.01 },
      { kind: 'slider', key: 'gradeLightSat', label: '亮部饱和度', min: 0, max: 2, step: 0.01 },
    ],
  },
  {
    id: 'mesh-material',
    title: 'Mesh 材质（Material Slot）',
    open: true,
    side: 'right',
    tab: 'inspector',
    controls: [],
  },
  {
    id: 'material',
    title: '材质（共享材质库）',
    open: true,
    side: 'right',
    tab: 'render',
    controls: [
      { kind: 'select', key: 'editTarget', label: '编辑目标', options: EDIT_TARGETS },
      { kind: 'material-color', field: 'albedo', label: 'Albedo' },
      { kind: 'material-slider', field: 'roughness', label: '粗糙度', min: 0, max: 1, step: 0.01 },
      { kind: 'material-slider', field: 'metallic', label: '金属度', min: 0, max: 1, step: 0.01 },
      { kind: 'material-color', field: 'emissiveColor', label: '自发光颜色' },
      {
        kind: 'material-slider',
        field: 'emissiveStrength',
        label: '自发光强度',
        min: 0,
        max: 8,
        step: 0.01,
      },
      {
        kind: 'material-slider',
        field: 'shadowEnd',
        label: '分阶阈值',
        min: -1,
        max: 1,
        step: 0.005,
        hint: '-1 = 跟随全局。emissive 材质建议设 0（不分阶）。',
      },
      {
        kind: 'material-slider',
        field: 'specMix',
        label: '高光混色',
        min: -1,
        max: 1,
        step: 0.01,
        hint: '-1 = 跟随全局。布料设 0。',
      },
      {
        kind: 'material-slider',
        field: 'softnessScale',
        label: '软边倍率',
        min: 0.2,
        max: 4,
        step: 0.05,
        hint: '布料放大到 2.0 左右，硬边过渡更柔。',
      },
      {
        kind: 'material-slider',
        field: 'halftoneScale',
        label: '半调倍率',
        min: 0,
        max: 2,
        step: 0.05,
        hint: '金属设 0，皮肤设 1.2。',
      },
      {
        kind: 'material-slider',
        field: 'outlineScale',
        label: '描边倍率',
        min: 0,
        max: 3,
        step: 0.05,
        hint: '金属盾板 1.5，普通僵尸 1.0。',
      },
      {
        kind: 'material-toggle',
        field: 'unlit',
        label: 'Unlit（跳过全部分阶）',
        hint: '发光接口、毒液用。直接输出 albedo + emissive。',
      },
    ],
  },
  {
    id: 'debug',
    title: '调试视图与相机',
    open: true,
    side: 'right',
    tab: 'render',
    controls: [
      { kind: 'select', key: 'debugMode', label: '调试视图', options: DEBUG_OPTIONS },
      {
        kind: 'slider',
        key: 'cameraElevation',
        label: '相机俯仰',
        min: -89,
        max: 89,
        step: 1,
        hint: '项目默认 55°（俯视）。向下拖到 0 即地平线视角，继续为负即仰视（eye 在角色之下，可查下巴/底面受光）。91° 范围两端各留 1° 余量避免 lookAt 退化。',
      },
      { kind: 'toggle', key: 'autoOrbit', label: '自动环绕' },
    ],
  },
];

/** 从 tokens.json 派生的默认值 */
export function defaultParams(): LabParams {
  return {
    keyAzimuth: -38,
    keyElevation: 42,
    keyIntensity: 2.1,
    keyColor: '#FFE3BC',

    fillSkyColor: '#7E92C4',
    fillSkyIntensity: 0.62,
    fillGroundColor: '#C49A72',
    fillGroundIntensity: 0.34,

    rimColor: '#FFE0B0',
    rimIntensity: 0.5,
    rimPower: 3.2,
    rimTopBias: 0.5,

    ambientColor: '#4E5370',
    ambientIntensity: 0.42,

    pointEnabled: false,
    pointColor: '#FF6A3D',
    pointIntensity: 2.2,
    pointRange: 5.0,
    pointOrbit: true,

    fogColor: '#6E7A9A',
    fogDensity: 0.016,

    shadowEnd: 0.5,
    specStart: 0.88,
    edgeSoftness: 0.045,
    shadowMult: 0.75,
    shadowMix: 0.3,
    shadowSat: 1.05,
    litSat: 1.18,
    specMix: 0.35,
    shadowTint: '#241E33',
    specTint: '#FFF6E2',

    outlineEnabled: true,
    outlineWidth: 4,
    outlineDistanceComp: true,
    outlinePostExempt: true,
    inkColor: '#14110F',

    halftoneEnabled: true,
    halftoneSize: 5,
    halftoneStrength: 0.1,
    halftoneThreshold: 0.4,

    tonemapMode: 3,
    exposure: 1.5,
    bloomEnabled: true,
    bloomThreshold: 1.3,
    bloomIntensity: 0.3,
    vignette: 0.06,

    gradeEnabled: true,
    gradeShadowRange: 0.28,
    gradeMidRange: 0.7,
    gradeEdge: 0.06,
    gradeShadowMult: 0.95,
    gradeShadowMix: 0.12,
    gradeShadowSat: 1.15,
    gradeMidSat: 1.14,
    gradeLightMult: 1.04,
    gradeLightMix: 0.12,
    gradeLightSat: 1.06,

    debugMode: 0,
    cameraElevation: 55,
    autoOrbit: false,

    editTarget: 0,
    materials: [
      {
        albedo: '#8FD14F',
        roughness: 0.62,
        metallic: 0.0,
        emissiveColor: '#000000',
        emissiveStrength: 0,
        shadowEnd: -1,
        specMix: -1,
        softnessScale: 1.0,
        halftoneScale: 1.0,
        outlineScale: 1.0,
        unlit: false,
      },
      {
        albedo: '#1B1F2B',
        roughness: 0.9,
        metallic: 0.0,
        emissiveColor: '#000000',
        emissiveStrength: 0,
        shadowEnd: -1,
        specMix: 0.0,
        softnessScale: 1.4,
        halftoneScale: 0.6,
        outlineScale: 0.0,
        unlit: false,
      },
      {
        albedo: '#8FD14F',
        roughness: 0.55,
        metallic: 0.0,
        emissiveColor: '#000000',
        emissiveStrength: 0,
        shadowEnd: -1,
        specMix: -1,
        softnessScale: 1.0,
        halftoneScale: 1.2,
        outlineScale: 1.0,
        unlit: false,
      },
      {
        albedo: '#7A8290',
        roughness: 0.28,
        metallic: 0.95,
        emissiveColor: '#2BC4D6',
        emissiveStrength: 0.15,
        shadowEnd: -1,
        specMix: 0.55,
        softnessScale: 0.7,
        halftoneScale: 0.0,
        outlineScale: 1.5,
        unlit: false,
      },
      {
        albedo: '#E8402A',
        roughness: 0.4,
        metallic: 0.0,
        emissiveColor: '#E8402A',
        emissiveStrength: 3.2,
        shadowEnd: 0.0,
        specMix: 0.0,
        softnessScale: 1.0,
        halftoneScale: 0.0,
        outlineScale: 1.0,
        unlit: true,
      },
      {
        albedo: '#C8B89A',
        roughness: 0.95,
        metallic: 0.0,
        emissiveColor: '#000000',
        emissiveStrength: 0,
        shadowEnd: -1,
        specMix: 0.0,
        softnessScale: 2.0,
        halftoneScale: 1.0,
        outlineScale: 1.0,
        unlit: false,
      },
      // 6 · 天空穹顶（背景）：白 albedo + 半球填充光自然形成上→下渐变，outlineScale=0 不描边
      {
        albedo: '#FFFFFF',
        roughness: 1.0,
        metallic: 0.0,
        emissiveColor: '#000000',
        emissiveStrength: 0,
        shadowEnd: -1,
        specMix: -1,
        softnessScale: 1.0,
        halftoneScale: 0.0,
        outlineScale: 0.0,
        unlit: false,
      },
    ],
  };
}
