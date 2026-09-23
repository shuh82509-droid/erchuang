import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createClipRemixService } from '../clip-remix-service.mjs';

test('split release blocks private uploads before jobs or media processing and preserves paused plans', async () => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wis-split-release-'),
  );
  const root = path.join(dataDir, 'clip-remix');
  await fs.mkdir(root);
  await fs.writeFile(
    path.join(root, 'library.json'),
    JSON.stringify({
      autoJobs: [
        {
          id: 'paused-fixture',
          status: 'paused',
          runs: [
            {
              id: 'run',
              status: 'failed',
              generatedCount: 0,
              targetCount: 10,
              errorMessage: 'The operation was aborted due to timeout',
            },
          ],
        },
      ],
    }),
  );
  const service = createClipRemixService({
    dataDir,
    maxFileBytes: 1e6,
    nowIso: () => new Date().toISOString(),
    inspectMedia: async () => {
      throw new Error('must reject before inspecting media');
    },
    materialCenter: { configured: false },
    cutter: { configured: false },
    jsonResponse: (res, status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    },
  });
  await service.initialize();
  const server = http.createServer((req, res) => {
    void service
      .route(req, res, new URL(req.url, 'http://localhost'), {
        sub: 'fixture-owner',
        name: 'Fixture',
      })
      .catch((error) => {
        res.writeHead(500);
        res.end(String(error));
      });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const [route, field] of [
      ['/api/remix/sources', 'source'],
      ['/api/remix/clip-uploads?background=1', 'source'],
    ]) {
      const form = new FormData();
      form.append(field, new Blob(['no business content']), 'fixture.mp4');
      form.append('visibility', 'private');
      form.append('productCategory', '黑晶面膜');
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}${route}`,
        { method: 'POST', body: form },
      );
      assert.equal(response.status, 400);
      assert.match((await response.json()).message, /私人上传尚未开放/u);
    }
    assert.deepEqual(await fs.readdir(path.join(root, 'sources')), []);
    assert.deepEqual(
      await fs.readdir(path.join(root, 'manual-operations')),
      [],
    );
    const library = JSON.parse(
      await fs.readFile(path.join(root, 'library.json'), 'utf8'),
    );
    assert.equal(
      library.autoJobs.find((job) => job.id === 'paused-fixture').status,
      'paused',
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
