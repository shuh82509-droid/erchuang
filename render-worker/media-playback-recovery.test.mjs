import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createPlaybackRecovery} from './media-playback-recovery.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const fixture=async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'wis-playback-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const data=Buffer.from('original-media'),asset={id:12,objectKey:'original.mp4',size:data.length,category:'水润',downloadUrl:'https://example.invalid/video'};
  const state={downloads:0,renders:0};
  const source={id:'source',materialCenterAssetId:12,materialCenterObjectKey:asset.objectKey,size:data.length,visibility:'team',productCategory:'水润',contentSha256:sha(data)};
  const clip={id:'clip',sourceId:source.id,startSeconds:2,endSeconds:8,visibility:'team'};
  const variant={id:'1',contentSha256:sha(data),materialCenterReturn:{status:'completed',assetId:12,idempotencyKey:'return-key'}};
  const materialCenter={configured:true,getAsset:async()=>asset,getReturn:async()=>({assetId:12,assetAvailable:true}),downloadAsset:async(a,file)=>{state.downloads++;await fs.writeFile(file,data);}};
  const options={directory,materialCenter,maxFileBytes:10000,minimumFreeBytes:0,hashFile:async file=>sha(await fs.readFile(file)),inspectMedia:async file=>({duration:(await fs.readFile(file)).equals(data)?20:6}),runProcess:async(_,args)=>{state.renders++;await fs.writeFile(args.at(-1),'derived');},ffmpegPath:'ffmpeg'};
  return {directory,source,clip,variant,asset,state,options,recovery:createPlaybackRecovery(options)};
};
test('concurrent clip playback shares one reconstruction and verifies cached result',async t=>{
  const f=await fixture(t),args={clip:f.clip,source:f.source,identity:{id:'owner'}};
  const before=JSON.stringify(args);
  const [a,b]=await Promise.all([f.recovery.clip(args),f.recovery.clip(args)]);
  assert.equal(a.path,b.path);assert.equal(a.kind,'reconstructed-clip-preview');
  assert.equal(f.state.downloads,1);assert.equal(f.state.renders,1);
  await f.recovery.clip(args);assert.equal(f.state.downloads,1);assert.equal(JSON.stringify(args),before);
  const receipt=JSON.parse(await fs.readFile(a.path.replace('.mp4','.json')));
  assert.equal(receipt.originalClipRestored,false);assert.equal(receipt.startSeconds,2);
  await fs.writeFile(a.path,'corrupted');await assert.rejects(f.recovery.clip(args),/缓存校验失败/);
});

test('render recovery uses the original boundaries and production profile, with separate preview cache',async t=>{
  const f=await fixture(t),args={clip:f.clip,source:f.source,identity:{id:'owner'}};
  const before=JSON.stringify(args),cuts=[];
  const preview=await f.recovery.clip(args);
  const renderConfig={width:1080,height:1920,fps:30};
  const recovery=createPlaybackRecovery({...f.options,renderConfig,
    inspectMedia:async file=>({...await f.options.inspectMedia(file),width:1080,height:1920,frameRate:30,hasAudio:true}),
    makeSegment:async input=>{cuts.push(input);await fs.writeFile(input.outputPath,'normalized');}});
  const [a,b]=await Promise.all([recovery.clip({...args,purpose:'render'}),recovery.clip({...args,purpose:'render'})]);
  assert.equal(a.path,b.path);assert.notEqual(a.path,preview.path);
  assert.equal(a.kind,'reconstructed-render-input');assert.equal(cuts.length,1);assert.equal(f.state.downloads,1);
  assert.equal(cuts[0].startSeconds,2);assert.equal(cuts[0].durationSeconds,6);
  assert.deepEqual(cuts[0].config,renderConfig);assert.equal(cuts[0].fadeInSeconds,0);
  assert.equal(JSON.stringify(args),before);
  const receipt=JSON.parse(await fs.readFile(a.path.replace('.mp4','.json')));
  assert.equal(receipt.originalClipRestored,false);assert.deepEqual(receipt.renderConfig,renderConfig);
  f.source.visibility='private';f.source.createdById='other';
  await assert.rejects(recovery.clip({...args,purpose:'render'}),/无权访问/);
});

test('render recovery rejects an incompatible file instead of feeding it to concat',async t=>{
  const f=await fixture(t),args={clip:f.clip,source:f.source,identity:{id:'owner'},purpose:'render'};
  const recovery=createPlaybackRecovery({...f.options,renderConfig:{width:1080,height:1920,fps:30},
    makeSegment:async input=>fs.writeFile(input.outputPath,'wrong resolution')});
  await assert.rejects(recovery.clip(args),/画幅、帧率或音轨/);
  const receipts=await Promise.all((await fs.readdir(f.directory)).filter(n=>n.endsWith('.json')).map(async n=>JSON.parse(await fs.readFile(path.join(f.directory,n)))));
  assert.equal(receipts.some(r=>r.kind==='reconstructed-render-input'),false);
});
test('storage reserve blocks new recovery while already verified previews remain readable',async t=>{
  const f=await fixture(t),args={clip:f.clip,source:f.source,identity:{id:'owner'}};
  const original=await f.recovery.clip(args);
  const constrained=createPlaybackRecovery({...f.options,minimumFreeBytes:Number.MAX_SAFE_INTEGER});
  assert.equal((await constrained.clip(args)).path,original.path);
  await assert.rejects(constrained.clip({...args,clip:{...f.clip,id:'new-cut'}}),/空间不足/);
  assert.equal(f.state.downloads,1);assert.equal(f.state.renders,1);
});
test('different cuts share the verified source across calls and service restart',async t=>{
  const f=await fixture(t),args={clip:f.clip,source:f.source,identity:{id:'owner'}};
  const [a,b]=await Promise.all([f.recovery.clip(args),f.recovery.clip({...args,clip:{...f.clip,id:'second',startSeconds:8,endSeconds:14}})]);
  assert.notEqual(a.path,b.path);assert.equal(f.state.downloads,1);assert.equal(f.state.renders,2);
  const restarted=createPlaybackRecovery(f.options);
  await restarted.clip({...args,clip:{...f.clip,id:'third',startSeconds:10,endSeconds:16}});
  assert.equal(f.state.downloads,1);assert.equal(f.state.renders,3);
});
test('verified local original restores preview and render without querying the cloud',async t=>{
  const f=await fixture(t),sourcesDir=path.join(f.directory,'sources');
  await fs.mkdir(sourcesDir);
  await fs.writeFile(path.join(sourcesDir,'original.mp4'),'original-media');
  const source={...f.source,storedName:'original.mp4',durationSeconds:20};
  const args={clip:f.clip,source,identity:{id:'owner'}};
  const renderConfig={width:1080,height:1920,fps:30};
  const recovery=createPlaybackRecovery({...f.options,sourcesDir,materialCenter:{configured:false,
    getAsset:async()=>assert.fail('local recovery must not query cloud'),
    downloadAsset:async()=>assert.fail('local recovery must not download cloud media')},
    renderConfig,inspectMedia:async file=>({...await f.options.inspectMedia(file),width:1080,height:1920,frameRate:30,hasAudio:true}),
    makeSegment:async input=>fs.writeFile(input.outputPath,'normalized')});
  const preview=await recovery.clip(args);
  const render=await recovery.clip({...args,purpose:'render'});
  assert.equal(preview.kind,'reconstructed-clip-preview');
  assert.equal(render.kind,'reconstructed-render-input');
  assert.equal(f.state.downloads,0);
  for(const result of [preview,render]){
    const receipt=JSON.parse(await fs.readFile(result.path.replace('.mp4','.json')));
    assert.equal(receipt.sourceBasis,'verified-local-original');
    assert.equal(receipt.assetId,null);
    assert.equal(receipt.originalSha256,source.contentSha256);
  }
});
test('missing local original falls back to the exact cloud object; invalid local bytes do not',async t=>{
  const f=await fixture(t),sourcesDir=path.join(f.directory,'sources');
  await fs.mkdir(sourcesDir);
  const args={clip:f.clip,source:{...f.source,storedName:'missing.mp4',durationSeconds:20},identity:{id:'owner'}};
  const recovery=createPlaybackRecovery({...f.options,sourcesDir});
  const cloud=await recovery.clip(args);
  const receipt=JSON.parse(await fs.readFile(cloud.path.replace('.mp4','.json')));
  assert.equal(receipt.sourceBasis,'verified-cloud-original');
  assert.equal(f.state.downloads,1);
  await fs.writeFile(path.join(sourcesDir,'changed.mp4'),'changed-media!');
  await assert.rejects(recovery.clip({...args,source:{...args.source,storedName:'changed.mp4'},clip:{...f.clip,id:'changed'}}),/哈希与来源记录不一致/);
  assert.equal(f.state.downloads,1);
});
test('corrupted cached source blocks a new cut without redownload or overwrite',async t=>{
  const f=await fixture(t),args={clip:f.clip,source:f.source,identity:{id:'owner'}};
  await f.recovery.clip(args);
  for(const name of await fs.readdir(f.directory)){
    if(!name.endsWith('.json'))continue;
    const receipt=JSON.parse(await fs.readFile(path.join(f.directory,name)));
    if(receipt.kind==='verified-source-original')await fs.writeFile(path.join(f.directory,name.replace('.json','.mp4')),'corruption');
  }
  await assert.rejects(f.recovery.clip({...args,clip:{...f.clip,id:'second'}}),/缓存校验失败/);
  assert.equal(f.state.downloads,1);assert.equal(f.state.renders,1);
});
test('privacy and changed original block even a previously cached preview',async t=>{
  const f=await fixture(t),args={clip:f.clip,source:f.source,identity:{id:'owner'}};
  await f.recovery.clip(args);
  f.source.visibility='private';f.source.createdById='someone-else';
  await assert.rejects(f.recovery.clip(args),/无权访问/);
  f.source.visibility='team';f.asset.objectKey='different-object';
  await assert.rejects(f.recovery.clip(args),/版本发生变化/);
  assert.equal(f.state.downloads,1);
});
test('invalid cuts and original hash mismatch cannot produce a preview',async t=>{
  const f=await fixture(t),args={clip:f.clip,source:f.source,identity:{id:'owner'}};
  f.clip.startSeconds=-1;await assert.rejects(f.recovery.clip(args),/切点/);
  f.clip.startSeconds=2;f.source.contentSha256='a'.repeat(64);
  await assert.rejects(f.recovery.clip(args),/原视频校验失败/);assert.equal(f.state.renders,0);
  assert.equal((await fs.readdir(f.directory)).length,0);
});
test('returned output must match original sha and current return identity',async t=>{
  const f=await fixture(t),args={render:{id:'render'},variant:f.variant};
  const output=await f.recovery.output(args);assert.equal(output.kind,'verified-returned-output');
  assert.equal(await f.options.hashFile(output.path),f.variant.contentSha256);
  f.options.materialCenter.getReturn=async()=>({assetId:13,assetAvailable:true});
  await assert.rejects(f.recovery.output(args),/回传记录/);
});
test('returned output changed bytes are never published or silently re-rendered',async t=>{
  const f=await fixture(t);f.variant.contentSha256='a'.repeat(64);
  await assert.rejects(f.recovery.output({render:{id:'render'},variant:f.variant}),/哈希不同/);
  assert.equal(f.state.renders,0);assert.equal((await fs.readdir(f.directory)).length,0);
});
test('uncertain output without completed return is explicit missing, not substituted',async t=>{
  const f=await fixture(t);f.variant.materialCenterReturn.status='pending';
  await assert.rejects(f.recovery.output({render:{id:'render'},variant:f.variant}),/缺失/);
  assert.equal(f.state.downloads,0);
});
test('renumbered source requires exact object and size; same name never suffices',async t=>{
  const f=await fixture(t);f.source.originalName='original.mp4';
  f.options.materialCenter.getAsset=async id=>{if(id===12)throw Object.assign(new Error('missing'),{statusCode:404});return {...f.asset,id:19};};
  f.options.materialCenter.listAssets=async()=>({total:1,items:[{...f.asset,id:19}]});
  const args={clip:f.clip,source:f.source,identity:{id:'owner'}};
  const r=await f.recovery.clip(args);assert.equal(r.kind,'reconstructed-clip-preview');assert.equal(f.source.materialCenterAssetId,12);
  f.options.materialCenter.listAssets=async()=>({total:1,items:[{...f.asset,id:19,objectKey:'same-name-different-object'}]});
  await assert.rejects(f.recovery.clip(args),/唯一且一致/);
});
