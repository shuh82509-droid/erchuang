import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createReadonlyLibrarySnapshot} from './readonly-library-snapshot.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'readonly-snapshot-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));
  const file = path.join(dir, 'library.json');
  await fs.writeFile(file, '{"value":1}');
  const replace = async text => {
    const temp = path.join(dir, 'next.json');
    await fs.writeFile(temp, text); await fs.rename(temp, file);
  };
  return {dir, file, replace};
}

test('atomic same-size replacement invalidates cache once; unchanged reads reuse object', async t => {
  const f=await fixture(t);let reloads=0,reads=0;
  const read=createReadonlyLibrarySnapshot({file:f.file,onReload:()=>reloads++,io:{lstat:fs.lstat,readFile:async(...a)=>{reads++;return fs.readFile(...a);}}});
  const original=await read();assert.equal(await read(),original);assert.equal(reads,1);
  await f.replace('{"value":2}');const next=await read();assert.equal(next.value,2);assert.notEqual(next,original);assert.equal(reloads,2);
});

test('invalid replacement and missing file never serve old object as fresh, then recover', async t => {
  const f=await fixture(t);const read=createReadonlyLibrarySnapshot({file:f.file});await read();
  await f.replace('{broken');await assert.rejects(read());
  await fs.unlink(f.file);await assert.rejects(read(),{code:'ENOENT'});
  await f.replace('{"value":3}');assert.equal((await read()).value,3);
});

test('concurrent refreshes share a single parse and invalidation', async t => {
  const f=await fixture(t);let reads=0,reloads=0;
  const read=createReadonlyLibrarySnapshot({file:f.file,onReload:()=>reloads++,io:{lstat:fs.lstat,readFile:async(...a)=>{reads++;return fs.readFile(...a);}}});
  const values=await Promise.all(Array.from({length:20},()=>read()));assert.equal(reads,1);assert.equal(reloads,1);assert.ok(values.every(v=>v===values[0]));
});

test('file replaced during read is re-read before becoming current', async t => {
  const f=await fixture(t);let reads=0;
  const read=createReadonlyLibrarySnapshot({file:f.file,io:{lstat:fs.lstat,readFile:async(...a)=>{const b=await fs.readFile(...a);if(++reads===1)await f.replace('{"value":4}');return b;}}});
  assert.equal((await read()).value,4);assert.equal(reads,2);
});

test('continuous replacement stops after a bounded number of reads', async t => {
  const f=await fixture(t);let reads=0;
  const read=createReadonlyLibrarySnapshot({file:f.file,io:{lstat:fs.lstat,readFile:async(...a)=>{const b=await fs.readFile(...a);await f.replace(JSON.stringify({value:++reads}));return b;}}});
  await assert.rejects(read(),/正在更新/);assert.equal(reads,3);
});
