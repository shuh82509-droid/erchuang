import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {verifyAsrBundle,alignAsrCuesToFrames,hasTrustedAsrFrameBoundary} from '../render-worker/asr-frame-boundary.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
function fixture(){
 const sourceBytes=Buffer.from('explicit isolated original source'),srtBytes=Buffer.from('1\n00:00:10,410 --> 00:00:11,010\n说话人 1: 这是一整句的\n\n2\n00:00:11,210 --> 00:00:11,690\n说话人 1: 结尾。\n\n3\n00:00:13,000 --> 00:00:15,000\n说话人 1: 下一句。\n');
 const source={id:'source',sha256:hash(sourceBytes),srtSha256:hash(srtBytes),productCategory:'water',skuVersion:'isolated-known-sku',durationSeconds:30,minuteToken:'fixture-minute',sentenceCueGroups:[[1,2]]};
 return {source,sourceBytes,srtBytes,frameMap:{sourceSha256:source.sha256,starts:Array.from({length:900},(_,i)=>Number((i/30).toFixed(6))),end:30},receipts:{drive:{ok:true,identity:'user',data:{size:sourceBytes.length,file_token:'fixture-file',version:'1'}},minute:{ok:true,identity:'user',data:{minute_token:source.minuteToken}},detail:{ok:true,identity:'user',data:{minutes:[{minute_token:source.minuteToken}]}},export:{size_bytes:srtBytes.length}}};
}
test('原连续短续句合成完整组，原文/停顿/时间/帧号可追溯，无子句重复或批准继承',()=>{
 const f=fixture(),b=verifyAsrBundle(f),r=alignAsrCuesToFrames(b);assert.equal(r.length,2);const g=r[0];
 assert.deepEqual(g.boundaryEvidence.cueIds,[1,2]);assert.equal(g.label,'这是一整句的 结尾。');assert.equal(g.startSeconds,10.4);assert.equal(g.endSeconds,11.7);assert.equal(g.rawEndSeconds,11.69);assert.equal(g.requiresReview,true);assert.equal(g.nativeFrameAligned,true);assert.equal(g.boundaryType,'asr_sentence_group');
 assert.deepEqual(g.boundaryEvidence.sourceCues,b.cues.slice(0,2));assert.equal(g.boundaryEvidence.sourceCuesSha256,hash(JSON.stringify(b.cues.slice(0,2))));assert.equal(r[1].index,3);
 assert.equal(hasTrustedAsrFrameBoundary(g,{...f.source,contentSha256:f.source.sha256}),true);
});
test('没有显式私有句组配置时保持逐cue行为，不能自动猜断句',()=>{const f=fixture();delete f.source.sentenceCueGroups;const r=alignAsrCuesToFrames(verifyAsrBundle(f));assert.equal(r.length,3);assert.equal(r[0].nativeFrameAligned,false);assert.equal(r[1].nativeFrameAligned,false);assert.equal(r[2].boundaryType,'asr_sentence');});
for(const [name,groups] of [['skip',[[1,3]]],['reverse',[[2,1]]],['duplicate',[[1,2],[1,2]]],['overlap',[[1,2],[2,3]]],['single',[[1]]],['missing',[[3,4]]],['object',[{cueIds:[1,2]}]],['string',[['1','2']]],['null',null]])test('拒绝非法私有句组 '+name,()=>{const f=fixture();f.source.sentenceCueGroups=groups;assert.throws(()=>verifyAsrBundle(f));});
test('不合并跨长空档、超过20秒或原SRT重叠句',()=>{
 for(const [replacement,message]of [['00:00:11,210 --> 00:00:11,690','gap'],['00:00:11,210 --> 00:00:11,690','long']]){
  const f=fixture();f.srtBytes=Buffer.from(f.srtBytes.toString().replace(replacement,message==='gap'?'00:00:12,600 --> 00:00:12,990':'00:00:11,210 --> 00:00:29,000').replace('00:00:13,000 --> 00:00:15,000',message==='long'?'00:00:29,100 --> 00:00:29,900':'00:00:13,000 --> 00:00:15,000'));if(message==='long')f.srtBytes=Buffer.from(f.srtBytes.toString().replace('00:00:10,410','00:00:01,410'));f.source.srtSha256=hash(f.srtBytes);f.receipts.export.size_bytes=f.srtBytes.length;assert.throws(()=>verifyAsrBundle(f),message==='gap'?/gap_too_long/:/too_long/);
 }
});
test('句组不能继承其他source、文件、SKU；缺SKU继续待核验',()=>{const f=fixture(),g=alignAsrCuesToFrames(verifyAsrBundle(f))[0],source={...f.source,contentSha256:f.source.sha256};for(const diff of [{id:'other'},{contentSha256:hash('changed')},{productCategory:'black'},{skuVersion:'other'},{skuVersion:null}])assert.equal(hasTrustedAsrFrameBoundary(g,{...source,...diff}),false);});
test('改变组内原话、cue顺序、间隔、边界和伪装单句均失去信任',()=>{const f=fixture(),g=alignAsrCuesToFrames(verifyAsrBundle(f))[0],s={...f.source,contentSha256:f.source.sha256};for(const change of [x=>x.boundaryEvidence.cueIds.reverse(),x=>x.boundaryEvidence.sourceCues[1].text='改写',x=>x.rawEndSeconds=12,x=>x.boundaryType='asr_sentence',x=>{x.boundaryEvidence.sourceCues[1].start=13;x.boundaryEvidence.sourceCuesSha256=hash(JSON.stringify(x.boundaryEvidence.sourceCues));}]){const changed=structuredClone(g);change(changed);assert.equal(hasTrustedAsrFrameBoundary(changed,s),false);}});
test('绑定SKU和句组计划都进入独立身份摘要，原SRT/源字节不变',()=>{const f=fixture(),a=verifyAsrBundle(f);f.source.sentenceCueGroups=[];const b=verifyAsrBundle(f);assert.notEqual(a.cueGroupsSha256,b.cueGroupsSha256);assert.equal(a.srtSha256,b.srtSha256);assert.equal(a.source.sha256,b.source.sha256);});
