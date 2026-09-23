import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createClipRemixService } from '../clip-remix-service.mjs';

// Synthetic records only. Never connects to production or starts background work.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wis-library-perf-'));
const categories = ['黑晶面膜', '肌活蛋白喷雾', 'WIS隐形水润面膜', '黄金面膜', '颈膜', '晶润紧致眼膜', '深海次抛', '燕窝面膜', '美白针'];
const createdAt = '2026-09-07T00:00:00.000Z';
const library = {
  version: 7,
  sources: Array.from({ length: 2500 }, (_, i) => ({
    id: `source-${i}`, originalName: `fixture-${i}.mp4`, size: 1000000,
    durationSeconds: 120, hasAudio: true, uploadedAt: createdAt,
    visibility: i % 5 === 0 ? 'private' : 'team', createdById: i % 2 ? 'A' : 'B',
    productCategory: categories[i % 9], tags: ['测试'], analysisStatus: 'completed',
    speechSegments: Array.from({ length: 20 }, (_, j) => ({
      id: `segment-${i}-${j}`, startSeconds: j * 5, endSeconds: (j + 1) * 5,
      durationSeconds: 5, text: '隔离测试的完整识别文案和画面描述。'.repeat(10),
      sceneDescription: '这是隔离候选数据，不是真实业务素材。'.repeat(10),
    })),
  })),
  clips: Array.from({ length: 4500 }, (_, i) => ({
    id: `clip-${i}`, sourceId: `source-${i % 2500}`, name: `fixture clip ${i}`,
    role: ['hook', 'pain', 'solution', 'proof', 'action'][i % 5],
    tags: ['测试'], startSeconds: 0, endSeconds: 12, durationSeconds: 12,
    productCategory: categories[i % 9], createdByIds: [i % 2 ? 'A' : 'B'],
    reviewStatus: 'approved', reviewNote: '', createdAt, reviewedAt: createdAt,
    automaticAssessment: { status: 'passed', score: 96, reasons: ['完整切点'], checks: [] },
  })),
  renders: [], autoJobs: [], folders: [], frameworks: [],
};
if (process.argv.includes('--with-jobs')) library.autoJobs = Array.from({ length: 21 }, (_, i) => ({
  id: `job-${i}`, name: `隔离计划 ${i}`, createdById: 'A', createdByName: 'A',
  frameworkId: 'hook-pain-solution-proof-cta', productCategory: categories[i % 9],
  status: 'active', dailyTarget: 50, scheduleEnabled: false, scheduleTime: '09:00',
  targetDurationSeconds: 90, createdAt, updatedAt: createdAt,
  runs: Array.from({ length: 7 }, (_, j) => ({
    id: `run-${i}-${j}`, dateKey: '2026-09-07', status: j ? 'completed' : 'preparing',
    targetCount: 50, generatedCount: 0, renderIds: [], startedAt: createdAt,
    stageReports: [],
  })),
}));
await fs.mkdir(path.join(root, 'clip-remix'));
await fs.writeFile(path.join(root, 'clip-remix/library.json'), JSON.stringify(library));
const service = createClipRemixService({
  dataDir: root, nowIso: () => new Date().toISOString(),
  autoRemixAdminUsers: 'A',
  readJsonBody: async req => req.body,
  jsonResponse: (res, status, body) => { res.status = status; res.body = body; res.serialized = JSON.stringify(body); },
  materialCenter: { configured: false }, cutter: { configured: false },
});
const request = async (suffix, owner = 'A', headers = {}) => {
  const response = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, writeHead(status) { this.status = status; }, end() {} };
  const handled = await service.route({ method: 'GET', headers }, response,
    new URL(`http://localhost${suffix}`), { sub: owner, name: owner });
  return { ...response, handled };
};
try {
  const result = await request('/api/remix/library');
  assert.equal(result.status, 200);
  assert.equal(result.body.sources.length, 2250);
  assert.equal(result.body.clips.length, 4050);
  const paths = ['/api/remix/library', '/api/remix/library?view=compact', '/api/remix/library/progress', '/api/remix/library/records?kind=sources&page=1&pageSize=24'];
  const measurements = [];
  for (const endpoint of paths) {
    const first = await request(endpoint);
    if (!first.handled) continue;
    const durations = [];
    let bytes = 0;
    for (let iteration = 0; iteration < 30; iteration++) {
      const start = performance.now();
      const reply = await request(endpoint);
      assert.equal(reply.status, 200);
      bytes = Buffer.byteLength(reply.serialized);
      durations.push(performance.now() - start);
    }
    durations.sort((a, b) => a - b);
    measurements.push({ endpoint, bytes, medianMs: +durations[14].toFixed(2), p95Ms: +durations[28].toFixed(2) });
  }
  if (process.argv.includes('--assert-optimized')) {
    assert.equal(measurements.length, 4);
    assert.ok(measurements[1].bytes < measurements[0].bytes * 0.15, 'compact catalogue must remove heavy transcript details');
    assert.ok(measurements[2].bytes < 500000, 'progress must not carry the asset library or old run history');
    assert.ok(measurements[3].bytes < 60000, 'source cards must be bounded and exclude transcripts');
    const page = await request('/api/remix/library/records?kind=sources&page=1&pageSize=24');
    assert.equal(page.body.items.length, 24);
    assert.equal(page.body.total, 2250);
    assert.ok(page.body.items.every(item => item.speechSegments.length === 0));
    const denied = await request('/api/remix/library/records?kind=sources&ids=source-0');
    assert.equal(denied.body.items.length, 0);
    const allowed = await request('/api/remix/library/records?kind=sources&ids=source-0', 'B');
    assert.equal(allowed.body.items.length, 1);
    const detail = await request('/api/remix/library/sources/source-0', 'B');
    assert.equal(detail.body.source.speechSegments.length, 20);
    assert.equal((await request('/api/remix/library/sources/source-0', 'A')).status, 404);
    const compactA = await request('/api/remix/library?view=compact', 'A');
    const compactB = await request('/api/remix/library?view=compact', 'B');
    assert.notEqual(compactA.headers.ETag, compactB.headers.ETag, 'conditional reads must be identity scoped');
    const unchanged = await request('/api/remix/library?view=compact', 'A', { 'if-none-match': compactA.headers.ETag });
    assert.equal(unchanged.status, 304);
    const before = await request('/api/remix/library/progress', 'A');
    const mutation = {};
    await service.route({ method: 'PATCH', headers: {}, body: { name: '改名后的真实测试', tags: ['metadata-change'] } }, mutation,
      new URL('http://localhost/api/remix/sources/source-1/metadata'), { sub: 'A', name: 'A' });
    assert.equal(mutation.status, 200);
    const after = await request('/api/remix/library/progress', 'A', { 'if-none-match': before.headers.ETag });
    assert.equal(after.status, 200, 'a committed mutation invalidates old validators');
    assert.notEqual(after.body.catalogRevision, before.body.catalogRevision);
    const renamed = await request('/api/remix/library/records?kind=sources&q=' + encodeURIComponent('改名后的真实测试'));
    assert.equal(renamed.body.total, 1);
    assert.equal(renamed.body.items[0].id, 'source-1');
    const hugePage = await request('/api/remix/library/records?kind=clips&pageSize=999999');
    assert.equal(hugePage.body.items.length, 100);
    const filtered = await request('/api/remix/library/records?kind=clips&productCategory=' + encodeURIComponent('黑晶面膜'));
    assert.equal(filtered.body.total, 450);
    const clamped = await request('/api/remix/library/records?kind=sources&page=999999');
    assert.equal(clamped.body.page, 94);
    assert.equal(clamped.body.items.length, 18);
  }
  const coldReads = [];
  if (process.argv.includes('--assert-optimized')) {
    // Simulate actual committed changes between reads. Warm cache results alone
    // do not represent a busy supply line. Persistence is outside this timer.
    for (let i = 0; i < 10; i++) {
      const mutation = {};
      await service.route({ method: 'PATCH', headers: {}, body: { name: `忙时更新-${i}`, tags: [] } }, mutation,
        new URL('http://localhost/api/remix/sources/source-1/metadata'), { sub: 'A', name: 'A' });
      assert.equal(mutation.status, 200);
      const start = performance.now();
      assert.equal((await request('/api/remix/library/progress')).status, 200);
      coldReads.push(+(performance.now() - start).toFixed(2));
    }
  }
  console.log(JSON.stringify({ fixture: { sources: 2500, clips: 4500, categories: 9, targetClipsPerCategory: 500 }, measurements,
    progressAfterCommittedChangesMs: coldReads }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
