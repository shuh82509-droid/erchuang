import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClipRemixService } from '../render-worker/clip-remix-service.mjs';

test('read-only real service preserves identity, historical jobs and original file bytes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wis-readonly-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const libraryPath = path.join(root, 'clip-remix', 'library.json');
  await fs.mkdir(path.dirname(libraryPath));
  const original = JSON.stringify({version:7, sources:[], clips:[], renders:[], frameworks:[], folders:[],
    autoJobs:[{id:'original',createdById:'FD-026222',status:'paused',runs:[],scheduleEnabled:false}],
    verifiedAutoRemixIdentities:[], autoRemixGrants:[], accessAudit:[]});
  await fs.writeFile(libraryPath, original);
  const before = await fs.stat(libraryPath);
  let mediaCalls = 0;
  const media = async () => {mediaCalls++; throw Error('unexpected media work');};
  const service = createClipRemixService({dataDir:root,readOnly:true,nowIso:()=>new Date().toISOString(),
    inspectMedia:media,makeSegment:media,runFfmpeg:media,runProcess:media,
    readJsonBody:async()=>({}),jsonResponse:(res,status,body)=>Object.assign(res,{status,body}),
    materialCenter:{configured:false},cutter:{configured:false},autoRemixAdminUsers:'FD-026222'});
  await service.initialize();
  const identity={sub:'FD-026222',name:'Fixture'};
  for (const endpoint of ['/api/remix/library?view=compact','/api/remix/library/progress','/api/remix/automation/access']) {
    const res={setHeader(){}};
    await service.route({method:'GET',headers:{}},res,new URL(endpoint,'http://localhost'),identity);
    assert.equal(res.status,200,endpoint);
    if(endpoint.endsWith('/access')) assert.equal(res.body.access.isAdmin,true);
  }
  const denied={};
  await service.route({method:'POST'},denied,new URL('/api/remix/automation/access/grants','http://localhost'),identity);
  assert.equal(denied.status,423);
  assert.equal(await fs.readFile(libraryPath,'utf8'),original);
  assert.equal((await fs.stat(libraryPath)).mtimeMs,before.mtimeMs);
  assert.deepEqual(await fs.readdir(path.dirname(libraryPath)),['library.json']);
  assert.equal(mediaCalls,0);
});

test('read-only mode does not create an empty replacement when the real index is missing',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wis-readonly-missing-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const service=createClipRemixService({dataDir:root,readOnly:true,materialCenter:{configured:false},cutter:{configured:false}});
  await assert.rejects(service.initialize(),/ENOENT/);
  assert.deepEqual(await fs.readdir(root),[]);
});
