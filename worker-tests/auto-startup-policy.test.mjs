import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createClipRemixService, isAutoJobDue, preserveAutoJobOnRestart,
  reconcileOutputApproval} from '../render-worker/clip-remix-service.mjs';

const now = '2026-09-08T13:00:00.000Z';
const past = '2026-09-08T12:00:00.000Z';
const future = '2026-09-08T15:00:00.000Z';
const job = (extra = {}) => ({id: 'fixture', status: 'active', nextRunAt: past,
  scheduleEnabled: true, autoApproveOutputs: false, runs: [], ...extra});

test('重启不把待人审变为可运行；用户明确恢复原批次后才可调度', () => {
  for (const status of ['awaiting_review', 'awaiting_clip_review']) {
    const value = job({runs: [{id: 'original-run', status}]});
    assert.equal(isAutoJobDue(value, Date.parse(now)), false);
    preserveAutoJobOnRestart(value, now);
    assert.equal(value.runs[0].status, status);
    assert.equal(value.scheduleEnabled, true);
    assert.equal(value.autoApproveOutputs, false);
    assert.equal(value.nextRunAt, null);
    value.runs[0].resumeRequestedAt = now;
    value.nextRunAt = now;
    preserveAutoJobOnRestart(value, now);
    assert.equal(isAutoJobDue(value, Date.parse(now)), true);
    assert.equal(value.runs[0].id, 'original-run');
  }
});

test('保持未来退避和关闭定时计划；真正执行中断的原批次仍可恢复', () => {
  for (const scheduleEnabled of [true, false]) {
    const retry = job({scheduleEnabled, nextRunAt: future, runs: [{id: 'same', status: 'awaiting_sources'}]});
    preserveAutoJobOnRestart(retry, now);
    assert.equal(retry.nextRunAt, future);
    assert.equal(isAutoJobDue(retry, Date.parse(now)), false);
    const dormant = job({scheduleEnabled, nextRunAt: null, runs: [{id: 'same', status: 'awaiting_sources'}]});
    preserveAutoJobOnRestart(dormant, now);
    assert.equal(dormant.nextRunAt, null);
    assert.equal(isAutoJobDue(dormant, Date.parse(now)), false);
  }
  const interrupted = job({scheduleEnabled: false, nextRunAt: null,
    runs: [{id: 'same', status: 'generating', renderIds: ['saved'], selectedSourceIds: ['source']}]});
  preserveAutoJobOnRestart(interrupted, now);
  assert.equal(interrupted.runs[0].status, 'queued');
  assert.equal(interrupted.runs[0].id, 'same');
  assert.deepEqual(interrupted.runs[0].renderIds, ['saved']);
  assert.equal(isAutoJobDue(interrupted, Date.parse(now)), true);
  assert.equal(interrupted.autoApproveOutputs, false);
  const enabled = job({autoApproveOutputs: true});
  preserveAutoJobOnRestart(enabled, now);
  assert.equal(isAutoJobDue(enabled, Date.parse(now)), true);
  assert.equal(enabled.autoApproveOutputs, true);
});

test('暂停与归档计划完全不被重启改写，关闭自动审批时保留待审', () => {
  for (const override of [{status: 'paused'}, {archivedAt: past}]) {
    const value = job({...override, runs: [{status: 'generating'}]}), original = structuredClone(value);
    preserveAutoJobOnRestart(value, now);
    assert.deepEqual(value, original);
    assert.equal(isAutoJobDue(value, Date.parse(now)), false);
  }
  const hash = 'a'.repeat(64);
  const variant = {reviewStatus: 'pending', contentSha256: hash,
    automaticAssessment: {status: 'passed', autoApproved: false, visualReview: {
      status: 'passed', sha256: hash, version: 'wis-visual-qc-20260908-v3', confidence: .95, issues: []}}};
  reconcileOutputApproval(variant, now, false);
  assert.equal(variant.reviewStatus, 'pending');
  assert.equal(variant.automaticAssessment.autoApproved, false);
  reconcileOutputApproval(variant, now, true);
  assert.equal(variant.reviewStatus, 'approved');
});

test('真实 initialize 保留 3 个 active 与 18 个 paused 的设置，既有待审与未安排批次不启动', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wis-startup-policy-'));
  t.after(() => fs.rm(dataDir, {recursive: true, force: true}));
  const libraryPath = path.join(dataDir, 'clip-remix', 'library.json');
  await fs.mkdir(path.dirname(libraryPath), {recursive: true});
  const make = (id, extra) => job({id, createdById: 'FD-026222', createdByName: 'Fixture',
    productCategory: 'WIS黑晶面膜', frameworkId: 'fixture-framework', ...extra});
  const jobs = [
    make('review', {runs: [{id: 'held', status: 'awaiting_review'}]}),
    make('one-shot-idle', {scheduleEnabled: false, nextRunAt: null}),
    make('one-shot-source', {scheduleEnabled: false, nextRunAt: null,
      runs: [{id: 'source-run', status: 'awaiting_sources'}]}),
    ...Array.from({length: 18}, (_, i) => make(`paused-${i}`, {status: 'paused', nextRunAt: null,
      runs: [{id: `paused-run-${i}`, status: 'generating'}]})),
  ];
  await fs.writeFile(libraryPath, JSON.stringify({version: 7, sources: [], clips: [],
    folders: [], frameworks: [], renders: [], autoJobs: jobs}));
  let mediaCalls = 0;
  const media = async () => {mediaCalls++; throw Error('startup must not start media work');};
  const service = createClipRemixService({dataDir, nowIso: () => now,
    maxFileBytes: 1e6, inspectMedia: media, makeSegment: media, runFfmpeg: media,
    runProcess: media, readJsonBody: async () => ({}), jsonResponse: () => {},
    materialCenter: {configured: false}, cutter: {configured: false}, autoRemixAdminUsers: 'FD-026222'});
  await service.initialize();
  await service.initialize();
  await new Promise(resolve => setTimeout(resolve, 40));
  const saved = JSON.parse(await fs.readFile(libraryPath, 'utf8')).autoJobs;
  assert.equal(saved.filter(value => value.status === 'active').length, 3);
  assert.equal(saved.filter(value => value.status === 'paused').length, 18);
  assert.equal(saved.every(value => value.autoApproveOutputs === false), true);
  assert.deepEqual(saved.filter(value => value.status === 'paused'), jobs.filter(value => value.status === 'paused'));
  assert.equal(saved.find(value => value.id === 'review').nextRunAt, null);
  assert.equal(saved.find(value => value.id === 'review').runs[0].status, 'awaiting_review');
  assert.equal(saved.filter(value => value.scheduleEnabled === false).every(value => value.nextRunAt === null), true);
  assert.equal(service.runtimeState().activeAutoJobCount, 0);
  assert.equal(mediaCalls, 0);
});
