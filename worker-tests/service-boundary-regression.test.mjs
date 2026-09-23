import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createHash,randomUUID} from 'node:crypto';
import {ASR_FRAME_RULE,hasTrustedAsrFrameBoundary,preciseBoundarySeconds,verifyAsrBundle,alignAsrCuesToFrames} from '../render-worker/asr-frame-boundary.mjs';
const service=readFileSync(new URL('../render-worker/clip-remix-service.mjs',import.meta.url),'utf8');
const hash=x=>createHash('sha256').update(x).digest('hex');
function setup(){
 const bytes=Buffer.from('source'),srt=Buffer.from('1\n00:00:10,410 --> 00:00:16,013\n说话人 1: 已核对的测试句。\n');
 const source={id:'s',sha256:hash(bytes),productCategory:'water',skuVersion:'sku-test',srtSha256:hash(srt),minuteToken:'minute',durationSeconds:20};
 const receipts={drive:{ok:true,identity:'user',data:{size:bytes.length,file_token:'file',version:'1'}},minute:{ok:true,identity:'user',data:{minute_token:'minute'}},detail:{ok:true,identity:'user',data:{minutes:[{minute_token:'minute'}]}},export:{size_bytes:srt.length}};
 const candidates=alignAsrCuesToFrames(verifyAsrBundle({source,sourceBytes:bytes,srtBytes:srt,receipts,frameMap:{sourceSha256:source.sha256,starts:Array.from({length:600},(_,i)=>Number((i/30).toFixed(6))),end:20}}));
 const ctx=vm.createContext({ASR_FRAME_RULE,hasTrustedAsrFrameBoundary,preciseBoundarySeconds,randomUUID,number:x=>Number(Number(x).toFixed(2)),safeTranscript:x=>x,safeLabel:x=>x,nowIso:()=>new Date(0).toISOString(),suggestedRoleForSegment:()=>({role:'solution',evidence:'isolated test only'})});
 const materialize=vm.runInContext(service.slice(service.indexOf('  const materializeSpeechSegments ='),service.indexOf('  const preserveManualSegments ='))+'\nmaterializeSpeechSegments;',ctx);
 const calibrate=vm.runInContext(service.slice(service.indexOf('  const calibrateSourceSegments ='),service.indexOf('  const buildAutoReadiness ='))+'\ncalibrateSourceSegments;',ctx);
 return {source:{...source,contentSha256:source.sha256},candidates,materialize,calibrate};
}
test('真实service materialize和calibrate保留非整秒帧精度与来源证据',()=>{
 const {source,candidates,materialize,calibrate}=setup(),segments=materialize('s',candidates),output=calibrate({...source,speechSegments:segments});
 assert.equal(output[0].startSeconds,10.4);assert.equal(output[0].endSeconds,16.033333);
 assert.equal(output[0].boundaryEvidence.srtSha256,candidates[0].boundaryEvidence.srtSha256);
 assert.equal(output[0].automaticCalibration.status,'review_required');
 segments[0].requiresReview=false;const reviewed=calibrate({...source,speechSegments:segments});
 assert.equal(reviewed[0].automaticCalibration.status,'calibrated');assert.equal(reviewed[0].durationSeconds,5.633333);
});
test('只改来源/SKU/片段边界不能继承已核对候选，整秒flag也不绕过',()=>{
 const {source,candidates,materialize,calibrate}=setup(),segments=materialize('s',candidates);segments[0].requiresReview=false;segments[0].integerSecondAligned=true;
 for(const changed of [{skuVersion:'other'},{contentSha256:hash('changed')},{id:'other'}])assert.equal(calibrate({...source,...changed,speechSegments:segments})[0].automaticCalibration.status,'review_required');
 segments[0].startSeconds=10;segments[0].endSeconds=16;assert.equal(calibrate({...source,speechSegments:segments})[0].automaticCalibration.status,'review_required');
});
test('原有已复核整秒路径保持兼容，OCR待复核不能升级为通过',()=>{
 const {source,calibrate}=setup(),segment={id:'legacy',label:'原整秒',startSeconds:1,endSeconds:5,requiresReview:false,integerSecondAligned:true};
 assert.equal(calibrate({...source,speechSegments:[segment]})[0].automaticCalibration.status,'calibrated');
 assert.equal(calibrate({...source,speechSegments:[{...segment,requiresReview:true}]})[0].automaticCalibration.status,'review_required');
});
