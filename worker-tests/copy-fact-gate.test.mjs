import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFactIssues} from '../render-worker/copy-fact-gate.mjs';
const row=text=>({clipId:'real-position',start:12,sourceText:text});
test('真实黑晶样本中的功效和活动声明需要本次业务依据',()=>{
  const issues=copyFactIssues([row('十年皱纹一盒就行。'),row('这次品牌周年庆直降一折，赶紧抢！')]);
  assert.deepEqual(issues.map(x=>x.kind),['efficacy_basis_missing','offer_basis_missing']);
  assert.equal(issues[0].at,12);assert.equal(issues[0].clipId,'real-position');
});
test('正常护肤场景、产品展示和已知无口播片段不凭关键词误判',()=>{
  assert.deepEqual(copyFactIssues([row('工作压力大、经常熬夜，脸容易显得暗沉。'),row('打开包装，取出黑晶面膜。'),row('无口播')]),[]);
});
test('缺失口播和生成占位标签不能被当作已核对文字',()=>{
  for(const text of ['', '  ', '口播片段 2'])assert.equal(copyFactIssues([row(text)])[0].kind,'transcript_missing');
});
