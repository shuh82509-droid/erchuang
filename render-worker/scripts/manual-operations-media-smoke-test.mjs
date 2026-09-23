import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const workerRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const dataDir = await fs.mkdtemp(path.join(process.env.MANUAL_OPERATION_TEST_EVIDENCE_ROOT || os.tmpdir(), 'wis-manual-media-'));
const externalSource = process.env.MANUAL_OPERATION_TEST_SOURCE;
const fixture = externalSource
  ? path.resolve(externalSource)
  : path.join(dataDir, 'fixture.mp4');
const base = 'http://127.0.0.1:8814';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const command = async (executable, args) => {
  const child = spawn(executable, args, { windowsHide: true });
  let output = '';
  let errors = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    errors = (errors + chunk).slice(-4000);
  });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, errors);
  return output;
};
if (!externalSource)
  await command(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=360x640:d=6:r=25',
    '-c:v',
    'libx264',
    '-threads',
    '2',
    '-pix_fmt',
    'yuv420p',
    fixture,
  ]);
const worker = spawn(process.execPath, [path.join(workerRoot, 'server.mjs')], {
  cwd: path.dirname(workerRoot),
  windowsHide: true,
  env: {
    ...process.env,
    RENDER_WORKER_SHARED_SECRET: '',
    RENDER_WORKER_PORT: '8814',
    RENDER_WORKER_DATA_DIR: dataDir,
    WIS_MATERIAL_CENTER_BASE_URL: '',
    WIS_MATERIAL_CENTER_TOKEN: '',
    WIS_CUTTER_BASE_URL: '',
    CONTINUOUS_CLIP_SUPPLY_INITIAL_DELAY_MS: '600000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
for (const stream of [worker.stdout, worker.stderr])
  stream.on('data', (chunk) => {
    logs = (logs + chunk).slice(-4000);
  });
const json = async (route, init) => {
  const response = await fetch(base + route, init);
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  return { result, status: response.status };
};
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      ready = (await fetch(base + '/health')).ok;
    } catch {}
    if (ready) break;
    await sleep(250);
  }
  assert.ok(ready, logs);
  const upload = new FormData();
  upload.append(
    'source',
    new Blob([await fs.readFile(fixture)]),
    path.basename(fixture),
  );
  upload.append('visibility', 'team');
  const {
    result: { source },
  } = await json('/api/remix/sources', { method: 'POST', body: upload });
  const payload = {
    sourceId: source.id,
    startSeconds: 1,
    endSeconds: 4,
    role: 'hook',
    name: '后台整数秒切片验收',
    tags: '验收',
    productCategory: process.env.MANUAL_OPERATION_TEST_CATEGORY || '黑晶面膜',
  };
  const submit = () =>
    json('/api/remix/operations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'clip', payload }),
    });
  const start = Date.now();
  const {
    result: { operation },
    status,
  } = await submit();
  const acceptedMs = Date.now() - start;
  assert.equal(status, 202);
  assert.ok(acceptedMs < 5000, `submission took ${acceptedMs}ms`);
  assert.equal((await submit()).result.operation.id, operation.id);
  let current = operation;
  const deadline = Date.now() + 120000;
  while (
    !['completed', 'failed'].includes(current.status) &&
    Date.now() < deadline
  ) {
    await sleep(250);
    current = (await json(`/api/remix/operations/${operation.id}`)).result
      .operation;
  }
  assert.equal(current.status, 'completed', JSON.stringify(current));
  const library = JSON.parse(
    await fs.readFile(path.join(dataDir, 'clip-remix/library.json'), 'utf8'),
  );
  const matches = library.clips.filter((clip) => clip.sourceId === source.id);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, current.result.clip.id);
  const clip = matches[0];
  const media = JSON.parse(
    await command(process.env.FFPROBE_PATH || 'ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=width,height,nb_frames,r_frame_rate',
      '-of',
      'json',
      path.join(dataDir, 'clip-remix/clips', clip.storedName),
    ]),
  );
  assert.ok(
    Math.abs(Number(media.format.duration) - 3) <= 0.12,
    JSON.stringify(media),
  );
  assert.ok(
    media.streams.some((stream) => stream.width > 0 && stream.height > 0),
  );
  const videoStream = media.streams.find((stream) => stream.width > 0);
  const [fpsNumerator, fpsDenominator] = videoStream.r_frame_rate.split('/').map(Number);
  assert.equal(Number(videoStream.nb_frames), Math.round(3 * fpsNumerator / fpsDenominator));
  assert.equal((await submit()).result.operation.id, operation.id);
  console.log(
    JSON.stringify({
      ok: true,
      acceptedMs,
      clipCount: matches.length,
      duration: media.format.duration,
      operationStatus: current.status,
      source: fixture,
      outputFile: path.join(dataDir, 'clip-remix/clips', clip.storedName),
      streams: media.streams,
    }),
  );
} finally {
  const closed = once(worker, 'close');
  worker.kill();
  await closed;
  // Keep only this isolated temporary fixture directory as test evidence.
}
