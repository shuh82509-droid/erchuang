import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createClipRemixService} from '../clip-remix-service.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');

async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wis-asr-isolated-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const root=path.join(dir,'clip-remix'),libraryPath=path.join(root,'library.json');
  await fs.mkdir(path.join(root,'sources'),{recursive:true});
  const bytes=Buffer.from('isolated source, never a production asset');
  const srt=Buffer.from('1\n00:00:10,410 --> 00:00:16,013\n说话人 1: 已核对的隔离测试句。\n');
  const source={id:'fixture-source',originalName:'fixture.mp4',storedName:'fixture.mp4',visibility:'private',createdById:'A',productCategory:'水润面膜',durationSeconds:20,hasAudio:true,frameRate:30,analysisStatus:'ready',analysisProvider:'manual',analysisRuleVersion:'integer-second-boundary-guard-v3',analysisMessage:'original',speechSegments:[{id:'original-segment',label:'原人工复核记录',startSeconds:1,endSeconds:5,requiresReview:false,manualEditedAt:'2026-01-01'}]};
  const job={id:'fixture-original-job',createdById:'A',status:'paused',scheduleEnabled:false,variantCount:2,durationSeconds:90,runs:[{id:'fixture-original-run',status:'awaiting_sources',attemptedCount:0}]};
  await fs.writeFile(path.join(root,'sources',source.storedName),bytes);
  await fs.writeFile(libraryPath,JSON.stringify({version:7,sources:[source],clips:[],folders:[],frameworks:[],autoJobs:[job],renders:[]}));
  const budgetPath=path.join(root,'fixture-original-budget.json');
  await fs.writeFile(budgetPath,JSON.stringify({reserved:3,limit:4,runId:'fixture-original-run'}));
  const input={source:{id:source.id,productCategory:source.productCategory,skuVersion:'test-only-sku',durationSeconds:20,sha256:hash(bytes),srtSha256:hash(srt),minuteToken:'test-minute'},srtBytes:srt,receipts:{drive:{ok:true,identity:'user',data:{size:bytes.length,file_token:'test-file',version:'1'}},minute:{ok:true,identity:'user',data:{minute_token:'test-minute'}},detail:{ok:true,identity:'user',data:{minutes:[{minute_token:'test-minute'}]}},export:{size_bytes:srt.length}},frameMap:{sourceSha256:hash(bytes),starts:Array.from({length:600},(_,i)=>Number((i/30).toFixed(6))),end:20}};
  let reads=0,resolveHook=async()=>input,cutHook=async args=>fs.writeFile(args.outputPath,'isolated-cut');
  const service=createClipRemixService({dataDir:dir,nowIso:()=>new Date().toISOString(),inspectMedia:async()=>({duration:20,hasAudio:true,frameRate:30,width:1080,height:1920}),makeSegment:async args=>cutHook(args),runFfmpeg:async()=>{throw Error('ASR import must not transcode');},runProcess:async()=>{throw Error('verified ASR must not run OCR');},readJsonBody:async req=>req.body||{},jsonResponse:(res,status,body)=>Object.assign(res,{status,body}),materialCenter:{configured:false},cutter:{configured:false},trustedAsrResolver:async request=>{reads++;assert.equal(request.sourceId,source.id);return resolveHook();}});
  await service.initialize();
  const request=async(method,suffix='',owner='A',body={})=>{const res={};await service.route({method,headers:{},body},res,new URL('http://localhost/api/remix/sources/'+source.id+suffix),{sub:owner,name:'Isolated fixture'});return res;};
  const snapshot=async()=>JSON.parse(await fs.readFile(libraryPath,'utf8'));
  const clip=async body=>{const res={};await service.route({method:'POST',headers:{},body},res,new URL('http://localhost/api/remix/clips'),{sub:'A',name:'Isolated fixture'});return res;};
  return {root,source,input,bytes,request,clip,snapshot,libraryPath,budgetPath,setHook:fn=>resolveHook=fn,setCut:fn=>cutHook=fn,reads:()=>reads};
}

test('实际服务导入保留完整旧记录、审批不继承、同证据重试字节不变，原run和预算不动',async t=>{
  const f=await fixture(t),before=await f.snapshot(),budget=await fs.readFile(f.budgetPath);
  const denied=await f.request('POST','/analyze','B');assert.equal(denied.status,404);assert.equal(f.reads(),0);
  const first=await f.request('POST','/analyze');assert.equal(first.status,200,JSON.stringify(first));
  const after=await f.snapshot(),s=after.sources[0];
  assert.equal(s.analysisStatus,'ready');assert.equal(s.analysisProvider,'feishu_minutes_srt');
  assert.equal(s.speechSegments[0].startSeconds,10.4);assert.equal(s.speechSegments[0].endSeconds,16.033333);assert.equal(s.speechSegments[0].requiresReview,true);
  const saved=JSON.parse(await fs.readFile(path.join(f.root,'asr-history',s.previousAsrAnalysisFile),'utf8'));
  assert.deepEqual(saved.previousSource,before.sources[0]);assert.deepEqual(after.autoJobs,before.autoJobs);assert.deepEqual(after.renders,before.renders);assert.deepEqual(after.clips,before.clips);assert.deepEqual(await fs.readFile(f.budgetPath),budget);
  const firstBytes=await fs.readFile(f.libraryPath);
  const retry=await f.request('POST','/analyze');assert.equal(retry.status,200);assert.deepEqual(await fs.readFile(f.libraryPath),firstBytes);assert.equal((await f.snapshot()).sources[0].analysisStatus,'ready');assert.equal((await fs.readdir(path.join(f.root,'asr-history'))).length,1);
});

test('实际服务源文件或SRT变化拒绝，旧审批记录和文件保持原样',async t=>{
  const f=await fixture(t),before=await fs.readFile(f.libraryPath);
  f.input.srtBytes=Buffer.from('changed SRT');const badSrt=await f.request('POST','/analyze');assert.equal(badSrt.status,400);assert.match(badSrt.body.message,/srt_sha_mismatch/);assert.deepEqual(await fs.readFile(f.libraryPath),before);
  f.input.source.srtSha256=hash(f.input.srtBytes);await fs.writeFile(path.join(f.root,'sources',f.source.storedName),'changed source');
  const badSource=await f.request('POST','/analyze');assert.equal(badSource.status,400);assert.match(badSource.body.message,/source_sha_mismatch/);assert.deepEqual(await fs.readFile(f.libraryPath),before);
});

test('实际服务并发人工修订后ASR提交CAS拒绝，不覆盖同事较新记录',async t=>{
  const f=await fixture(t);let release,entered;const inResolver=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  f.setHook(async()=>{entered();await gate;return f.input;});
  const pending=f.request('POST','/analyze');await inResolver;
  const patched=await f.request('PATCH','/segments','A',{segments:[{id:'original-segment',label:'同事刚修正的原记录',startSeconds:1,endSeconds:5,role:'solution'}]});
  assert.equal(patched.status,200,JSON.stringify(patched));const changed=await f.snapshot();release();
  const result=await pending;assert.equal(result.status,400);assert.match(result.body.message,/源记录已变化/);assert.deepEqual((await f.snapshot()).sources,changed.sources);
});

test('实际服务切片保留原帧精度和SHA证据、仍待审批，跨品和源变化均拒绝',async t=>{
  const f=await fixture(t);assert.equal((await f.request('POST','/analyze')).status,200);
  const body={sourceId:f.source.id,startSeconds:10.4,endSeconds:16.033333,productCategory:f.source.productCategory,role:'solution'};
  let actualCut;f.setCut(async args=>{actualCut=args;await fs.writeFile(args.outputPath,'isolated cut');});
  const wrong=await f.clip({...body,productCategory:'黑晶面膜'});assert.equal(wrong.status,400);assert.match(wrong.body.message,/跨SKU/);assert.equal(actualCut,undefined);
  const result=await f.clip(body);assert.equal(result.status,201,JSON.stringify(result));
  const clip=(await f.snapshot()).clips[0];assert.equal(clip.endSeconds,16.033333);assert.equal(clip.durationSeconds,5.633333);assert.equal(clip.reviewStatus,'pending');assert.equal(clip.boundaryEvidence.sourceSha256,hash(f.bytes));assert.equal(actualCut.startSeconds,10.4);assert.ok(Math.abs(actualCut.durationSeconds-5.633333)<1e-9);
  await fs.writeFile(path.join(f.root,'sources',f.source.storedName),'changed original');
  const before=await fs.readFile(f.libraryPath),changed=await f.clip(body);assert.equal(changed.status,400);assert.match(changed.body.message,/原视频文件已变化/);assert.deepEqual(await fs.readFile(f.libraryPath),before);
});

test('实际裁切过程中源字节改变时不登记新片，原任务和审批仍保留',async t=>{
  const f=await fixture(t);assert.equal((await f.request('POST','/analyze')).status,200);const before=await fs.readFile(f.libraryPath);
  f.setCut(async args=>{await fs.writeFile(args.outputPath,'isolated cut');await fs.writeFile(args.inputPath,'concurrent file change');});
  const result=await f.clip({sourceId:f.source.id,startSeconds:10.4,endSeconds:16.033333,productCategory:f.source.productCategory,role:'solution'});assert.equal(result.status,400);assert.match(result.body.message,/裁切期间/);assert.deepEqual(await fs.readFile(f.libraryPath),before);assert.deepEqual(await fs.readdir(path.join(f.root,'clips')),[]);
});

function useGroupFixture(f){
 f.input.srtBytes=Buffer.from('1\n00:00:10,410 --> 00:00:11,010\n说话人 1: 原句的\n\n2\n00:00:11,210 --> 00:00:11,690\n说话人 1: 完整结尾。\n\n3\n00:00:13,000 --> 00:00:15,000\n说话人 1: 下一句。\n');
 f.input.source.srtSha256=hash(f.input.srtBytes);f.input.receipts.export.size_bytes=f.input.srtBytes.length;f.input.source.sentenceCueGroups=[[1,2]];
}
test('实际引擎由私有完整句组创建可审核切片，拒绝请求伪造句组，原run和预算不动',async t=>{
 const f=await fixture(t);useGroupFixture(f);const before=await f.snapshot(),budget=await fs.readFile(f.budgetPath);
 const imported=await f.request('POST','/analyze','A',{sentenceCueGroups:[[1,3]],approved:true});assert.equal(imported.status,200,JSON.stringify(imported));
 const s=(await f.snapshot()).sources[0];assert.equal(s.speechSegments.length,2);assert.deepEqual(s.speechSegments[0].boundaryEvidence.cueIds,[1,2]);assert.equal(s.speechSegments[0].requiresReview,true);
 const result=await f.clip({sourceId:f.source.id,startSeconds:10.4,endSeconds:11.7,productCategory:f.source.productCategory,role:'pain'});assert.equal(result.status,201,JSON.stringify(result));const saved=await f.snapshot();assert.equal(saved.clips[0].reviewStatus,'pending');assert.deepEqual(saved.clips[0].boundaryEvidence.cueIds,[1,2]);assert.deepEqual(saved.autoJobs,before.autoJobs);assert.deepEqual(await fs.readFile(f.budgetPath),budget);
});
test('同源同SRT更改句组或SKU时重分析且保留历史，不能错误幂等复用旧批准',async t=>{
 const f=await fixture(t);useGroupFixture(f);assert.equal((await f.request('POST','/analyze')).status,200);const grouped=(await f.snapshot()).sources[0];
 const stable=await fs.readFile(f.libraryPath);assert.equal((await f.request('POST','/analyze')).status,200);assert.deepEqual(await fs.readFile(f.libraryPath),stable);
 f.input.source.sentenceCueGroups=[];assert.equal((await f.request('POST','/analyze')).status,200);const ungrouped=(await f.snapshot()).sources[0];assert.equal(ungrouped.speechSegments.length,3);assert.notEqual(ungrouped.analysisAsrEvidence.cueGroupsSha256,grouped.analysisAsrEvidence.cueGroupsSha256);assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root,'asr-history',ungrouped.previousAsrAnalysisFile))).previousSource,grouped);
 f.input.source.skuVersion='second-isolated-sku';assert.equal((await f.request('POST','/analyze')).status,200);const changed=(await f.snapshot()).sources[0];assert.equal(changed.skuVersion,'second-isolated-sku');assert.ok(changed.speechSegments.every(s=>s.requiresReview));assert.notEqual(changed.speechSegments[0].id,ungrouped.speechSegments[0].id);
});
test('非法私有句组拒绝且原库/审批不变，未知SKU不会变成自动批准',async t=>{
 const f=await fixture(t);useGroupFixture(f);const before=await fs.readFile(f.libraryPath);f.input.source.sentenceCueGroups=[[1,3]];const bad=await f.request('POST','/analyze');assert.equal(bad.status,400);assert.match(bad.body.message,/not_contiguous/);assert.deepEqual(await fs.readFile(f.libraryPath),before);
 f.input.source.sentenceCueGroups=[[1,2]];f.input.source.skuVersion=null;assert.equal((await f.request('POST','/analyze')).status,200);const s=(await f.snapshot()).sources[0];assert.equal(s.skuVersion,null);assert.ok(s.speechSegments.every(s=>s.requiresReview));assert.equal((await f.snapshot()).clips.length,0);
 const guarded=await f.clip({sourceId:f.source.id,startSeconds:10.4,endSeconds:11.7,productCategory:f.source.productCategory,role:'pain'});assert.equal(guarded.status,400);assert.match(guarded.body.message,/SKU或来源证据尚未核实/);assert.equal((await f.snapshot()).clips.length,0);
});
