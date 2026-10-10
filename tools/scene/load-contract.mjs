/** Node 工具读取当前场景公共契约，避免复制 schema 版本或默认配置。 */
import { build } from 'esbuild';
import { mkdirSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export async function loadSceneContract() {
  const out=resolve(root,`.workbuddy/tmp/scene-contract-${process.pid}.mjs`);
  mkdirSync(dirname(out),{recursive:true});
  await build({entryPoints:[resolve(root,'packages/scene/src/index.ts')],bundle:true,platform:'node',format:'esm',outfile:out,tsconfig:resolve(root,'tsconfig.check.json')});
  try { return await import(pathToFileURL(out).href); }
  finally { unlinkSync(out); }
}
