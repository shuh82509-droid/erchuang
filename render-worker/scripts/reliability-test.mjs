import assert from 'node:assert/strict';
import { test } from 'node:test';
import { effectiveCpuCapacity, cpuProcessLimit, createProcessGovernor } from '../process-governor.mjs';
import { serializeLibrary, unchangedLibrary, persistLibraryUpdate, createDeduplicatedLibraryWriter } from '../library-persistence.mjs';

test('container CPU quota, not host CPU count, bounds heavy processes', () => {
  assert.equal(effectiveCpuCapacity(() => '50000 100000', 12), 0.5);
  assert.equal(cpuProcessLimit(0.5, '4'), 1);
  assert.equal(cpuProcessLimit(2, '4'), 2);
  assert.equal(cpuProcessLimit(12, '2'), 2);
  assert.equal(effectiveCpuCapacity(() => 'max 100000', 3), 3);
  const v1 = (file) => { if (file.endsWith('cpu.max')) throw new Error(); return file.endsWith('cpu.cfs_quota_us') ? '150000' : '100000'; };
  assert.equal(effectiveCpuCapacity(v1, 12), 1.5);
  assert.equal(effectiveCpuCapacity(() => { throw new Error(); }, 6), 6);
});
test('OCR and render share a fair bounded pool; failure releases the slot', async () => {
  const governor = createProcessGovernor(1);
  let peak = 0;
  const sequence = [];
  const jobs = Array.from({ length: 12 }, (_, index) => governor.run(async () => {
    peak = Math.max(peak, governor.snapshot().active);
    sequence.push(index);
    await new Promise(resolve => setTimeout(resolve, 2));
    if (index === 4) throw new Error('simulated render failure');
    return index;
  }));
  const results = await Promise.allSettled(jobs);
  assert.equal(peak, 1);
  assert.deepEqual(sequence, Array.from({ length: 12 }, (_, i) => i));
  assert.equal(results.filter(x => x.status === 'rejected').length, 1);
  assert.deepEqual(governor.snapshot(), { maximum: 1, active: 0, waiting: 0 });
});
test('multi-core pool still uses concurrency when actually available', async () => {
  const governor = createProcessGovernor(2);
  let peak = 0;
  await Promise.all(Array.from({ length: 5 }, () => governor.run(async () => {
    peak = Math.max(peak, governor.snapshot().active);
    await new Promise(resolve => setTimeout(resolve, 2));
  })));
  assert.equal(peak, 2);
});
test('compact snapshot retains all fields and reduces bytes', () => {
  const library = { version: 1, sources: Array.from({ length: 100 }, (_, i) => ({ id: String(i), title: '真实素材', data: { count: null, approved: false, tags: ['测试'] } })) };
  const compact = serializeLibrary(library);
  assert.deepEqual(JSON.parse(compact), library);
  assert.ok(Buffer.byteLength(compact) < Buffer.byteLength(JSON.stringify(library, null, 2)) * 0.8);
});
test('only explicitly unchanged updates skip persistence; mutations still await durable write', async () => {
  const library = { count: 1 };
  let writes = 0;
  const write = async () => { writes++; };
  assert.equal(await persistLibraryUpdate(library, () => unchangedLibrary(null), write), null);
  assert.equal(writes, 0);
  assert.equal(await persistLibraryUpdate(library, state => { state.count++; return false; }, write), false);
  assert.equal(writes, 1);
  assert.equal(library.count, 2);
  await assert.rejects(persistLibraryUpdate(library, () => true, async () => { throw new Error('disk error'); }), /disk error/);
});

test('unchanged snapshots do not rewrite the entire library; failed commits are retried', async () => {
  let writes = 0;
  let fail = false;
  const writer = createDeduplicatedLibraryWriter(async (state, serialized) => {
    assert.deepEqual(JSON.parse(serialized), state);
    writes++;
    if (fail) throw new Error('disk failure');
  });
  const library = { jobs: [{ id: 'original', status: 'queued' }], private: true };
  assert.equal(await writer(library), true);
  for (let i = 0; i < 20; i++) assert.equal(await writer(library), false);
  assert.equal(writes, 1);
  library.jobs[0].status = 'completed';
  fail = true;
  await assert.rejects(writer(library), /disk failure/);
  fail = false;
  assert.equal(await writer(library), true);
  assert.equal(writes, 3);
});
