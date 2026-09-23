import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ensureLinkedSourceOnDisk} from './source-recovery.mjs';

const source={storedName:'original.mp4',materialCenterAssetId:17,materialCenterObjectKey:'objects/original.mp4',size:5,productCategory:'黑晶面膜',visibility:'team'};
const asset={id:17,objectKey:'objects/original.mp4',size:5,category:'黑晶面膜',downloadUrl:'https://assets.example.test/original.mp4'};
async function fixture(t){const dir=await mkdtemp(path.join(tmpdir(),'wis-source-recovery-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
const options=dir=>({source,asset,identity:{id:'worker'},sourcesDir:dir,maxFileBytes:100,downloadAsset:async(_asset,destination)=>writeFile(destination,'video'),inspectMedia:async()=>({duration:5}),hashFile:async()=>''});

test('missing linked original is recovered once without changing the source record',async t=>{
  const dir=await fixture(t),args=options(dir);
  const first=await ensureLinkedSourceOnDisk(args);
  assert.equal(first.restored,true);assert.equal(await readFile(first.path,'utf8'),'video');
  args.downloadAsset=async()=>{throw Error('duplicate download');};
  assert.equal((await ensureLinkedSourceOnDisk(args)).restored,false);
});

test('conflicting category and changed object version are rejected before download',async t=>{
  const dir=await fixture(t);let calls=0;
  const args={...options(dir),downloadAsset:async()=>{calls++;}};
  await assert.rejects(ensureLinkedSourceOnDisk({...args,asset:{...asset,category:'晶润紧致眼膜'}}),/分类/);
  await assert.rejects(ensureLinkedSourceOnDisk({...args,asset:{...asset,objectKey:'new-version'}}),/版本/);
  assert.equal(calls,0);
});

test('unclassified cloud asset never becomes an automatic remix source',async t=>{
  const dir=await fixture(t);let calls=0;
  await assert.rejects(ensureLinkedSourceOnDisk({...options(dir),asset:{...asset,category:'待分类'},downloadAsset:async()=>{calls++;}}),/分类尚未确认/);
  assert.equal(calls,0);
});

test('a symlink cannot satisfy a missing original or escape the source directory',async t=>{
  const dir=await fixture(t),outside=path.join(dir,'outside');
  await writeFile(outside,'video');
  try{await symlink(outside,path.join(dir,source.storedName));}
  catch(error){if(error?.code==='EPERM'){t.skip('host forbids symlink creation');return;}throw error;}
  let calls=0;
  await assert.rejects(ensureLinkedSourceOnDisk({...options(dir),downloadAsset:async()=>{calls++;}}),/未覆盖/);
  assert.equal(calls,0);assert.equal(await readFile(outside,'utf8'),'video');
});

test('existing conflicting file stays untouched and no replacement is attempted',async t=>{
  const dir=await fixture(t),destination=path.join(dir,source.storedName);
  await writeFile(destination,'wrong-size');let calls=0;
  await assert.rejects(ensureLinkedSourceOnDisk({...options(dir),downloadAsset:async()=>{calls++;}}),/未覆盖/);
  assert.equal(await readFile(destination,'utf8'),'wrong-size');assert.equal(calls,0);
});

test('incomplete download is removed and cannot become an available source',async t=>{
  const dir=await fixture(t),args={...options(dir),downloadAsset:async(_asset,destination)=>writeFile(destination,'no')};
  await assert.rejects(ensureLinkedSourceOnDisk(args),/不完整/);
  const files=await import('node:fs/promises').then(fs=>fs.readdir(dir));
  assert.deepEqual(files,[]);
});

test('legacy cloud category restores the same source without rewriting its classification',async t=>{
  const dir=await fixture(t);
  const legacy={...source,materialCenterCategory:'隐形水润面膜'};delete legacy.productCategory;
  const before=structuredClone(legacy);
  const args={...options(dir),source:legacy,asset:{...asset,category:'WIS隐形水润面膜'}};
  assert.equal((await ensureLinkedSourceOnDisk(args)).restored,true);
  assert.deepEqual(legacy,before);
  await assert.rejects(ensureLinkedSourceOnDisk({...args,asset:{...asset,category:'黑晶面膜'}}),/分类存在冲突/);
});

test('missing recorded category cannot be inferred from a filename or current cloud category',async t=>{
  const dir=await fixture(t),legacy={...source,originalName:'黑晶面膜.mp4'};delete legacy.productCategory;
  await assert.rejects(ensureLinkedSourceOnDisk({...options(dir),source:legacy}),/分类尚未确认/);
});
