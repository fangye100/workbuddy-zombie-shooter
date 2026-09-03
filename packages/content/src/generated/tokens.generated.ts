/**
 * 风格令牌（由 tokens.json 生成）
 *
 * ⚠️ 自动生成，请勿手改 —— 改真源后重跑：
 *    node packages/content/scripts/gen-content.mjs
 *
 * 真源：
 *   assets/style/tokens.json
 */


/** 一个色调停靠点。range 的语义由所属段落决定：
 *  grading 用显示亮度区间，toonRamp 用 NdotL 区间。 */
export interface ToneStop {
  readonly name: string;
  readonly range: readonly [number, number];
  readonly multiply: number;
  /** core 色组里的键名；null = 不做混色 */
  readonly mixTo: string | null;
  /** mixTo 解析后的 hex；null = 不做混色 */
  readonly mixToHex: string | null;
  readonly mix: number;
  readonly saturation: number;
}

export interface ToneCurve {
  readonly space: string;
  readonly edgeSoftness: number;
  readonly stops: readonly ToneStop[];
}

/** core 色组（真源 tokens.json → groups.core） */
export const CORE_COLORS = {
  "ink": "#14110F",
  "paper": "#F5E7C8",
  "bone": "#FFF6E2",
  "night": "#171327",
  "night-deep": "#0E0C16",
  "zombie": "#8FD14F",
  "blood": "#E8402A",
  "warn": "#FFC531",
  "teal": "#2BC4D6",
  "toxic": "#9B5DE5",
  "gold": "#FF9F1C"
} as const;

/** 每个色键的用途（真源 tokens.json → usage），用于让人看懂该用哪个色 */
export const COLOR_USAGE = {
  "ink": "所有描边与文字轮廓，禁止纯黑 #000",
  "paper": "UI 主底色 / 标签底 / 纸张质感",
  "bone": "高光与文字最高层级",
  "night": "HUD 面板底色，比纯黑更透气",
  "night-deep": "场景阴影端混合色（暗部色相偏移用）",
  "zombie": "敌人主色、毒系、可交互拾取高亮",
  "blood": "伤害、濒死、危险区域",
  "warn": "警告、倒计时、弹药告急",
  "teal": "科技/弹药/护盾与冷色补光",
  "toxic": "精英怪、异变、Debuff",
  "gold": "传说掉落、终极技能就绪"
} as const;

/** 尺寸/圆角类数值（真源 tokens.json → numbers） */
export const NUMBERS = {
  "stroke-ink": 4,
  "stroke-bold": 6,
  "radius-card": 18,
  "radius-panel": 24,
  "shadow-hard": 6
} as const;

/** 后期调色三段：暗部 / 中间调 / 亮部（真源 tokens.json → grading） */
export const GRADING: ToneCurve = {
  space: "sRGB display-referred，tonemap 之后、grading 之前（给 .cube LUT 用）",
  edgeSoftness: 0.06,
  stops: [
  {
    name: "shadow",
    range: [0, 0.28],
    multiply: 0.78,
    mixTo: "night-deep",
    mixToHex: "#0E0C16",
    mix: 0.2,
    saturation: 1.15,
  },
  {
    name: "mid",
    range: [0.28, 0.7],
    multiply: 0.98,
    mixTo: null,
    mixToHex: null,
    mix: 0,
    saturation: 1.14,
  },
  {
    name: "light",
    range: [0.7, 1],
    multiply: 1.04,
    mixTo: "bone",
    mixToHex: "#FFF6E2",
    mix: 0.12,
    saturation: 1.06,
  },
  ],
};

/** 卡通分级（真源 tokens.json → toonRamp）。这是生产分阶的唯一真源。 */
export const TOON_RAMP: ToneCurve = {
  space: "按 NdotL 分阶，在材质着色器里做（这是生产分阶的唯一真源）",
  edgeSoftness: 0.035,
  stops: [
  {
    name: "shadow",
    range: [0, 0.3],
    multiply: 0.55,
    mixTo: "night-deep",
    mixToHex: "#0E0C16",
    mix: 0.3,
    saturation: 1.05,
  },
  {
    name: "lit",
    range: [0.3, 1],
    multiply: 1,
    mixTo: null,
    mixToHex: null,
    mix: 0,
    saturation: 1.12,
  },
  {
    name: "spec",
    range: [0.88, 1],
    multiply: 1.06,
    mixTo: "bone",
    mixToHex: "#FFF6E2",
    mix: 0.35,
    saturation: 1,
  },
  ],
};

export const OUTLINE = {
  "method": "inverted hull（背面外扩）",
  "widthStorage": "顶点色 R 通道（0–1 映射到 0–8mm 世界空间外扩）",
  "widthsPxAt1080p": {
    "hero": 6,
    "elite": 6,
    "common-zombie": 4,
    "prop-near": 3,
    "prop-far": 2,
    "ui": 4,
    "ui-bold": 6
  }
} as const;

export const STYLE_VERSION = "1.0.0" as const;
