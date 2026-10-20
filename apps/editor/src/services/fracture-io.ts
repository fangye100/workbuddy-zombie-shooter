/** 编辑器侧碎片资产 IO：走 dev 中间件的 /__fs/file 端点（与场景/模型同一条读取链路）。 */
import { fileUrl } from '../asset-util';
import type { FractureAssetIO } from '@aether/runtime';

/** 生产 IO：文本按 UTF-8，二进制按 ArrayBuffer；非 2xx 都显式抛错。 */
export function createEditorFractureIO(): FractureAssetIO {
  return {
    async readText(path: string): Promise<string> {
      const res = await fetch(fileUrl(path));
      if (!res.ok) throw new Error('读取失败 HTTP ' + res.status + '：' + path);
      return await res.text();
    },
    async readBinary(path: string): Promise<ArrayBuffer> {
      const res = await fetch(fileUrl(path));
      if (!res.ok) throw new Error('读取失败 HTTP ' + res.status + '：' + path);
      return await res.arrayBuffer();
    },
  };
}
