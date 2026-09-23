import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import ffmpegPath from 'ffmpeg-static';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(workerRoot, '..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const artifactsDir = path.join(workerRoot, 'artifacts', `project-media-${stamp}`);
const dataDir = path.join(artifactsDir, 'worker-data');
const outputDir = path.join(artifactsDir, 'outputs');
const hookPath = path.join(
  projectRoot,
  'client',
  'public',
  'template-hooks',
  'birthday-product-hook.mp4',
);
const sourcePaths = [
  path.join(
    projectRoot,
    'client',
    'public',
    'template-hooks',
    'wis-stage-birthday.mp4',
  ),
  path.join(
    projectRoot,
    'client',
    'public',
    'template-hooks',
    'birthday-product-hook.mp4',
  ),
];
const port = 8801;
const baseUrl = `http://127.0.0.1:${port}`;

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const inspect = (filePath) =>
  new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-i', filePath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', () => {
      const duration = output.match(/Duration:\s*([^,]+)/)?.[1]?.trim() || '';
      const resolution = output.match(/Video:.*?(\d{2,5}x\d{2,5})/)?.[1] || '';
      resolve({ duration, resolution, hasAudio: /Audio:/.test(output) });
    });
  });

await Promise.all([
  fs.mkdir(dataDir, { recursive: true }),
  fs.mkdir(outputDir, { recursive: true }),
]);

const worker = spawn(process.execPath, [path.join(workerRoot, 'server.mjs')], {
  cwd: projectRoot,
  windowsHide: true,
  env: {
    ...process.env,
    RENDER_WORKER_PORT: String(port),
    RENDER_WORKER_DATA_DIR: dataDir,
    RENDER_WORKER_ALLOWED_ORIGINS: '*',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
for (const stream of [worker.stdout, worker.stderr]) {
  stream.on('data', (chunk) => {
    logs = (logs + chunk.toString()).slice(-12000);
  });
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // Worker is still starting.
    }
    await wait(250);
  }
  if (!ready) throw new Error(`真实素材验证节点未启动。${logs}`);

  const formData = new FormData();
  formData.append(
    'hook',
    new Blob([await fs.readFile(hookPath)], { type: 'video/mp4' }),
    path.basename(hookPath),
  );
  for (const sourcePath of sourcePaths) {
    formData.append(
      'sources',
      new Blob([await fs.readFile(sourcePath)], { type: 'video/mp4' }),
      path.basename(sourcePath),
    );
  }
  formData.append('hookDurationSeconds', '3');
  formData.append('sourceStartSeconds', '2');
  formData.append('fadeDurationSeconds', '0.2');
  formData.append('targetLoudnessLufs', '-16');

  const createResponse = await fetch(`${baseUrl}/api/jobs/batch-hook`, {
    method: 'POST',
    body: formData,
  });
  if (!createResponse.ok) {
    throw new Error(`真实素材任务创建失败：${await createResponse.text()}`);
  }
  let job = await createResponse.json();
  const deadline = Date.now() + 180000;
  while (['queued', 'processing'].includes(job.status) && Date.now() < deadline) {
    await wait(800);
    const response = await fetch(`${baseUrl}/api/jobs/${job.id}`);
    job = await response.json();
  }
  if (job.status !== 'completed') {
    throw new Error(`真实素材任务未完成：${JSON.stringify(job, null, 2)}\n${logs}`);
  }

  const evidence = [];
  for (const item of job.items) {
    if (!item.previewUrl || item.downloadUrl !== null) {
      throw new Error(`真实素材审核门禁状态异常：${item.outputName}`);
    }
    const reviewResponse = await fetch(
      `${baseUrl}/api/jobs/${job.id}/items/${item.id}/review`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewStatus: 'approved', reviewNote: '真实素材验收' }),
      },
    );
    job = await reviewResponse.json();
    const approvedItem = job.items.find((current) => current.id === item.id);
    if (!approvedItem?.downloadUrl) {
      throw new Error(`审核后下载地址缺失：${item.outputName}`);
    }
    const response = await fetch(`${baseUrl}${approvedItem.downloadUrl}`);
    if (!response.ok) {
      throw new Error(`真实素材下载失败：${item.outputName}`);
    }
    const targetPath = path.join(outputDir, item.outputName);
    await fs.writeFile(targetPath, Buffer.from(await response.arrayBuffer()));
    evidence.push({
      file: item.outputName,
      ...(await inspect(targetPath)),
    });
  }
  const result = {
    ok: true,
    jobId: job.id,
    status: job.status,
    sourceCount: sourcePaths.length,
    artifactsDir,
    outputs: evidence,
  };
  await fs.writeFile(
    path.join(artifactsDir, 'result.json'),
    JSON.stringify(result, null, 2),
    'utf8',
  );
  console.log(JSON.stringify(result));
} finally {
  worker.kill();
}
