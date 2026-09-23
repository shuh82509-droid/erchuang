import test from 'node:test';
import assert from 'node:assert/strict';
import {hasPassedVisualReview, visualTimeline, needsVisualAttention} from '../render-worker/output-quality.mjs';
test('自动内容凭证必须与此文件匹配，人工通过不能冒充自动内容通过',()=>{
  const review={status:'passed',sha256:'file-hash',version:'wis-visual-qc-20260908-v3',confidence:.95,issues:[]};
  assert.equal(hasPassedVisualReview({visualReview:review},'file-hash'),true);
  for(const changed of [undefined,{...review,sha256:'old-file'},{...review,confidence:.8},{...review,issues:[{}]},{...review,status:'review_required'}])
    assert.equal(hasPassedVisualReview({status:'passed',visualReview:changed},'file-hash'),false);
});
test('抽帧时间线按实际切片累计，并只引用重叠语句',()=>{
  const clips=[{id:'a',sourceId:'s',role:'hook',startSeconds:2,endSeconds:7,durationSeconds:5},{id:'b',sourceId:'s',role:'cta',startSeconds:9,endSeconds:12,durationSeconds:3}];
  const sources=[{id:'s',speechSegments:[{startSeconds:0,endSeconds:2,text:'不得混入'},{startSeconds:2,endSeconds:7,text:'真实开场'},{startSeconds:9,endSeconds:12,text:'真实收尾'}]}];
  const result=visualTimeline(clips,sources);
  assert.deepEqual(result.map(x=>[x.start,x.duration,x.sourceText]),[[0,5,'真实开场'],[5,3,'真实收尾']]);
});
test('内容疑点和模型不确定均暂停批次，纯技术失败保留已有重剪路径',()=>{
  for(const reason of ['content_attention','uncertain','budget_exhausted','not_configured','not_enabled'])
    assert.equal(needsVisualAttention({automaticAssessment:{visualReview:{status:'review_required',reason}}}),true);
  assert.equal(needsVisualAttention({automaticAssessment:{visualReview:{status:'review_required',reason:'technical_prerequisite'}}}),false);
});
