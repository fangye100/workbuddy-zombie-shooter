/** Isolated real metadata CLI: protagonist products, raw LOD0 skip and preserve authored fields. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,readFile,writeFile,access,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';import {execFileSync} from 'node:child_process';
const repo=fileURLToPath(new URL('../..',import.meta.url)),root=await mkdtemp(path.join(tmpdir(),'meta-roster-'));
assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir())+path.sep+'meta-roster-'));
try {
 const script=path.join(root,'tools/scene/gen-asset-meta.mjs');await mkdir(path.dirname(script),{recursive:true});await copyFile(path.join(repo,'tools/scene/gen-asset-meta.mjs'),script);
 const roster=path.join(root,'packages/content/src/generated/roster.generated.ts');await mkdir(path.dirname(roster),{recursive:true});await copyFile(path.join(repo,'packages/content/src/generated/roster.generated.ts'),roster);
 const source=path.join(repo,'assets/characters/models/E-04/game_ready/E04_20260901_010134_1600tris.glb');const products=[];
 for(const variant of ['game_ready','rigged','textured']){const asset=path.join(root,`assets/characters/models/H-01/${variant}/H01_fixture.glb`);await mkdir(path.dirname(asset),{recursive:true});await copyFile(source,asset);products.push(asset)}
 const raw=path.join(root,'assets/characters/models/H-01/H01_20261003_000000.glb');await copyFile(source,raw);
 console.log(execFileSync(process.execPath,[script],{encoding:'utf8'}));
 for(const asset of products){const meta=JSON.parse(await readFile(asset+'.meta.json','utf8'));console.log(JSON.stringify({variant:path.basename(path.dirname(asset)),actual:meta.importer.normalizeHeightM,expected:1.8,characterId:meta.userData.characterId}));assert.equal(meta.importer.normalizeHeightM,1.8);assert.equal(meta.userData.characterId,'H-01')}
 await assert.rejects(access(raw+'.meta.json'));console.log('PASS H-01 product height 1.8m from generated roster; raw LOD0 excluded');
 const chosen=products[0]+'.meta.json',custom=JSON.parse(await readFile(chosen,'utf8'));custom.importer.normalizeHeightM=null;custom.bindings=[{authored:'preserve'}];custom.rig={authored:'preserve'};custom.userData.custom={keep:1};await writeFile(chosen,JSON.stringify(custom));
 console.log(execFileSync(process.execPath,[script],{encoding:'utf8'}));const preserved=JSON.parse(await readFile(chosen,'utf8'));assert.equal(preserved.guid,custom.guid);assert.equal(preserved.importer.normalizeHeightM,null);assert.deepEqual(preserved.bindings,custom.bindings);assert.deepEqual(preserved.rig,custom.rig);assert.deepEqual(preserved.userData.custom,custom.userData.custom);
 console.log(execFileSync(process.execPath,[script,'--check'],{encoding:'utf8'}));console.log('PASS existing explicit normalization/bindings/rig/userData/guid retained; check mode coherent');
} finally {await rm(root,{recursive:true,force:true})}
