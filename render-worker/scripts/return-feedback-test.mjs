import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { refreshReturnFeedback, hasPlatformQuarantine, assertNoPlatformQuarantine } from '../return-feedback.mjs';

const code = ts.transpileModule(
  await readFile(
    new URL('../../shared/remix-feedback.ts', import.meta.url),
    'utf8',
  ),
  {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
const ui = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
);
const state = {
  status: 'success',
  advertiserId: 'a',
  planId: 'p',
  platformAssetId: 'v',
  idempotencyKey: 'k',
  taskId: 't',
  bindingVerifiedAt: '2026-09-05T00:00:00Z',
  updatedAt: '2026-09-05T00:00:00Z',
  metrics: { stat_cost: 10, pay_order_amount: 20 },
  metricsLinkStatus: 'verified',
  metricsDataStatus: 'fresh',
};

test('output requires verified plan binding, deduplicates receipts, and never converts unknowns to zero', () => {
  assert.equal(ui.outputWasPushed({ qianchuanDelivery: state }), true);
  assert.equal(
    ui.outputWasPushed({
      qianchuanDelivery: { ...state, bindingVerifiedAt: null },
    }),
    false,
  );
  assert.equal(
    ui.outputWasPushed({ qianchuanDelivery: { ...state, status: 'partial' } }),
    false,
  );
  const newer = {
    ...state,
    updatedAt: '2026-09-05T01:00:00Z',
    metrics: { stat_cost: 30 },
  };
  assert.deepEqual(
    ui.outputDeliveryStates({
      qianchuanDelivery: state,
      cloudDeliveryFeedback: { items: [newer] },
    }),
    [newer],
  );
  const refreshedMetrics = { ...state, metrics: { stat_cost: 40 } };
  assert.deepEqual(
    ui.outputDeliveryStates({
      qianchuanDelivery: newer,
      cloudDeliveryFeedback: {
        items: [refreshedMetrics],
        checkedAt: '2026-09-05T02:00:00Z',
      },
    }),
    [refreshedMetrics],
  );
  for (const raw of [undefined, null, '', ' ', true, [], {}, 'invalid', -1])
    assert.equal(
      ui.verifiedDeliveryMetric(
        { ...state, metrics: { stat_cost: raw } },
        'stat_cost',
      ),
      null,
    );
  assert.equal(
    ui.verifiedDeliveryMetric(
      { ...state, metrics: { stat_cost: 0 } },
      'stat_cost',
    ),
    0,
  );
  assert.equal(
    ui.verifiedDeliveryMetric(
      { ...state, metricsLinkStatus: 'pending' },
      'stat_cost',
    ),
    null,
  );
  assert.equal(
    ui.verifiedDeliveryMetric(
      { ...state, metricsDataStatus: 'error' },
      'stat_cost',
    ),
    null,
  );
  assert.equal(
    ui.verifiedDeliveryMetric(
      { ...state, metricsDataStatus: 'no_data', metrics: {} },
      'stat_cost',
    ),
    null,
  );
  assert.equal(ui.remixGenerationLabel(false), 'AI混剪');
  assert.equal(ui.remixGenerationLabel(true), '全自动混剪');
});

test('cloud feedback is owner-scoped, bounded, retained on error, and never enters automatic retry state', async () => {
  const variant = {
    id: 'v',
    materialCenterReturn: {
      status: 'completed',
      idempotencyKey: 'returned',
      assetId: 8,
    },
  };
  const library = {
    renders: [
      { id: 'r', createdById: 'owner', variants: [variant] },
      {
        id: 'private',
        createdById: 'owner',
        visibility: 'private',
        variants: [structuredClone(variant)],
      },
      { id: 'legacy-no-owner', variants: [structuredClone(variant)] },
    ],
  };
  const calls = [];
  let fail = false;
  const materialCenter = {
    configured: true,
    getReturnFeedback: async (input) => {
      calls.push(input);
      if (fail) throw new Error('offline');
      return {
        assetId: 8,
        assetAvailable: true,
        complete: true,
        items: [{ ...state, id: 'manual-cloud-task' }],
      };
    },
  };
  const context = {
    readLibrary: async () => library,
    updateLibrary: async (fn) => fn(library),
    materialCenter,
    now: 1000000,
  };
  await refreshReturnFeedback(context);
  assert.deepEqual(calls, [
    {
      idempotencyKey: 'returned',
      actorNumber: 'owner',
      renderId: 'r',
      variantId: 'v',
    },
  ]);
  assert.equal(
    variant.cloudDeliveryFeedback.items[0].taskId,
    'manual-cloud-task',
  );
  assert.equal(variant.qianchuanDelivery, undefined);
  assert.equal(variant.qianchuanDeliveries, undefined);
  await refreshReturnFeedback(context);
  assert.equal(calls.length, 1);
  fail = true;
  await refreshReturnFeedback({ ...context, now: 2000000 });
  assert.equal(variant.cloudDeliveryFeedback.items.length, 1);
  assert.equal(variant.cloudDeliveryFeedback.errorMessage, 'offline');
  materialCenter.getReturnFeedback = async () => ({ assetId: 99, items: [] });
  await refreshReturnFeedback({ ...context, now: 3000000 });
  assert.match(variant.cloudDeliveryFeedback.errorMessage, /关联不匹配/);
  assert.equal(variant.cloudDeliveryFeedback.items.length, 1);
});

test('native rejection quarantines only the output; unknown/network statuses do not poison source clips', async () => {
  for (const status of ['REJECT', 'IN_PROGRESS', 'UNKNOWN', 'PASS']) {
    const variant = { id: 'v', reviewStatus: 'approved', materialCenterReturn: { status: 'completed', assetId: 8, idempotencyKey: 'returned' } };
    const library = { renders: [{ id: 'r', createdById: 'owner', variants: [variant] }], clips: [{ id: 'c', reviewStatus: 'approved' }] };
    await refreshReturnFeedback({ readLibrary: async () => library, updateLibrary: async fn => fn(library),
      materialCenter: { configured: true, getReturnFeedback: async () => ({ assetId: 8, items: [{ ...state, platformAudit: { status, video_id: 'v', source: 'qianchuan/uni_promotion/ad/material/get', reasons: [] } }] }) } });
    assert.equal(variant.reviewStatus, status === 'REJECT' ? 'changes_requested' : 'approved');
    assert.equal(library.clips[0].reviewStatus, 'approved');
    assert.equal(variant.qianchuanDelivery, undefined);
    assert.equal(hasPlatformQuarantine(variant), status === 'REJECT');
    if (status === 'REJECT') {
      // A stale/manual approval cannot override a persistent platform quarantine.
      variant.reviewStatus = 'approved';
      assert.throws(() => assertNoPlatformQuarantine(variant), error => error.statusCode === 409);
    } else assert.doesNotThrow(() => assertNoPlatformQuarantine(variant));
  }
});
