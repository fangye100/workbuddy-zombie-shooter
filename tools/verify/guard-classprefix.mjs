#!/usr/bin/env node
/**
 * 类名前缀回归闸门（ADR-008：验证资产与结论同入库）
 *
 * 背景：资产库面板曾用类名前缀 `ad-`（.ad-head / .ad-body / .ad-content /
 * .ad-title / .ad-filter / .ad-item / .ad-row …）。`ad-` 是 EasyList /
 * uBlock Origin / AdGuard 等广告拦截过滤列表的头号命中模式，会被注入
 * `display:none !important`，导致整个面板在装了拦截插件的浏览器里消失
 * —— 但 DOM 里 dock 仍有 316px 高、collapsed=false，headless 复现不出来，
 * 只有真机（带扩展）才可见。
 *
 * 本脚本禁止任何以 `ad-` / `adk-` 开头的类名、data-ad 属性、--ad-* CSS 变量
 * 重新出现。（以字母 ad 开头但不带连字符的词，如 add / admin / load，不受影响。）
 *
 * 用法：node tools/verify/guard-classprefix.mjs
 * 退出码：0 = 干净；1 = 发现违规（并打印文件:行号）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCAN_DIRS = ['apps', 'packages'];
const EXT = /\.(ts|tsx|js|jsx|mjs|html|css)$/;
const SKIP_DIR = /(\\|\/)(node_modules|dist|\.git|\.smoke|\.workbuddy|test)(\\|\/)/;

/**
 * 违规模式：
 *  1. class="..." / className 里的 ad-xxx、adk-xxx
 *  2. querySelector('.ad-xxx') 之类的选择器
 *  3. data-ad / data-adk 属性
 *  4. --ad-xxx CSS 自定义属性
 * 用 \b 边界 + 前导非字母，避开 load / add / admin 这类正常词。
 */
const RULES = [
  { re: /(?<=["'`\s.])ad(?=-)[a-z-]*\b/g, name: 'ad- 类名/选择器' },
  { re: /(?<=["'`\s.])adk(?=-)[a-z-]*\b/g, name: 'adk- 类名/选择器' },
  { re: /\bdata-adk?\b/g, name: 'data-ad / data-adk 属性' },
  { re: /--adk?-[a-z]/g, name: '--ad-* CSS 变量' },
];

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIR.test(p + '/')) walk(p, out);
    } else if (EXT.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/** 注释行里允许出现（那里是在解释为什么不能用），代码行里不允许 */
function stripComments(line) {
  // 整行注释 // ... 或 * ... 或 <!-- ... -->
  if (/^\s*(\/\/|\*|\/\*|<!--)/.test(line)) return '';
  return line;
}

const violations = [];
for (const d of SCAN_DIRS) {
  for (const file of walk(join(ROOT, d))) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    if (rel.endsWith('.bak-adprefix')) continue;
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((raw, i) => {
      const line = stripComments(raw);
      if (line === '') return;
      for (const { re, name } of RULES) {
        re.lastIndex = 0;
        if (re.test(line)) {
          violations.push(`${rel}:${i + 1}  [${name}]  ${raw.trim().slice(0, 100)}`);
        }
      }
    });
  }
}

if (violations.length > 0) {
  console.error('❌ 类名前缀闸门失败 —— 发现会被广告拦截插件命中的类名：\n');
  for (const v of violations) console.error('  ' + v);
  console.error(
    `\n共 ${violations.length} 处。改用 asset- / akind- / data-asset / --asset-* 前缀。\n` +
      '详情见 apps/editor/index.html 中「资产库 Asset Library」段落的注释。',
  );
  process.exit(1);
}

console.log('✅ 类名前缀闸门通过：无 ad- / adk- / data-ad / --ad-* 残留。');
