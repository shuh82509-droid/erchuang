import test from 'node:test';import assert from 'node:assert/strict';
import {verifyManualApprovalFile} from '../render-worker/manual-output-integrity.mjs';
const sha='a'.repeat(64),good={filePath:'isolated-test',inspectMedia:async()=>({hasAudio:true,duration:30,width:1080,height:1920}),hashFile:async()=>sha};
test('历史成片重新人工审核时登记真实文件摘要，不补造旧审核凭证',async()=>{
 assert.equal(await verifyManualApprovalFile(good),sha);
 assert.equal(await verifyManualApprovalFile({...good,expectedSha256:sha}),sha);
 await assert.rejects(verifyManualApprovalFile({...good,expectedSha256:'b'.repeat(64)}),/原记录不一致/);
});
test('文件丢失、音轨缺失、时长异常或无法得到摘要时不允许人工通过',async()=>{
 await assert.rejects(verifyManualApprovalFile({...good,inspectMedia:async()=>{throw Error('file missing')}}));
 for(const value of [{hasAudio:false,duration:30,width:1080,height:1920},{hasAudio:true,duration:NaN,width:1080,height:1920}])
  await assert.rejects(verifyManualApprovalFile({...good,inspectMedia:async()=>value}));
 await assert.rejects(verifyManualApprovalFile({...good,hashFile:async()=>''}));
});
