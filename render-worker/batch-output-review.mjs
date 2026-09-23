import {visualTimeline,hasPassedVisualReview} from './output-quality.mjs';

export function batchOutputInput({outputId,filePath,assessment,clips,sources,sourcePath}){
 const byId=new Map(sources.map(s=>[s.id,s]));
 const singleTimeline=visualTimeline(clips,sources),sourceFiles=[];
 const timeline=singleTimeline.map((item,i)=>{
  const clip=clips[i],source=byId.get(clip.sourceId);
  // Only an exact SKU binding already verified with this source's ASR receipt
  // can enter automatic pair review. A product title is not a SKU approval.
  const skuVersion=source?.skuVersion&&source.analysisAsrEvidence?.skuVersion===source.skuVersion&&source.analysisAsrEvidence?.sourceSha256===source.contentSha256?source.skuVersion:null;
  if(source&&!sourceFiles.some(s=>s.sourceId===source.id))sourceFiles.push({sourceId:source.id,sha256:source.contentSha256,skuVersion,product:source.productCategory,filePath:sourcePath(source)});
  const boundaryMatches=clip.boundaryEvidence?.skuVersion===skuVersion&&clip.boundaryEvidence?.sourceSha256===source?.contentSha256;
  return {...item,sourceId:clip.sourceId,sourceSha256:source?.contentSha256,skuVersion,sourceStartSeconds:clip.startSeconds,sourceEndSeconds:clip.endSeconds,clipApproved:clip.reviewStatus==='approved'&&boundaryMatches};
 });
 return {outputId,filePath,sha256:assessment.sha256,technicalPassed:assessment.assessment.checks.filter(c=>c.name!=='成片内容复核').every(c=>c.passed),timeline,singleTimeline,sourceFiles};
}

export function applyBatchOutputReview(variant,review){
 const previous=variant.automaticAssessment;
 const safeReview=review?.sha256===variant.contentSha256?review:{status:'review_required',reason:'batch_output_missing',summary:'该成片缺少完整绑定的独立复核回执。'};
 const checks=previous.checks.filter(c=>c.name!=='成片内容复核');
 checks.push({name:'成片内容复核',passed:hasPassedVisualReview({visualReview:safeReview},variant.contentSha256),detail:safeReview.summary});
 const status=!checks.slice(0,4).every(c=>c.passed)?'failed':checks.every(c=>c.passed)?'passed':'review_required';
 const failed=checks.filter(c=>!c.passed),passed=status==='passed';
 variant.automaticAssessment={...previous,status,mode:'rules_and_visual',visualReview:safeReview,checks,score:Math.round(checks.filter(c=>c.passed).length/checks.length*100),reasons:failed.map(c=>`${c.name}：${c.detail}`),suggestions:failed.map(c=>`修复“${c.name}”后重新审核。`),recommendation:passed?'approve':status==='failed'?'reject':'manual_review',autoApproved:passed,assessedAt:new Date().toISOString()};
 variant.reviewStatus=passed?'approved':'changes_requested';
 variant.reviewNote=passed?`自动成片审核通过（${variant.automaticAssessment.score}分）：技术检查与本片全部抽帧复核通过；保留同原批与 SKU 的独立回执。`:`自动成片待复核：${safeReview.summary}`;
 variant.reviewedAt=new Date().toISOString();
 return variant;
}

export function batchInputsStillApproved(inputs,library){
 const sources=new Map(library.sources.map(s=>[s.id,s])),clips=new Map(library.clips.map(c=>[c.id,c]));
 return inputs.every(input=>input.timeline.every(item=>{
  const source=sources.get(item.sourceId),clip=clips.get(item.clipId);
  return clip?.reviewStatus==='approved'&&clip.sourceId===item.sourceId&&clip.durationSeconds===item.duration&&clip.startSeconds===item.sourceStartSeconds&&clip.endSeconds===item.sourceEndSeconds&&clip.role===item.role&&clip.boundaryEvidence?.skuVersion===item.skuVersion&&clip.boundaryEvidence?.sourceSha256===item.sourceSha256&&source?.contentSha256===item.sourceSha256&&source?.skuVersion===item.skuVersion&&source?.productCategory===item.sourceCategory&&source?.analysisAsrEvidence?.skuVersion===item.skuVersion&&source?.analysisAsrEvidence?.sourceSha256===item.sourceSha256;
 }));
}
