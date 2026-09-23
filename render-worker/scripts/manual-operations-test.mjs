import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createManualOperations } from '../manual-operations.mjs';
import { canReadSource, canReadClip, clipIsBlocked } from '../asset-access.mjs';

const waitFor = async (predicate) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Timed out');
};

test('persistent operation is immediate, deduplicated and owner isolated', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wis-operations-'));
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let count = 0;
  const operations = createManualOperations({
    directory,
    execute: async () => {
      count++;
      await gate;
      return { clip: { id: 'safe' } };
    },
  });
  await operations.initialize();
  const owner = { id: 'owner', name: 'Owner' };
  const first = await operations.submit('clip', { sourceId: 's1' }, owner);
  const second = await operations.submit('clip', { sourceId: 's1' }, owner);
  assert.equal(first.id, second.id);
  assert.equal(operations.get(first.id, { id: 'other' }), null);
  assert.deepEqual(operations.list({ id: 'other' }), []);
  assert.equal('payload' in first, false);
  release();
  await waitFor(() => operations.get(first.id, owner).status === 'completed');
  assert.equal(count, 1);
  const cached = await operations.submit('clip', { sourceId: 's1' }, owner);
  assert.equal(cached.result.clip.id, 'safe');
});

test('interrupted work resumes with the same id after restart', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wis-resume-'));
  const job = {
    id: 'abc-123',
    key: 'k',
    type: 'clip',
    payload: { sourceId: 's' },
    identity: { id: 'owner' },
    status: 'running',
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(
    path.join(directory, `${job.id}.json`),
    JSON.stringify(job),
  );
  let received;
  const operations = createManualOperations({
    directory,
    execute: async (_, payload) => {
      received = payload;
      return { ok: true };
    },
  });
  await operations.initialize();
  await waitFor(
    () => operations.get(job.id, job.identity).status === 'completed',
  );
  assert.equal(received.sourceId, 's');
  assert.equal(operations.get(job.id, job.identity).result.ok, true);
});

test('private clips inherit source isolation and review blocks cannot be hidden by approval', () => {
  const source = { visibility: 'private', createdById: 'a' };
  const clip = { visibility: 'private', createdByIds: ['a'] };
  assert.equal(canReadSource(source, { id: 'b' }), false);
  assert.equal(canReadClip(clip, source, { id: 'a' }), true);
  assert.equal(canReadClip(clip, source, { id: 'b' }), false);
  assert.equal(canReadSource({ createdById: 'a' }, { id: 'b' }), true);
  assert.equal(
    clipIsBlocked({
      reviewStatus: 'changes_requested',
      reviewNote: '平台卡审，涉嫌虚假宣传',
    }),
    true,
  );
  assert.equal(
    clipIsBlocked({ reviewStatus: 'approved', deliveryBlocked: true }),
    true,
  );
});
