import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createClipRemixService } from '../clip-remix-service.mjs';

test('private upload, async recut, owner-only polling, interval rejection and no duplicate work', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wis-private-flow-'));
  await fs.mkdir(path.join(dataDir, 'clip-remix'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'clip-remix', 'library.json'), JSON.stringify({
    version: 7, sources: [], clips: [], folders: [], frameworks: [], autoJobs: [],
    renders: [{ id: 'quarantined-output', createdById: 'A', visibility: 'team', variants: [{
      id: '1', reviewStatus: 'approved', platformReview: { status: 'needs_localization' },
      automaticAssessment: { status: 'passed', autoApproved: true },
    }] }],
  }));
  let cuts = 0;
  let failNextCut = false;
  let privateDownloads = 0;
  const privateAssetId = 'aa000000-0000-4000-8000-000000000001';
  const materialFixture = {
    configured: false,
    getPrivateAsset: async (id, owner) => {
      if (id !== privateAssetId || owner !== 'A') throw new Error('私人素材不存在');
      return { id, visibility: 'private', status: 'ready', filename: 'cloud-private.mp4', size: 7, content_type: 'video/mp4', category: '黑晶面膜', folder_name: '我的测试' };
    },
    listPrivateAssets: async owner => ({ items: owner === 'A' ? [{ id: privateAssetId }] : [], total: owner === 'A' ? 1 : 0 }),
    downloadPrivateAsset: async (_asset, owner, destination) => {
      assert.equal(owner, 'A'); privateDownloads++;
      await fs.writeFile(destination, 'fixture');
    },
  };
  const service = createClipRemixService({
    dataDir,
    allowPrivateUploads: true,
    maxFileBytes: 1e6,
    nowIso: () => new Date().toISOString(),
    inspectMedia: async () => ({
      duration: 10,
      hasAudio: true,
      frameRate: 30,
      width: 1080,
      height: 1920,
      videoCodec: 'h264',
      audioCodec: 'aac',
      pixelFormat: 'yuv420p',
    }),
    makeSegment: async ({ outputPath }) => {
      cuts++;
      if (failNextCut) {
        failNextCut = false;
        throw new Error('fixture transient encoder failure');
      }
      await new Promise((r) => setTimeout(r, 100));
      await fs.writeFile(outputPath, 'fixture');
    },
    runFfmpeg: async () => {
      throw new Error('upload must not transcode previews');
    },
    runProcess: async () => ({ stdout: '', stderr: '' }),
    readJsonBody: async (req) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      return JSON.parse(Buffer.concat(chunks).toString());
    },
    jsonResponse: (res, status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    },
    materialCenter: materialFixture,
    cutter: { configured: false },
  });
  await service.initialize();
  const server = http.createServer((req, res) => {
    void service
      .route(req, res, new URL(req.url, 'http://localhost'), {
        sub: req.headers['x-test-owner'] || 'A',
        name: 'Test',
      })
      .then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      })
      .catch((error) => {
        res.writeHead(500);
        res.end(String(error));
      });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, owner = 'A', body, method = 'POST') => {
    const response = await fetch(base + url, {
      method: body ? method : 'GET',
      headers: {
        'x-test-owner': owner,
        ...(body && !(body instanceof FormData)
          ? { 'Content-Type': 'application/json' }
          : {}),
      },
      body:
        body instanceof FormData
          ? body
          : body
            ? JSON.stringify(body)
            : undefined,
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    for (let cancellation = 0; cancellation < 5; cancellation++) {
      await new Promise((resolve) => {
        const abortedUpload = http.request(base + '/api/remix/sources', {
          method: 'POST', headers: { 'x-test-owner': 'A',
            'Content-Type': 'multipart/form-data; boundary=abort-fixture' },
        });
        abortedUpload.on('error', () => resolve());
        abortedUpload.write('--abort-fixture\r\nContent-Disposition: form-data; name="source"; filename="cancelled.mp4"\r\nContent-Type: video/mp4\r\n\r\n');
        abortedUpload.write(Buffer.alloc(500000));
        setTimeout(() => { abortedUpload.destroy(); resolve(); }, 30);
      });
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await request('/api/remix/library')).status, 200);
    assert.equal((await fs.readdir(path.join(dataDir, 'clip-remix', 'sources'))).length, 0,
      'cancelled multipart uploads must not leave partial private files');
    for (const action of ['review', 'return-to-material-center']) {
      const quarantined = await request(`/api/remix/renders/quarantined-output/variants/1/${action}`,
        'A', { reviewStatus: 'approved' });
      assert.equal(quarantined.status, 409);
      assert.match(quarantined.data.message, /千川明确拒绝/);
    }
    // Project import is deferred. Do not expose the former routes, even when
    // private video uploads are enabled.
    for (const [method, suffix] of [
      ['GET', ''],
      ['POST', ''],
      ['GET', '/00000000-0000-0000-0000-000000000000/archive'],
    ]) {
      const response = await fetch(base + '/api/remix/project-imports' + suffix, {
        method,
        headers: { 'x-test-owner': 'A' },
      });
      assert.equal(response.status, 404);
      await response.arrayBuffer();
    }
    const form = new FormData();
    form.append('source', new Blob(['private fixture']), 'private.mp4');
    form.append('visibility', 'private');
    const uploaded = await request('/api/remix/sources', 'A', form);
    assert.equal(uploaded.status, 201);
    const sourceId = uploaded.data.source.id;
    assert.equal(uploaded.data.source.visibility, 'private');
    const frameworkBody = {
      name: 'private source framework',
      sourceId,
      sourceType: 'parsed',
      slots: [
        { id: 'hook', label: '开头' },
        { id: 'proof', label: '证明' },
      ],
    };
    assert.equal(
      (await request('/api/remix/frameworks', 'B', frameworkBody)).status,
      400,
    );
    const framework = (
      await request('/api/remix/frameworks', 'A', frameworkBody)
    ).data.framework;
    assert.equal(framework.visibility, 'private');
    const promoted = (
      await request(`/api/remix/frameworks/${framework.id}/promote`, 'A', {})
    ).data.framework;
    const otherLibrary = (await request('/api/remix/library', 'B')).data;
    assert.equal(
      otherLibrary.frameworks.some((item) =>
        [framework.id, promoted.id].includes(item.id),
      ),
      false,
    );
    assert.equal(
      (await request(`/api/remix/frameworks/${framework.id}/promote`, 'B', {}))
        .status,
      400,
    );
    assert.equal(
      (
        await request(
          `/api/remix/frameworks/${framework.id}`,
          'B',
          {},
          'DELETE',
        )
      ).status,
      409,
    );
    assert.equal(
      (await request('/api/remix/renders', 'B', { frameworkId: framework.id }))
        .status,
      400,
    );
    const folder = (
      await request('/api/remix/folders', 'A', { name: '我的测试目录' })
    ).data.folder;
    assert.equal(
      (
        await request('/api/remix/folders', 'B', {
          name: '不可跨账号',
          parentId: folder.id,
        })
      ).status,
      400,
    );
    assert.equal(
      (await request('/api/remix/library', 'B')).data.folders.some(
        (item) => item.id === folder.id,
      ),
      false,
    );
    assert.equal(
      (await request('/api/remix/library', 'B')).data.sources.length,
      0,
    );
    assert.equal(
      (await request(`/api/remix/media/source/${sourceId}`, 'B')).status,
      404,
    );
    assert.equal(
      (await request(`/api/remix/sources/${sourceId}/analyze`, 'B', {})).status,
      404,
    );
    const payload = {
      sourceId,
      startSeconds: 1,
      endSeconds: 4,
      name: 'private slice',
      role: 'hook',
      productCategory: '黑晶面膜',
    };
    const queued = await request('/api/remix/operations', 'A', {
      type: 'clip',
      payload,
    });
    assert.equal(queued.status, 202);
    const repeated = await request('/api/remix/operations', 'A', {
      type: 'clip',
      payload,
    });
    assert.equal(repeated.data.operation.id, queued.data.operation.id);
    const operationUrl = `/api/remix/operations/${queued.data.operation.id}`;
    assert.equal((await request(operationUrl, 'B')).status, 404);
    let operation;
    for (let i = 0; i < 100; i++) {
      operation = (await request(operationUrl)).data.operation;
      if (operation.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(operation.status, 'completed', operation.message);
    assert.equal(cuts, 1);
    const clip = operation.result.clip;
    assert.equal(clip.visibility, 'private');
    assert.equal(
      (await request('/api/remix/library', 'B')).data.clips.length,
      0,
    );
    assert.equal(
      (await request(`/api/remix/media/clip/${clip.id}`, 'B')).status,
      404,
    );
    assert.equal(
      (
        await request(`/api/remix/clips/${clip.id}/review`, 'A', {
          reviewStatus: 'changes_requested',
          reviewNote: '千川卡审：虚假宣传',
        })
      ).status,
      200,
    );
    const blocked = await request('/api/remix/clips', 'A', {
      ...payload,
      role: 'proof',
      startSeconds: 2,
      endSeconds: 3,
    });
    assert.equal(blocked.status, 400);
    assert.match(blocked.data.message, /卡审|违规/u);
    assert.equal(cuts, 1);

    // Reconnecting must receive current review state, not the old completed-job snapshot.
    assert.equal(
      (await request(operationUrl)).data.operation.result.clip.reviewStatus,
      'changes_requested',
    );
    assert.equal(
      (await request('/api/remix/operations')).data.operations.find(
        (item) => item.id === operation.id,
      ).result.clip.reviewStatus,
      'changes_requested',
    );

    // Accepted direct-upload bytes remain available when encoding fails.
    failNextCut = true;
    const directForm = new FormData();
    directForm.append(
      'source',
      new Blob(['different private clip']),
      'direct.mp4',
    );
    directForm.append('productCategory', '黑晶面膜');
    directForm.append('visibility', 'private');
    const direct = await request(
      '/api/remix/clip-uploads?background=1',
      'A',
      directForm,
    );
    assert.equal(direct.status, 202);
    const directUrl = `/api/remix/operations/${direct.data.operation.id}`;
    const waitForStatus = async (status) => {
      let job;
      for (let i = 0; i < 100; i++) {
        job = (await request(directUrl)).data.operation;
        if (job.status === status) return job;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail(`Expected ${status}, got ${job.status}: ${job.message}`);
    };
    await waitForStatus('failed');
    assert.equal((await request(`${directUrl}/retry`, 'B', {})).status, 404);
    const retry = await request(`${directUrl}/retry`, 'A', {});
    assert.equal(retry.data.operation.id, direct.data.operation.id);
    const done = await waitForStatus('completed');
    assert.equal(done.result.clip.visibility, 'private');
    assert.equal(
      (await request('/api/remix/library', 'A')).data.sources.length,
      2,
    );
    assert.equal(
      (await request('/api/remix/library', 'B')).data.clips.length,
      0,
    );
    assert.equal(cuts, 3); // first recut, failed encode, successful retry
    materialFixture.configured = true;
    const cloudList = await request('/api/remix/material-center/private-assets?actor_number=A', 'B');
    assert.equal(cloudList.data.total, 0); // actor must come from server session
    const body = { type: 'import-private', payload: { assetId: privateAssetId } };
    const imported = await request('/api/remix/operations', 'A', body);
    assert.equal(imported.status, 202);
    const awaitImport = async (operation, owner, status) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const current = await request(`/api/remix/operations/${operation.id}`, owner);
        if (current.data.operation.status === status) return current.data.operation;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.fail('Cloud private operation did not reach expected status');
    };
    const result = await awaitImport(imported.data.operation, 'A', 'completed');
    assert.equal(result.result.source.visibility, 'private');
    assert.equal(result.result.source.isMine, true);
    assert.equal((await request('/api/remix/operations', 'A', body)).data.operation.id, imported.data.operation.id);
    assert.equal(privateDownloads, 1);
    assert.equal((await request('/api/remix/library', 'B')).data.sources.length, 0);
    const forbidden = await request('/api/remix/operations', 'B', body);
    const denied = await awaitImport(forbidden.data.operation, 'B', 'failed');
    assert.equal(denied.result, undefined);
    assert.equal(privateDownloads, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
