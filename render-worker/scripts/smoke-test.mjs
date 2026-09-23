import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(__dirname, '..');
const artifactsDir = path.join(
  workerRoot,
  'artifacts',
  `smoke-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);
const fixturesDir = path.join(artifactsDir, 'fixtures');
const workerDataDir = path.join(artifactsDir, 'worker-data');
const outputDir = path.join(artifactsDir, 'outputs');
const port = 8799;
const baseUrl = `http://127.0.0.1:${port}`;
const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';

const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `命令退出码 ${code}`));
    });
  });

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitForHealth = async () => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return response.json();
    } catch {
      // Worker is still starting.
    }
    await wait(250);
  }
  throw new Error('渲染节点未能启动。');
};

await Promise.all([
  fs.mkdir(fixturesDir, { recursive: true }),
  fs.mkdir(workerDataDir, { recursive: true }),
  fs.mkdir(outputDir, { recursive: true }),
]);

const hookPath = path.join(fixturesDir, '新开头.mp4');
const sourceAudioPath = path.join(fixturesDir, '原成片-有声音.mp4');
const sourceSilentPath = path.join(fixturesDir, '原成片-无声音.mp4');

await run(ffmpegPath, [
  '-y',
  '-f',
  'lavfi',
  '-i',
  'color=c=0x2563eb:s=360x640:d=2.5',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=880:duration=2.5',
  '-shortest',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  hookPath,
]);
await run(ffmpegPath, [
  '-y',
  '-f',
  'lavfi',
  '-i',
  'testsrc2=s=480x854:d=7:r=25',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:duration=7',
  '-shortest',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  sourceAudioPath,
]);
await run(ffmpegPath, [
  '-y',
  '-f',
  'lavfi',
  '-i',
  'color=c=0x10b981:s=720x720:d=6:r=24',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  sourceSilentPath,
]);

const worker = spawn(process.execPath, [path.join(workerRoot, 'server.mjs')], {
  cwd: path.resolve(workerRoot, '..'),
  windowsHide: true,
  env: {
    ...process.env,
    RENDER_WORKER_PORT: String(port),
    RENDER_WORKER_DATA_DIR: workerDataDir,
    RENDER_WORKER_ALLOWED_ORIGINS: '*',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let workerLogs = '';
worker.stdout.on('data', (chunk) => {
  workerLogs = (workerLogs + chunk.toString()).slice(-12000);
});
worker.stderr.on('data', (chunk) => {
  workerLogs = (workerLogs + chunk.toString()).slice(-12000);
});

try {
  const health = await waitForHealth();
  if (!health.ffmpegAvailable) throw new Error('健康检查未识别到FFmpeg。');

  const formData = new FormData();
  formData.append(
    'hook',
    new Blob([await fs.readFile(hookPath)], { type: 'video/mp4' }),
    path.basename(hookPath),
  );
  for (const sourcePath of [sourceAudioPath, sourceSilentPath]) {
    formData.append(
      'sources',
      new Blob([await fs.readFile(sourcePath)], { type: 'video/mp4' }),
      path.basename(sourcePath),
    );
  }
  formData.append('hookDurationSeconds', '2');
  formData.append('sourceStartSeconds', '2');
  formData.append('fadeDurationSeconds', '0.15');
  formData.append('targetLoudnessLufs', '-16');

  const createResponse = await fetch(`${baseUrl}/api/jobs/batch-hook`, {
    method: 'POST',
    body: formData,
  });
  if (!createResponse.ok) {
    throw new Error(`创建任务失败：${await createResponse.text()}`);
  }
  let job = await createResponse.json();
  const deadline = Date.now() + 180000;
  while (['queued', 'processing'].includes(job.status) && Date.now() < deadline) {
    await wait(750);
    const response = await fetch(`${baseUrl}/api/jobs/${job.id}`);
    job = await response.json();
  }
  if (job.status !== 'completed') {
    throw new Error(`任务未完成：${JSON.stringify(job, null, 2)}\n${workerLogs}`);
  }
  for (const item of job.items) {
    if (!item.previewUrl || item.downloadUrl !== null) {
      throw new Error('审核前的预览或下载状态不符合预期。');
    }
    const rangeResponse = await fetch(`${baseUrl}${item.previewUrl}`, {
      headers: { Range: 'bytes=0-1023' },
    });
    if (rangeResponse.status !== 206) {
      throw new Error(`视频分段预览失败：${item.outputName}`);
    }
    const blockedDownload = await fetch(
      `${baseUrl}/api/jobs/${job.id}/output/${item.id}`,
    );
    if (blockedDownload.status !== 403) {
      throw new Error(`审核前下载未被拦截：${item.outputName}`);
    }
    const reviewResponse = await fetch(
      `${baseUrl}/api/jobs/${job.id}/items/${item.id}/review`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewStatus: 'approved', reviewNote: '自动验收' }),
      },
    );
    job = await reviewResponse.json();
    const approvedItem = job.items.find((current) => current.id === item.id);
    if (!approvedItem?.downloadUrl) {
      throw new Error(`审核后未生成下载地址：${item.outputName}`);
    }
    const response = await fetch(`${baseUrl}${approvedItem.downloadUrl}`);
    if (!response.ok) throw new Error(`下载失败：${item.outputName}`);
    await fs.writeFile(
      path.join(outputDir, item.outputName),
      Buffer.from(await response.arrayBuffer()),
    );
  }
  await fs.writeFile(
    path.join(artifactsDir, 'result.json'),
    JSON.stringify(job, null, 2),
    'utf8',
  );
  console.log(
    JSON.stringify({
      ok: true,
      jobId: job.id,
      outputs: job.items.length,
      artifactsDir,
    }),
  );
} finally {
  worker.kill();
}
