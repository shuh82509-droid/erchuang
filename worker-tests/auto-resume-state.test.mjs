import test from 'node:test';
import assert from 'node:assert/strict';
import {
  automaticOutputStats, outputApprovalProvenance, reconcileOutputApproval,
  requiredSourceAssetsForReadiness,
} from '../render-worker/clip-remix-service.mjs';
import {chooseDurationBase} from '../render-worker/duration-plan.mjs';
import {collectSourceCandidates} from '../render-worker/source-selection.mjs';

const hash = 'a'.repeat(64);
const human = () => ({id: 'human', reviewStatus: 'approved', reviewMode: 'human',
  reviewNote: '已查看画面、声音并核对本次活动依据', reviewedAt: '2026-09-08T10:00:00Z',
  reviewedBy: {id: 'fixture-reviewer'}, fileVerifiedAt: '2026-09-08T10:00:00Z', contentSha256: hash,
  automaticAssessment: {status: 'review_required', autoApproved: false,
    visualReview: {status: 'review_required', reason: 'business_fact_attention'}}});

test('人工处理内容疑点后计入原批次合格数量，不重剪也不伪装自动审批', () => {
  const variant = human(), before = structuredClone(variant);
  reconcileOutputApproval(variant, '2026-09-09T00:00:00Z');
  assert.deepEqual(variant, before);
  const stats = automaticOutputStats([{variants: [variant]}]);
  assert.equal(stats.approvedCount, 1);
  assert.equal(stats.rejectedCount, 0);
  assert.equal(stats.humanApprovedCount, 1);
  assert.equal(stats.automaticApprovedCount, 0);
  assert.equal(variant.automaticAssessment.autoApproved, false);
});

test('升级时保留旧版本已审核状态、备注和时间，标记未知历史来源', () => {
  for (const reviewStatus of ['approved', 'changes_requested']) {
    const variant = {id: 'old', reviewStatus, reviewNote: '原审核意见',
      reviewedAt: '2026-09-07T10:00:00Z', contentSha256: hash,
      automaticAssessment: {status: 'passed', autoApproved: true, suggestions: []}};
    reconcileOutputApproval(variant, '2026-09-09T00:00:00Z');
    assert.equal(variant.reviewStatus, reviewStatus);
    assert.equal(variant.reviewNote, '原审核意见');
    assert.equal(variant.reviewedAt, '2026-09-07T10:00:00Z');
    assert.equal(variant.reviewMode, 'legacy');
    assert.equal(variant.automaticAssessment.autoApproved, false);
    const stats = automaticOutputStats([{variants: [variant]}]);
    assert.equal(stats.legacyApprovedCount, reviewStatus === 'approved' ? 1 : 0);
    assert.equal(stats.automaticApprovedCount, 0);
  }
});

test('自动数量只认可文件匹配的内容凭证，人工与历史状态不绕过平台隔离和技术失败', () => {
  const automatic = {id: 'auto', reviewStatus: 'approved', contentSha256: hash,
    automaticAssessment: {status: 'passed', visualReview: {status: 'passed',
      sha256: hash, version: 'wis-visual-qc-20260908-v3', confidence: .95, issues: []}}};
  assert.equal(outputApprovalProvenance(automatic), 'automatic');
  assert.equal(outputApprovalProvenance({...automatic, contentSha256: 'b'.repeat(64)}), null);
  for (const reviewMode of ['human', 'legacy']) {
    const variant = {...human(), reviewMode, platformReview: {status: 'needs_localization'}};
    reconcileOutputApproval(variant, '2026-09-09T00:00:00Z');
    assert.equal(variant.reviewStatus, 'changes_requested');
    assert.equal(outputApprovalProvenance(variant), null);
    assert.equal(outputApprovalProvenance({...human(), reviewMode,
      automaticAssessment: {status: 'failed'}}), null);
  }
});

test('必需完整片段过长时，保留的时长缺口触发有上限的真实补源请求', async () => {
  const slots = ['hook','pain','solution','proof','cta'].map(id =>
    ({id, clips: [{id: `${id}-old`, durationSeconds: 20}]}));
  const preferred = Object.fromEntries(slots.map(slot => [slot.id, slot.clips[0].id]));
  assert.equal(chooseDurationBase({slots, target: 45, openingSlotId: 'hook', preferred}), null);
  const readiness = {slots: slots.map(() => ({missingCandidateCount: 0})), durationShortfallSeconds: 0};
  assert.equal(requiredSourceAssetsForReadiness(readiness, 3), 0);
  const count = requiredSourceAssetsForReadiness(readiness, 3, true);
  assert.equal(count, 3);
  assert.equal(requiredSourceAssetsForReadiness(readiness, 1, true), 1);
  const requests = [];
  const result = await collectSourceCandidates({selectors: [{category: '黑晶面膜'}],
    limit: count, eligible: asset => asset.id > 100,
    listAssets: async request => {requests.push(request); return {
      items: [101,102,103,104].map(id => ({id})), total: 4, pageSize: 100};}});
  assert.equal(requests.length, 1);
  assert.deepEqual(result.items.map(asset => asset.id), [101,102,103]);
});
