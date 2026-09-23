import {createAsrEvidenceResolver} from './asr-evidence-store.mjs';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';

import Busboy from 'busboy';
import { createClipRemixService } from './clip-remix-service.mjs';
import { cutterClient } from './cutter-client.mjs';
import { materialCenterClient } from './material-center-client.mjs';
import { createStableAppService } from './stable-app-service.mjs';
import { effectiveCpuCapacity, cpuProcessLimit, createProcessGovernor } from './process-governor.mjs';

const boundedEnvNumber = (value, fallback, min, max) => {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(max, Math.max(min, parsed))
    : fallback;
};

const WORKER_VERSION = '0.5.21';
const HOST = process.env.RENDER_WORKER_HOST || '127.0.0.1';
const PORT = Number(process.env.RENDER_WORKER_PORT || 8787);
const MIGRATION_VALIDATION_MODE = process.env.RENDER_WORKER_MIGRATION_VALIDATION === '1';
const READ_ONLY_PREVIEW = process.env.RENDER_WORKER_READ_ONLY_PREVIEW === '1';
const HUB_INTEGRATED_MODE = process.env.HUB_INTEGRATED_MODE === '1';
const MAX_SOURCES = 20;

const pipeFileToResponse = (req, res, filePath, options = undefined) =>
  new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, options);
    let settled = false;
    const cleanup = () => {
      req.off('aborted', onClientClose);
      res.off('close', onClientClose);
      res.off('error', onClientClose);
      res.off('finish', onFinish);
      stream.off('error', onStreamError);
    };
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onClientClose = () => {
      stream.destroy();
      settle(resolve);
    };
    const onFinish = () => settle(resolve);
    const onStreamError = (error) => {
      if (req.destroyed || res.destroyed) {
        settle(resolve);
        return;
      }
      settle(() => reject(error));
    };
    req.once('aborted', onClientClose);
    res.once('close', onClientClose);
    res.once('error', onClientClose);
    res.once('finish', onFinish);
    stream.once('error', onStreamError);
    stream.pipe(res);
  });
const MAX_FILE_BYTES = Number(
  process.env.RENDER_WORKER_MAX_FILE_BYTES || 1024 * 1024 * 1024,
);
const WORKER_ID = process.env.RENDER_WORKER_ID || `wis-render-${HOST}-${PORT}`;
const SHARED_SECRET = process.env.RENDER_WORKER_SHARED_SECRET || '';
const MATERIAL_CENTER_INTEGRATION_TOKEN = String(
  process.env.WIS_MATERIAL_CENTER_TOKEN || '',
).trim();
const AUTH_REQUIRED = Boolean(SHARED_SECRET);
const RETENTION_DAYS = boundedEnvNumber(
  process.env.RENDER_WORKER_RETENTION_DAYS,
  14,
  1,
  90,
);
const CLEANUP_INTERVAL_HOURS = boundedEnvNumber(
  process.env.RENDER_WORKER_CLEANUP_INTERVAL_HOURS,
  6,
  1,
  24,
);
const PROCESS_MAX_CONCURRENCY = Math.trunc(
  boundedEnvNumber(process.env.RENDER_WORKER_PROCESS_MAX_CONCURRENCY, 2, 1, 4),
);
const OCR_PROCESS_MAX_CONCURRENCY = Math.trunc(
  boundedEnvNumber(process.env.RENDER_WORKER_OCR_MAX_CONCURRENCY, 2, 1, 4),
);
const EFFECTIVE_CPU_CAPACITY = effectiveCpuCapacity();
const CPU_PROCESS_LIMIT = cpuProcessLimit(EFFECTIVE_CPU_CAPACITY, process.env.RENDER_WORKER_CPU_MAX_CONCURRENCY);
const ENCODING_THREADS = Math.min(2, CPU_PROCESS_LIMIT);
const cpuGovernor = createProcessGovernor(CPU_PROCESS_LIMIT);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(
  process.env.RENDER_WORKER_DATA_DIR || path.join(__dirname, 'data'),
);
const FFMPEG_PATH = String(process.env.FFMPEG_PATH || 'ffmpeg').trim();
const FFPROBE_PATH = String(
  process.env.FFPROBE_PATH ||
    (path.basename(FFMPEG_PATH).toLowerCase().startsWith('ffmpeg')
      ? path.join(
          path.dirname(FFMPEG_PATH),
          path.basename(FFMPEG_PATH).replace(/^ffmpeg/i, 'ffprobe'),
        )
      : 'ffprobe'),
).trim();
const TESSERACT_PATH = String(process.env.TESSERACT_PATH || 'tesseract').trim();
const CJK_FONT_FILE = String(
  process.env.WIS_CJK_FONT_FILE ||
    (process.platform === 'win32'
      ? 'C:\\Windows\\Fonts\\msyh.ttc'
      : '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'),
).trim();
const JOBS_DIR = path.join(DATA_DIR, 'jobs');
const allowedOrigins = (process.env.RENDER_WORKER_ALLOWED_ORIGINS || '*')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const stableAppService = createStableAppService({
  sharedSecret: SHARED_SECRET,
  staticDir: process.env.STABLE_APP_STATIC_DIR,
  publicPrefix: process.env.STABLE_APP_PUBLIC_PREFIX,
  workerPublicUrl: process.env.RENDER_WORKER_PUBLIC_URL,
  oaApiBaseUrl: process.env.OA_API_BASE_URL,
  oaClientId: process.env.OA_CLIENT_ID,
  oaClientSecret: process.env.OA_CLIENT_SECRET,
  oaGrantType: process.env.OA_GRANT_TYPE,
  accessAuthorityUrl: process.env.OA_ACCESS_AUTHORITY_URL,
  accessAuthorityToken: process.env.WIS_MATERIAL_CENTER_TOKEN,
  integratedMode: HUB_INTEGRATED_MODE,
});

const jobs = new Map();
const queue = [];
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let activeJobId = null;
let queueRunning = false;
let activeProcessCount = 0;
const processWaiters = [];
let activeOcrProcessCount = 0;
const ocrProcessWaiters = [];

const nowIso = () => new Date().toISOString();

const jsonResponse = (res, statusCode, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
};

const applyCors = (req, res) => {
  const origin = req.headers.origin;
  const allowAll = allowedOrigins.includes('*');
  if (allowAll) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET,POST,PATCH,DELETE,OPTIONS',
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization,Content-Type,Range,If-None-Match',
  );
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Accept-Ranges,Content-Length,Content-Range,ETag,Server-Timing',
  );
};

const tokenFromRequest = (req, url) => {
  const authorization = String(req.headers.authorization || '');
  if (authorization.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length).trim();
  }
  return url.searchParams.get('access_token') || '';
};

const verifyAccessToken = (token) => {
  if (!AUTH_REQUIRED) {
    return { sub: 'local-user', name: '本地工作台', local: true };
  }
  const [payload, signature, extra] = String(token || '').split('.');
  if (!payload || !signature || extra) return null;
  const expected = createHmac('sha256', SHARED_SECRET)
    .update(payload)
    .digest('base64url');
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return null;
  }
  try {
    const claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    );
    const nowSeconds = Math.floor(Date.now() / 1000);
    const valid =
      claims.iss === 'wis-workstation' &&
      claims.aud === 'wis-render-worker' &&
      Number.isFinite(claims.exp) &&
      claims.exp > nowSeconds &&
      Number.isFinite(claims.iat) &&
      claims.iat <= nowSeconds + 60;
    return valid ? claims : null;
  } catch {
    return null;
  }
};

const safeSecretEqual = (provided, expected) => {
  const providedBuffer = Buffer.from(String(provided || ''));
  const expectedBuffer = Buffer.from(String(expected || ''));
  return (
    expectedBuffer.length >= 32 &&
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
};

const safeFileName = (value) => {
  const normalized = String(value || 'video.mp4')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.slice(0, 120) || 'video.mp4';
};

const outputNameFor = (sourceName, index) => {
  const parsed = path.parse(safeFileName(sourceName));
  const stem = parsed.name || `素材-${index + 1}`;
  return `换开头-${String(index + 1).padStart(2, '0')}-${stem}.mp4`;
};

const parseNumber = (value, fallback, min, max) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const jobFilePath = (jobId) => path.join(JOBS_DIR, jobId, 'job.json');

const saveJob = async (job) => {
  job.updatedAt = nowIso();
  await fs.writeFile(jobFilePath(job.id), JSON.stringify(job, null, 2), 'utf8');
};

const publicJob = (job) => ({
  id: job.id,
  mode: job.mode,
  status: job.status,
  progress: job.progress,
  hookName: job.hookName,
  sourceCount: job.sourceCount,
  completedCount: job.completedCount,
  failedCount: job.failedCount,
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
  config: job.config,
  items: job.items.map((item) => ({
    id: item.id,
    sourceName: item.sourceName,
    outputName: item.outputName,
    status: item.status,
    progress: item.progress,
    error: item.error,
    previewUrl:
      item.status === 'completed'
        ? `/api/jobs/${job.id}/output/${item.id}?preview=1`
        : null,
    downloadUrl:
      item.status === 'completed' && item.reviewStatus === 'approved'
        ? `/api/jobs/${job.id}/output/${item.id}`
        : null,
    reviewStatus: item.reviewStatus,
    reviewNote: item.reviewNote,
    reviewedAt: item.reviewedAt,
  })),
});

const acquireProcessSlot = () => {
  if (activeProcessCount < PROCESS_MAX_CONCURRENCY) {
    activeProcessCount += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => processWaiters.push(resolve));
};

const releaseProcessSlot = () => {
  const next = processWaiters.shift();
  if (next) {
    next();
    return;
  }
  activeProcessCount = Math.max(0, activeProcessCount - 1);
};

const acquireOcrProcessSlot = () => {
  if (activeOcrProcessCount < OCR_PROCESS_MAX_CONCURRENCY) {
    activeOcrProcessCount += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => ocrProcessWaiters.push(resolve));
};

const releaseOcrProcessSlot = () => {
  const next = ocrProcessWaiters.shift();
  if (next) {
    next();
    return;
  }
  activeOcrProcessCount = Math.max(0, activeOcrProcessCount - 1);
};

const runProcessWithoutGovernor = (
  command,
  args,
  { acceptExitCodes = [0], timeoutMs = 0 } = {},
) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill();
      }, timeoutMs);
    }
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk.toString()).slice(-20000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-20000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (acceptExitCodes.includes(code)) {
        resolve({ code, stdout, stderr });
        return;
      }
      reject(
        new Error(
          `视频处理失败（退出码 ${code ?? 'unknown'}）：${stderr.trim().slice(-1200)}`,
        ),
      );
    });
  });

let probeQueue = Promise.resolve();
const runProcess = async (command, args, options = {}) => {
  if (options.resourceClass === 'probe') {
    const operation = probeQueue.then(() =>
      runProcessWithoutGovernor(command, args, options),
    );
    probeQueue = operation.catch(() => undefined);
    return operation;
  }
  const ocrProcess = options.resourceClass === 'ocr';
  await (ocrProcess ? acquireOcrProcessSlot() : acquireProcessSlot());
  try {
    // OCR and FFmpeg share the same container quota, not independent CPU pools.
    return await cpuGovernor.run(() => runProcessWithoutGovernor(command, args, options));
  } finally {
    if (ocrProcess) releaseOcrProcessSlot();
    else releaseProcessSlot();
  }
};

const parsedFrameRate = (value) => {
  const [numerator, denominator = '1'] = String(value || '').split('/');
  const rate = Number(numerator) / Number(denominator);
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
};

const inspectMedia = async (filePath) => {
  let probe = null;
  try {
    const result = await runProcess(
      FFPROBE_PATH,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration:stream=index,codec_type,codec_name,pix_fmt,width,height,avg_frame_rate,r_frame_rate,time_base,nb_frames',
        '-of',
        'json',
        filePath,
      ],
      { timeoutMs: 20000, resourceClass: 'probe' },
    );
    probe = JSON.parse(result.stdout || '{}');
  } catch {
    probe = null;
  }
  const probedVideoStream = Array.isArray(probe?.streams)
    ? probe.streams.find((stream) => stream.codec_type === 'video')
    : null;
  const probedDuration = Number(probe?.format?.duration) || 0;
  let output = '';
  if (!probedVideoStream || probedDuration <= 0) {
    const result = await runProcess(
      FFMPEG_PATH,
      ['-hide_banner', '-i', filePath],
      {
        acceptExitCodes: [0, 1],
        timeoutMs: 20000,
        resourceClass: 'probe',
      },
    );
    output = `${result.stdout}\n${result.stderr}`;
  }
  const durationMatch = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const fallbackDuration = durationMatch
    ? Number(durationMatch[1]) * 3600 +
      Number(durationMatch[2]) * 60 +
      Number(durationMatch[3])
    : 0;
  const videoStream = probedVideoStream;
  const audioStream = Array.isArray(probe?.streams)
    ? probe.streams.find((stream) => stream.codec_type === 'audio')
    : null;
  const duration = Number(probe?.format?.duration) || fallbackDuration;
  const hasVideo = Boolean(videoStream) || /Stream #.*Video:/i.test(output);
  const hasAudio = Boolean(audioStream) || /Stream #.*Audio:/i.test(output);
  const videoCodecMatch = output.match(/Stream #.*Video:\s*([^,\s(]+)/i);
  const pixelFormatMatch = output.match(
    /Stream #.*Video:\s*[^,]+,\s*([a-zA-Z0-9_]+)/i,
  );
  const audioCodecMatch = output.match(/Stream #.*Audio:\s*([^,\s(]+)/i);
  const resolutionMatch = output.match(
    /Stream #.*Video:.*?\b(\d{2,5})x(\d{2,5})\b/i,
  );
  if (!hasVideo || duration <= 0) {
    throw new Error('文件不是可处理的视频，或无法读取视频时长。');
  }
  const averageFrameRate = parsedFrameRate(videoStream?.avg_frame_rate);
  const nominalFrameRate = parsedFrameRate(videoStream?.r_frame_rate);
  const frameRate = averageFrameRate || nominalFrameRate || 30;
  return {
    duration,
    hasAudio,
    width:
      Number(videoStream?.width) ||
      (resolutionMatch ? Number(resolutionMatch[1]) : 0),
    height:
      Number(videoStream?.height) ||
      (resolutionMatch ? Number(resolutionMatch[2]) : 0),
    videoCodec: String(
      videoStream?.codec_name || videoCodecMatch?.[1] || '',
    ).toLowerCase(),
    pixelFormat: String(
      videoStream?.pix_fmt || pixelFormatMatch?.[1] || '',
    ).toLowerCase(),
    audioCodec: String(
      audioStream?.codec_name || audioCodecMatch?.[1] || '',
    ).toLowerCase(),
    frameRate: Number(frameRate.toFixed(6)),
    nominalFrameRate: Number((nominalFrameRate || frameRate).toFixed(6)),
    variableFrameRate:
      Boolean(averageFrameRate && nominalFrameRate) &&
      Math.abs(averageFrameRate - nominalFrameRate) > 0.01,
    timeBase: String(videoStream?.time_base || ''),
    frameCount: Number(videoStream?.nb_frames) || null,
  };
};

const runFfmpeg = (args) =>
  runProcess(
    FFMPEG_PATH,
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-threads',
      String(ENCODING_THREADS),
      '-filter_threads',
      '1',
      '-filter_complex_threads',
      '1',
      ...args.slice(0, -1),
      '-threads',
      String(ENCODING_THREADS),
      args.at(-1),
    ],
    { timeoutMs: 15 * 60 * 1000 },
  );

const videoFilter = (config, duration) =>
  [
    `trim=duration=${duration.toFixed(3)}`,
    'setpts=PTS-STARTPTS',
    `scale=${config.width}:${config.height}:force_original_aspect_ratio=decrease`,
    `pad=${config.width}:${config.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `fps=${config.fps}`,
    'format=yuv420p',
    'setsar=1',
  ].join(',');

const audioFilter = ({ duration, fadeIn, fadeOut }) => {
  const filters = [
    `atrim=duration=${duration.toFixed(3)}`,
    'asetpts=PTS-STARTPTS',
    'aresample=48000',
    'aformat=sample_fmts=fltp:channel_layouts=stereo',
  ];
  if (fadeIn > 0) {
    filters.push(`afade=t=in:st=0:d=${fadeIn.toFixed(3)}`);
  }
  if (fadeOut > 0) {
    filters.push(
      `afade=t=out:st=${Math.max(0, duration - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`,
    );
  }
  return filters.join(',');
};

const makeSegment = async ({
  inputPath,
  outputPath,
  startSeconds,
  durationSeconds,
  hasAudio,
  fadeInSeconds,
  fadeOutSeconds,
  config,
}) => {
  const args = ['-ss', startSeconds.toFixed(3), '-i', inputPath];
  const audioInput = hasAudio ? '[0:a:0]' : '[1:a:0]';
  if (!hasAudio) {
    args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
  }
  args.push(
    '-filter_complex',
    `[0:v:0]${videoFilter(config, durationSeconds)}[v];${audioInput}${audioFilter(
      {
        duration: durationSeconds,
        fadeIn: fadeInSeconds,
        fadeOut: fadeOutSeconds,
      },
    )}[a]`,
    '-map',
    '[v]',
    '-map',
    '[a]',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '21',
    '-profile:v',
    'high',
    '-level',
    '4.1',
    '-g',
    String(config.fps * 2),
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    '-shortest',
    outputPath,
  );
  await runFfmpeg(args);
};

const concatPath = (filePath) =>
  filePath.replace(/\\/g, '/').replace(/'/g, "'\\''");

const updateItemProgress = async (job, item, progress) => {
  item.progress = progress;
  const completedProgress = job.items.reduce(
    (sum, current) => sum + current.progress,
    0,
  );
  job.progress = Math.round(completedProgress / job.items.length);
  await saveJob(job);
};

const renderItem = async (job, item, hookProbe) => {
  item.status = 'processing';
  item.error = null;
  await updateItemProgress(job, item, 5);

  const sourceProbe = await inspectMedia(item.sourcePath);
  if (job.config.sourceStartSeconds >= sourceProbe.duration - 0.25) {
    throw new Error(
      `原成片总时长约${sourceProbe.duration.toFixed(1)}秒，接入点不能设为${job.config.sourceStartSeconds}秒。`,
    );
  }
  const hookDuration = Math.min(
    job.config.hookDurationSeconds,
    hookProbe.duration,
  );
  const bodyDuration = sourceProbe.duration - job.config.sourceStartSeconds;
  const fadeDuration = Math.min(
    job.config.fadeDurationSeconds,
    hookDuration / 2,
    bodyDuration / 2,
  );
  const itemTempDir = path.join(job.tempDir, item.id);
  await fs.mkdir(itemTempDir, { recursive: true });
  const hookSegment = path.join(itemTempDir, 'hook.mp4');
  const bodySegment = path.join(itemTempDir, 'body.mp4');
  const concatList = path.join(itemTempDir, 'concat.txt');
  const joinedPath = path.join(itemTempDir, 'joined.mp4');

  await makeSegment({
    inputPath: job.hookPath,
    outputPath: hookSegment,
    startSeconds: 0,
    durationSeconds: hookDuration,
    hasAudio: hookProbe.hasAudio,
    fadeInSeconds: 0,
    fadeOutSeconds: fadeDuration,
    config: job.config,
  });
  await updateItemProgress(job, item, 35);

  await makeSegment({
    inputPath: item.sourcePath,
    outputPath: bodySegment,
    startSeconds: job.config.sourceStartSeconds,
    durationSeconds: bodyDuration,
    hasAudio: sourceProbe.hasAudio,
    fadeInSeconds: fadeDuration,
    fadeOutSeconds: 0,
    config: job.config,
  });
  await updateItemProgress(job, item, 70);

  await fs.writeFile(
    concatList,
    `file '${concatPath(hookSegment)}'\nfile '${concatPath(bodySegment)}'\n`,
    'utf8',
  );
  await runFfmpeg([
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concatList,
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    joinedPath,
  ]);
  await updateItemProgress(job, item, 88);

  await runFfmpeg([
    '-i',
    joinedPath,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0',
    '-c:v',
    'copy',
    '-af',
    `loudnorm=I=${job.config.targetLoudnessLufs}:LRA=11:TP=-1.5`,
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    item.outputPath,
  ]);
  item.status = 'completed';
  item.progress = 100;
  item.error = null;
  await updateItemProgress(job, item, 100);
};

const processJob = async (jobId) => {
  const job = jobs.get(jobId);
  if (!job) return;
  activeJobId = jobId;
  job.status = 'processing';
  await saveJob(job);
  let hookProbe;
  try {
    hookProbe = await inspectMedia(job.hookPath);
  } catch (error) {
    job.status = 'failed';
    job.progress = 100;
    job.items.forEach((item) => {
      item.status = 'failed';
      item.progress = 100;
      item.error = `新开头无法处理：${error.message}`;
    });
    job.failedCount = job.items.length;
    await saveJob(job);
    activeJobId = null;
    return;
  }

  for (const item of job.items) {
    if (item.status === 'completed') continue;
    try {
      await renderItem(job, item, hookProbe);
    } catch (error) {
      item.status = 'failed';
      item.progress = 100;
      item.error = error instanceof Error ? error.message : String(error);
      await updateItemProgress(job, item, 100);
    } finally {
      await fs.rm(path.join(job.tempDir, item.id), {
        recursive: true,
        force: true,
      });
    }
  }
  job.completedCount = job.items.filter(
    (item) => item.status === 'completed',
  ).length;
  job.failedCount = job.items.filter((item) => item.status === 'failed').length;
  job.progress = 100;
  job.status =
    job.completedCount === job.items.length
      ? 'completed'
      : job.completedCount > 0
        ? 'partial'
        : 'failed';
  await saveJob(job);
  activeJobId = null;
};

const drainQueue = async () => {
  if (queueRunning) return;
  queueRunning = true;
  try {
    while (queue.length > 0) {
      const jobId = queue.shift();
      await processJob(jobId);
    }
  } finally {
    queueRunning = false;
  }
};

const enqueueJob = (jobId) => {
  if (!queue.includes(jobId) && activeJobId !== jobId) {
    queue.push(jobId);
  }
  void drainQueue();
};

const parseMultipartJob = async (req) => {
  const jobId = randomUUID();
  const jobDir = path.join(JOBS_DIR, jobId);
  const uploadDir = path.join(jobDir, 'uploads');
  const outputDir = path.join(jobDir, 'outputs');
  const tempDir = path.join(jobDir, 'temp');
  await Promise.all([
    fs.mkdir(uploadDir, { recursive: true }),
    fs.mkdir(outputDir, { recursive: true }),
    fs.mkdir(tempDir, { recursive: true }),
  ]);

  const fields = {};
  const storedFiles = [];
  const writeTasks = [];
  let uploadError = null;
  let sourceIndex = 0;

  const busboy = Busboy({
    headers: req.headers,
    defParamCharset: 'utf8',
    limits: {
      files: MAX_SOURCES + 1,
      fileSize: MAX_FILE_BYTES,
      fields: 12,
    },
  });

  busboy.on('field', (name, value) => {
    fields[name] = value;
  });
  busboy.on('file', (fieldName, file, info) => {
    if (!['hook', 'sources'].includes(fieldName)) {
      file.resume();
      return;
    }
    const originalName = safeFileName(info.filename);
    const index = fieldName === 'hook' ? 0 : sourceIndex++;
    const storedName = `${fieldName}-${String(index).padStart(2, '0')}-${originalName}`;
    const storedPath = path.join(uploadDir, storedName);
    const writeStream = createWriteStream(storedPath, { flags: 'wx' });
    file.on('limit', () => {
      uploadError = `文件“${originalName}”超过单文件大小限制。`;
    });
    const task = new Promise((resolve, reject) => {
      file.on('error', reject);
      writeStream.on('error', reject);
      writeStream.on('finish', resolve);
    });
    // A failed/cancelled writer may reject before busboy emits finish. Keep
    // that rejection observed and abort the parser so the request can settle.
    task.catch((error) => {
      uploadError ||= error.message;
      busboy.destroy(error);
    });
    writeTasks.push(task);
    storedFiles.push({ fieldName, originalName, storedPath });
    file.pipe(writeStream);
  });

  await new Promise((resolve, reject) => {
    busboy.on('error', reject);
    busboy.on('finish', resolve);
    req.pipe(busboy);
  });
  await Promise.all(writeTasks);
  if (uploadError) throw new Error(uploadError);

  const hook = storedFiles.find((file) => file.fieldName === 'hook');
  const sources = storedFiles.filter((file) => file.fieldName === 'sources');
  if (!hook) throw new Error('请上传一个新开头视频。');
  if (sources.length === 0) throw new Error('请至少上传一条原成片。');
  if (sources.length > MAX_SOURCES) {
    throw new Error(`单次最多处理${MAX_SOURCES}条原成片。`);
  }

  const createdAt = nowIso();
  const config = {
    hookDurationSeconds: parseNumber(fields.hookDurationSeconds, 5, 0.5, 60),
    sourceStartSeconds: parseNumber(fields.sourceStartSeconds, 5, 0, 120),
    fadeDurationSeconds: parseNumber(fields.fadeDurationSeconds, 0.2, 0, 2),
    targetLoudnessLufs: parseNumber(fields.targetLoudnessLufs, -16, -24, -10),
    width: 1080,
    height: 1920,
    fps: 30,
  };
  const job = {
    id: jobId,
    mode: 'batch-hook',
    status: 'queued',
    progress: 0,
    hookName: hook.originalName,
    hookPath: hook.storedPath,
    sourceCount: sources.length,
    completedCount: 0,
    failedCount: 0,
    createdAt,
    updatedAt: createdAt,
    config,
    tempDir,
    outputDir,
    items: sources.map((source, index) => ({
      id: randomUUID(),
      sourceName: source.originalName,
      sourcePath: source.storedPath,
      outputName: outputNameFor(source.originalName, index),
      outputPath: path.join(
        outputDir,
        outputNameFor(source.originalName, index),
      ),
      status: 'queued',
      progress: 0,
      error: null,
      reviewStatus: 'pending',
      reviewNote: '',
      reviewedAt: null,
    })),
  };
  jobs.set(job.id, job);
  await saveJob(job);
  enqueueJob(job.id);
  return job;
};

const readJsonBody = async (req) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) throw new Error('请求内容过大。');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const clipRemixService = createClipRemixService({
  readOnly: READ_ONLY_PREVIEW || MIGRATION_VALIDATION_MODE,
  trustedAsrResolver: createAsrEvidenceResolver(path.join(DATA_DIR, 'clip-remix', 'asr-evidence')),
  allowPrivateUploads: process.env.PRIVATE_UPLOADS_ENABLED === 'true',
  privateUploadAllowedUsers: process.env.PRIVATE_UPLOAD_ALLOWED_USERS || '',
  privateUploadAccessMode: process.env.PRIVATE_UPLOAD_ACCESS_MODE || 'allowlist',
  dataDir: DATA_DIR,
  maxFileBytes: MAX_FILE_BYTES,
  inspectMedia,
  makeSegment,
  runFfmpeg,
  runProcess,
  ffmpegPath: FFMPEG_PATH,
  readJsonBody,
  nowIso,
  jsonResponse,
  materialCenter: materialCenterClient,
  cutter: cutterClient,
  autoRemixAdminUsers: process.env.AUTO_REMIX_ADMIN_USERS,
  tesseractPath: TESSERACT_PATH,
  cjkFontFile: CJK_FONT_FILE,
});

const loadPersistedJobs = async () => {
  await fs.mkdir(JOBS_DIR, { recursive: true });
  const entries = await fs.readdir(JOBS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
    try {
      const raw = await fs.readFile(jobFilePath(entry.name), 'utf8');
      const job = JSON.parse(raw);
      if (['processing', 'queued'].includes(job.status)) {
        job.status = 'queued';
        job.items.forEach((item) => {
          if (item.status === 'processing') {
            item.status = 'queued';
            item.progress = 0;
          }
        });
        await saveJob(job);
      }
      jobs.set(job.id, job);
      if (job.status === 'queued') queue.push(job.id);
    } catch (error) {
      console.error(`跳过无法读取的任务目录 ${entry.name}:`, error);
    }
  }
};

const cleanupExpiredJobs = async () => {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const terminalStatuses = new Set(['completed', 'partial', 'failed']);
  for (const [jobId, job] of jobs) {
    if (!terminalStatuses.has(job.status)) continue;
    const updatedAt = Date.parse(job.updatedAt);
    if (!Number.isFinite(updatedAt) || updatedAt >= cutoff) continue;
    await fs.rm(path.join(JOBS_DIR, jobId), { recursive: true, force: true });
    jobs.delete(jobId);
  }
};

const routeRequest = async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(
    req.url || '/',
    `http://${req.headers.host || 'localhost'}`,
  );

  if (MIGRATION_VALIDATION_MODE) {
    if (req.method === 'GET' && url.pathname === '/health') {
      jsonResponse(res, 200, { ok: true, mode: 'migration_validation', readyForBusiness: false });
      return;
    }
    jsonResponse(res, 423, { ok: false, code: 'migration_validation_read_only' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    jsonResponse(res, 200, {
      ok: true,
      workerId: WORKER_ID,
      version: WORKER_VERSION,
      mode: READ_ONLY_PREVIEW ? 'read_only_preview' : 'production',
      readyForBusiness: !READ_ONLY_PREVIEW,
      ffmpegAvailable: true,
      queueLength: queue.length,
      activeJobId,
      resourceGovernance: {
        processMaxConcurrency: PROCESS_MAX_CONCURRENCY,
        effectiveCpuCapacity: EFFECTIVE_CPU_CAPACITY,
        cpuProcessGovernor: cpuGovernor.snapshot(),
        encodingThreads: ENCODING_THREADS,
        activeProcessCount,
        queuedProcessCount: processWaiters.length,
        ocrProcessMaxConcurrency: OCR_PROCESS_MAX_CONCURRENCY,
        activeOcrProcessCount,
        queuedOcrProcessCount: ocrProcessWaiters.length,
        ...clipRemixService.runtimeState(),
      },
      authRequired: AUTH_REQUIRED,
      stableAppConfigured: stableAppService.configured,
      stableAccessAuthorityConfigured:
        stableAppService.accessAuthorityConfigured,
      stablePasswordLoginConfigured: stableAppService.passwordLoginConfigured,
      jobCount: jobs.size,
      retentionDays: RETENTION_DAYS,
      capabilities: {
        batchHook: true,
        clipRemix: true,
        cutterRecognition: cutterClient.configured,
        localSubtitleOcr: Boolean(TESSERACT_PATH),
        materialCenterBidirectional: materialCenterClient.configured,
        persistentJobs: true,
        persistentManualOperations: true,
        privateUploads: process.env.PRIVATE_UPLOADS_ENABLED === 'true',
        audioFade: true,
        loudnessNormalization: true,
        libtvGeneration: false,
      },
    });
    return;
  }

  if (await stableAppService.route(req, res, url)) {
    return;
  }

  let hubIdentity = null;
  if (HUB_INTEGRATED_MODE && !url.pathname.startsWith('/api/integrations/material-center/')) {
    try { hubIdentity = await stableAppService.authorizeRequest(req); }
    catch (error) {
      jsonResponse(res, error.statusCode || 503, { code: 'HUB_SESSION_REQUIRED', message: error.message });
      return;
    }
  }
  if (READ_ONLY_PREVIEW && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    jsonResponse(res, 423, { code: 'migration_preview_read_only', message: '迁移核对中，原业务记录保持不变。' });
    return;
  }

  const materialCenterIntegrationRequest = url.pathname.startsWith(
    '/api/integrations/material-center/',
  );
  const accessContext = materialCenterIntegrationRequest
    ? safeSecretEqual(
        req.headers['x-wis-workstation-token'],
        MATERIAL_CENTER_INTEGRATION_TOKEN,
      )
      ? {
          sub: 'SERVICE-WIS-MATERIAL-CENTER',
          name: '云管家有效一创同步',
          service: true,
        }
      : null
    : url.pathname.startsWith('/api/')
      ? verifyAccessToken(tokenFromRequest(req, url))
      : null;
  if (url.pathname.startsWith('/api/') && !accessContext) {
    jsonResponse(res, 401, {
      message: '渲染访问凭证无效或已过期，请刷新页面后重试。',
    });
    return;
  }
  if (hubIdentity && accessContext && hubIdentity.id !== accessContext.sub) {
    jsonResponse(res, 403, { message: '工作台身份与中枢当前登录不一致，请重新进入二创。' });
    return;
  }

  if (await clipRemixService.route(req, res, url, accessContext)) {
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/jobs/batch-hook') {
    try {
      const job = await parseMultipartJob(req);
      jsonResponse(res, 202, publicJob(job));
    } catch (error) {
      jsonResponse(res, 400, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (req.method === 'GET' && jobMatch) {
    const job = jobs.get(decodeURIComponent(jobMatch[1]));
    if (!job) {
      jsonResponse(res, 404, { message: '没有找到该渲染任务。' });
      return;
    }
    jsonResponse(res, 200, publicJob(job));
    return;
  }

  const retryMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/retry$/);
  if (req.method === 'POST' && retryMatch) {
    const job = jobs.get(decodeURIComponent(retryMatch[1]));
    if (!job) {
      jsonResponse(res, 404, { message: '没有找到该渲染任务。' });
      return;
    }
    job.items.forEach((item) => {
      if (item.status === 'failed') {
        item.status = 'queued';
        item.progress = 0;
        item.error = null;
      }
    });
    job.status = 'queued';
    job.progress = Math.round(
      job.items.reduce((sum, item) => sum + item.progress, 0) /
        job.items.length,
    );
    job.failedCount = 0;
    await saveJob(job);
    enqueueJob(job.id);
    jsonResponse(res, 202, publicJob(job));
    return;
  }

  const reviewMatch = url.pathname.match(
    /^\/api\/jobs\/([^/]+)\/items\/([^/]+)\/review$/,
  );
  if (req.method === 'POST' && reviewMatch) {
    const job = jobs.get(decodeURIComponent(reviewMatch[1]));
    const item = job?.items.find(
      (current) => current.id === decodeURIComponent(reviewMatch[2]),
    );
    if (!job || !item) {
      jsonResponse(res, 404, { message: '没有找到该审核项。' });
      return;
    }
    try {
      const body = await readJsonBody(req);
      if (
        !['pending', 'approved', 'changes_requested'].includes(
          body.reviewStatus,
        )
      ) {
        throw new Error('审核状态无效。');
      }
      item.reviewStatus = body.reviewStatus;
      item.reviewNote = String(body.reviewNote || '').slice(0, 500);
      item.reviewedAt = nowIso();
      await saveJob(job);
      jsonResponse(res, 200, publicJob(job));
    } catch (error) {
      jsonResponse(res, 400, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  const outputMatch = url.pathname.match(
    /^\/api\/jobs\/([^/]+)\/output\/([^/]+)$/,
  );
  if (req.method === 'GET' && outputMatch) {
    const job = jobs.get(decodeURIComponent(outputMatch[1]));
    const item = job?.items.find(
      (current) => current.id === decodeURIComponent(outputMatch[2]),
    );
    if (!job || !item || item.status !== 'completed') {
      jsonResponse(res, 404, { message: '成片尚未生成或已不存在。' });
      return;
    }
    const isPreview = url.searchParams.get('preview') === '1';
    if (!isPreview && item.reviewStatus !== 'approved') {
      jsonResponse(res, 403, { message: '成片审核通过后才能正式下载。' });
      return;
    }
    try {
      const stat = await fs.stat(item.outputPath);
      const range = req.headers.range;
      const disposition = isPreview ? 'inline' : 'attachment';
      const commonHeaders = {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(item.outputName)}`,
      };
      if (range) {
        const match = String(range).match(/^bytes=(\d*)-(\d*)$/);
        const start = match?.[1] ? Number(match[1]) : 0;
        const end = match?.[2]
          ? Math.min(Number(match[2]), stat.size - 1)
          : stat.size - 1;
        if (
          !match ||
          !Number.isFinite(start) ||
          start > end ||
          start >= stat.size
        ) {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
          res.end();
          return;
        }
        res.writeHead(206, {
          ...commonHeaders,
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        });
        await pipeFileToResponse(req, res, item.outputPath, { start, end });
        return;
      }
      res.writeHead(200, {
        ...commonHeaders,
        'Content-Length': stat.size,
      });
      await pipeFileToResponse(req, res, item.outputPath);
    } catch {
      jsonResponse(res, 404, { message: '成片文件不存在，请重试任务。' });
    }
    return;
  }

  jsonResponse(res, 404, { message: '接口不存在。' });
};

if (!MIGRATION_VALIDATION_MODE && !READ_ONLY_PREVIEW) {
  await clipRemixService.initialize();
  await loadPersistedJobs();
  await cleanupExpiredJobs();
}

const server = http.createServer((req, res) => {
  void routeRequest(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) {
      jsonResponse(res, 500, { message: '渲染服务发生内部错误。' });
    } else {
      res.destroy();
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(
    `WIS render worker ${WORKER_VERSION} listening on http://${HOST}:${PORT}`,
  );
  if (!MIGRATION_VALIDATION_MODE && !READ_ONLY_PREVIEW) void drainQueue();
});

const cleanupTimer = MIGRATION_VALIDATION_MODE || READ_ONLY_PREVIEW ? null : setInterval(
  () =>
    void cleanupExpiredJobs().catch((error) =>
      console.error('任务清理失败：', error),
    ),
  CLEANUP_INTERVAL_HOURS * 60 * 60 * 1000,
);
cleanupTimer?.unref();
