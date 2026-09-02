/// <reference types="vite/client" />

/** WGSL 以 ?raw / 插件形式导入时统一为字符串源码 */
declare module '*.wgsl' {
  const source: string;
  export default source;
}

/** .pak / .mesh 等运行时资产以 ArrayBuffer 形式导入（仅小体积资产适用） */
declare module '*.pak' {
  const bytes: ArrayBuffer;
  export default bytes;
}
