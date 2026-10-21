import { validateVfxAsset, migrateVfxAsset, type VfxAsset } from '@aether/scene';
import { AuthorResourceDocument } from './author-resource-document';

/** 原 VFX 公开入口保留；历史/CAS实现与其它类型化资产共用。 */
export class VfxDocument extends AuthorResourceDocument<VfxAsset> {
  constructor(path: string, asset: VfxAsset) {
    super(path, asset, { label: 'VFX', validate: validateVfxAsset, migrate: migrateVfxAsset });
  }
}
