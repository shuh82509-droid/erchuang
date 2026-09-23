import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { USAGE_DISCLAIMER_BOTTOM_MARGIN } from '../clip-remix-service.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(__dirname, '..');
const artifactsDir = path.join(
  workerRoot,
  'artifacts',
  `clip-remix-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);
const fixturesDir = path.join(artifactsDir, 'fixtures');
const workerDataDir = path.join(artifactsDir, 'worker-data');
const port = 8804;
const materialCenterPort = 8805;
const cutterPort = 8806;
const baseUrl = `http://127.0.0.1:${port}`;
const fixtureTls = { key: await fs.readFile(process.env.SMOKE_TLS_KEY), cert: await fs.readFile(process.env.SMOKE_TLS_CERT) };
const materialCenterBaseUrl = `https://127.0.0.1:${materialCenterPort}/api/workstation`;
const cutterBaseUrl = `http://127.0.0.1:${cutterPort}`;
const materialCenterToken = 'local-material-center-smoke-token-20260817';
const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';

if (USAGE_DISCLAIMER_BOTTOM_MARGIN !== 240) {
  throw new Error('警示语没有保持在播放器控件上方的安全区。');
}

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

const runText = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `命令退出码 ${code}`));
    });
  });

const probeMedia = (filePath) =>
  new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-i', filePath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        output = (output + chunk.toString()).slice(-12000);
      });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && code !== 1) {
        reject(new Error(output || `媒体探测退出码 ${code}`));
        return;
      }
      const resolution = output.match(
        /Stream #.*Video:.*?\b(\d{2,5})x(\d{2,5})\b/i,
      );
      const codec = output.match(/Stream #.*Video:\s*([^,\s(]+)/i);
      const pixelFormat = output.match(
        /Stream #.*Video:\s*[^,]+,\s*([a-zA-Z0-9_]+)/i,
      );
      resolve({
        width: Number(resolution?.[1] || 0),
        height: Number(resolution?.[2] || 0),
        codec: String(codec?.[1] || ''),
        pixelFormat: String(pixelFormat?.[1] || ''),
      });
    });
  });

const probeDimensions = async (filePath) => {
  const stream = await probeMedia(filePath);
  return { width: stream.width, height: stream.height };
};

const probeCodec = async (filePath) => {
  const stream = await probeMedia(filePath);
  return {
    codec: stream.codec,
    pixelFormat: stream.pixelFormat,
  };
};

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const request = async (pathName, init) => {
  const response = await fetch(`${baseUrl}${pathName}`, init);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `请求失败 ${response.status}：${payload?.message || JSON.stringify(payload)}`,
    );
  }
  return payload;
};

const readJsonBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
};

await Promise.all([
  fs.mkdir(fixturesDir, { recursive: true }),
  fs.mkdir(workerDataDir, { recursive: true }),
]);

const sourcePath = path.join(fixturesDir, '历史母版.mp4');
await run(ffmpegPath, [
  '-y',
  '-f',
  'lavfi',
  '-i',
  'testsrc2=s=540x960:d=8:r=25',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:duration=8',
  '-shortest',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  sourcePath,
]);

const sourceStat = await fs.stat(sourcePath);
const longSourcePath = path.join(fixturesDir, '长有效一创.mp4');
await run(ffmpegPath, [
  '-y',
  '-f',
  'lavfi',
  '-i',
  'testsrc2=s=360x640:d=24:r=20',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=520:duration=24',
  '-shortest',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  longSourcePath,
]);
const longSourceStat = await fs.stat(longSourcePath);
const incompatibleSourcePath = path.join(fixturesDir, '非浏览器原片.avi');
await run(ffmpegPath, [
  '-y',
  '-f',
  'lavfi',
  '-i',
  'testsrc2=s=360x640:d=3:r=20',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=330:duration=3',
  '-shortest',
  '-c:v',
  'mpeg4',
  '-c:a',
  'mp3',
  incompatibleSourcePath,
]);
const returnedUploads = new Map();
const returnRecords = new Map();
const qianchuanRecords = new Map();
let returnUploadCount = 0;
let automaticSourceTimeoutRequests = 0;
let clipReplenishmentListFailuresRemaining = 0;
const materialAsset = {
  id: 7101,
  filename: '素材中心真实原片.mp4',
  object_key: 'uploads/source/7101.mp4',
  size: sourceStat.size,
  modified_at: '2026-08-17T10:00:00Z',
  category: '隐形水润面膜',
  content_type: '产品展示',
  asset_subtype: '历史有效素材',
  library_type: 'source',
  folder_name: '水润面膜/有效原片',
  tags: ['真实素材', '验收'],
  cover_url: `https://127.0.0.1:${materialCenterPort}/cover/7101.jpg`,
  preview_url: `https://127.0.0.1:${materialCenterPort}/download/7101`,
  download_url: `https://127.0.0.1:${materialCenterPort}/download/7101`,
  uploaded_by_name: '素材中心测试用户',
  source: 'wis_marketing_asset_center',
  reference_url: '',
  effective: true,
  effective_marked_at: '2026-08-17T09:58:00Z',
  effective_marked_by_name: '素材中心审核同事',
};
const materialRemixAsset = {
  ...materialAsset,
  id: 7102,
  filename: '素材中心混剪成片.mp4',
  category: '晶润眼膜',
  object_key: 'uploads/remix/7102.mp4',
  asset_subtype: 'AI混剪成片',
  library_type: 'remix',
  folder_name: '晶润紧致眼膜/混剪成片',
  cover_url: `https://127.0.0.1:${materialCenterPort}/cover/7102.jpg`,
  preview_url: `https://127.0.0.1:${materialCenterPort}/download/7102`,
  download_url: `https://127.0.0.1:${materialCenterPort}/download/7102`,
  effective: false,
  effective_marked_at: null,
  effective_marked_by_name: '',
};
const automaticSourceAsset = {
  ...materialAsset,
  id: 7103,
  filename: '自动选源待拆解-隐形水润面膜.mp4',
  object_key: 'uploads/source/7103.mp4',
  modified_at: '2026-08-24T06:00:00Z',
  folder_name: '水润面膜/待自动拆解',
  tags: ['真实素材', '自动选源验收'],
  cover_url: `https://127.0.0.1:${materialCenterPort}/cover/7103.jpg`,
  preview_url: `https://127.0.0.1:${materialCenterPort}/download/7103`,
  download_url: `https://127.0.0.1:${materialCenterPort}/download/7103`,
  effective: false,
  effective_marked_at: null,
  effective_marked_by_name: '',
};
const recursiveAutoRemixSourceAsset = {
  ...automaticSourceAsset,
  id: 7105,
  filename: '自动混剪-回传成片-不应再次拆解.mp4',
  object_key: 'uploads/source/7105.mp4',
  modified_at: '2026-08-25T06:00:00Z',
  tags: ['自动混剪', '回传成片'],
  cover_url: `https://127.0.0.1:${materialCenterPort}/cover/7105.jpg`,
  preview_url: `https://127.0.0.1:${materialCenterPort}/download/7105`,
  download_url: `https://127.0.0.1:${materialCenterPort}/download/7105`,
};
const historicalSourceAsset = {
  ...automaticSourceAsset,
  id: 7106,
  filename: '历史第六页-隐形水润面膜-待拆解.mp4',
  object_key: 'uploads/source/7106.mp4',
  modified_at: '2025-01-01T06:00:00Z',
  tags: ['历史素材', '自动补库验收'],
  cover_url: `https://127.0.0.1:${materialCenterPort}/cover/7106.jpg`,
  preview_url: `https://127.0.0.1:${materialCenterPort}/download/7106`,
  download_url: `https://127.0.0.1:${materialCenterPort}/download/7106`,
};
const historicalRecursiveFillers = Array.from({ length: 500 }, (_, index) => ({
  ...recursiveAutoRemixSourceAsset,
  id: 8000 + index,
  filename: `自动混剪-历史占位-${index + 1}.mp4`,
  object_key: `uploads/source/history-placeholder-${index + 1}.mp4`,
  modified_at: `2025-02-${String((index % 28) + 1).padStart(2, '0')}T06:00:00Z`,
}));
const longEffectiveAsset = {
  ...materialAsset,
  id: 7104,
  filename: '超过20秒的完整有效一创.mp4',
  object_key: 'uploads/source/7104.mp4',
  size: longSourceStat.size,
  category: '颈膜',
  folder_name: '颈膜/有效一创',
  preview_url: `https://127.0.0.1:${materialCenterPort}/download/7104`,
  download_url: `https://127.0.0.1:${materialCenterPort}/download/7104`,
};

const returnPayload = (record) => ({
  idempotency_key: record.idempotency_key,
  status: record.status,
  asset_id: record.asset_id ?? null,
  asset_available: record.status === 'completed',
  asset: record.asset || null,
  filename: record.filename,
  object_key: record.object_key,
  sha256: record.sha256,
  provenance: record.provenance,
  error_message: '',
  created_at: record.created_at,
  updated_at: record.updated_at,
  completed_at: record.completed_at || null,
});

const materialCenterServer = https.createServer(fixtureTls, async (req, res) => {
  try {
    const url = new URL(
      req.url || '/',
      `https://127.0.0.1:${materialCenterPort}`,
    );
    if (url.pathname.startsWith('/api/workstation/')) {
      if (req.headers['x-wis-workstation-token'] !== materialCenterToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'invalid token' }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/workstation/assets') {
        const libraryType = url.searchParams.get('library_type') || 'source';
        const category = url.searchParams.get('category') || '';
        const folderName = url.searchParams.get('folder_name') || '';
        const effectiveOnly = url.searchParams.get('effective_only') === 'true';
        const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
        const pageSize = Math.max(
          1,
          Number(url.searchParams.get('page_size')) || 20,
        );
        if (
          category === '隐形水润面膜' &&
          pageSize === 100 &&
          clipReplenishmentListFailuresRemaining > 0
        ) {
          clipReplenishmentListFailuresRemaining -= 1;
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ detail: 'temporary upstream failure' }));
          return;
        }
        if (
          libraryType === 'source' &&
          category === '隐形水润面膜' &&
          !effectiveOnly &&
          pageSize === 100 &&
          automaticSourceTimeoutRequests < 3
        ) {
          automaticSourceTimeoutRequests += 1;
          await wait(450);
        }
        const allItems = [
          materialRemixAsset,
          materialAsset,
          automaticSourceAsset,
          recursiveAutoRemixSourceAsset,
          ...historicalRecursiveFillers,
          historicalSourceAsset,
        ];
        const libraryItems =
          libraryType === 'all'
            ? allItems
            : allItems.filter((asset) => asset.library_type === libraryType);
        const filteredItems = libraryItems.filter(
          (asset) =>
            (!category || asset.category === category) &&
            (!folderName || asset.folder_name === folderName) &&
            (!effectiveOnly || asset.effective === true),
        );
        const folderCounts = new Map();
        for (const asset of libraryItems) {
          if (asset.folder_name) {
            folderCounts.set(
              asset.folder_name,
              (folderCounts.get(asset.folder_name) || 0) + 1,
            );
          }
        }
        const offset = (page - 1) * pageSize;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            items: filteredItems.slice(offset, offset + pageSize),
            total: filteredItems.length,
            page,
            page_size: pageSize,
            library_type: libraryType,
            source: 'wis_marketing_asset_center',
            source_updated_at: '2026-08-17T10:00:00Z',
            filters: {
              folders: [...folderCounts].map(([value, count]) => ({
                value,
                label: value,
                count,
              })),
            },
          }),
        );
        return;
      }
      if (
        req.method === 'GET' &&
        [
          '/api/workstation/assets/7101',
          '/api/workstation/assets/7102',
          '/api/workstation/assets/7103',
          '/api/workstation/assets/7104',
          '/api/workstation/assets/7106',
        ].includes(url.pathname)
      ) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify(
            url.pathname.endsWith('/7102')
              ? materialRemixAsset
              : url.pathname.endsWith('/7104')
                ? longEffectiveAsset
                : url.pathname.endsWith('/7106')
                  ? historicalSourceAsset
                  : url.pathname.endsWith('/7103')
                    ? automaticSourceAsset
                    : materialAsset,
          ),
        );
        return;
      }
      if (
        req.method === 'GET' &&
        url.pathname === '/api/workstation/qianchuan/accounts'
      ) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            items: [
              {
                id: '1869672250595328',
                name: '营销部WIS-厚拓（爱创）-2',
                authorized: true,
                authorization_status: 'authorized',
              },
            ],
            total: 1,
            source: 'qianchuan live account directory',
            source_read_at: '2026-09-01T00:00:00Z',
          }),
        );
        return;
      }
      if (
        req.method === 'GET' &&
        url.pathname === '/api/workstation/qianchuan/product-plan-map'
      ) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            source: {
              title: 'WIS千川在用账户',
              url: 'https://example.test/qianchuan-map',
              document_id: 'test-map-document',
              revision: 536,
              verified_at: '2026-09-03T14:03:28+08:00',
            },
            items: [
              {
                key: 'black_crystal_mask',
                label: '黑晶光蕴面膜',
                aliases: ['黑晶面膜', '黑晶'],
                rules: [
                  {
                    advertiser_id: '1869672250595328',
                    advertiser_name: '营销部WIS-厚拓（爱创）-2',
                    scope: 'multiplication',
                    match_mode: 'exact_plan',
                    keyword: '',
                    plan_id: '1870289794646204',
                  },
                ],
              },
            ],
          }),
        );
        return;
      }
      if (
        req.method === 'GET' &&
        url.pathname === '/api/workstation/qianchuan/plans'
      ) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            items: [
              {
                id: '1870289794646204',
                name: '直播全域投放计划',
                advertiser_id: '1869672250595328',
                plan_type: 'multiplication',
                plan_type_label: '乘方计划',
                status: 'DELIVERY_OK',
                status_label: '投放中',
                can_attach_video: true,
                is_full: false,
              },
              {
                id: '1870289794646205',
                name: '商品标准推广计划',
                advertiser_id: '1869672250595328',
                plan_type: 'standard',
                plan_type_label: '标准推广',
                status: 'ENABLE',
                status_label: '启用',
                can_attach_video: true,
                is_full: false,
              },
            ],
            total: 2,
            warnings: [],
            source: 'qianchuan live plan directory',
            source_read_at: '2026-09-01T00:00:00Z',
          }),
        );
        return;
      }
      if (
        req.method === 'GET' &&
        url.pathname === '/api/workstation/qianchuan/targets/verify'
      ) {
        const requestedPlanId = url.searchParams.get('plan_id');
        const requestedPlanType = url.searchParams.get('plan_type');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            verified: true,
            authorized: true,
            account: {
              id: '1869672250595328',
              name: '营销部WIS-厚拓（爱创）-2',
            },
            plan: {
              id: requestedPlanId,
              name:
                requestedPlanId === '1870289794646205'
                  ? '商品标准推广计划'
                  : '直播全域投放计划',
              plan_type: requestedPlanType,
              status: 'DELIVERY_OK',
              status_label: '投放中',
              marketing_goal: 'LIVE_PROM_GOODS',
              can_attach_video: true,
            },
            verified_at: '2026-09-01T00:00:00Z',
            source: 'qianchuan live account directory and plan resolution',
          }),
        );
        return;
      }
      if (
        req.method === 'POST' &&
        url.pathname === '/api/workstation/qianchuan/push'
      ) {
        const payload = await readJsonBody(req);
        if (
          payload.enabled !== true ||
          payload.confirmed !== true ||
          !payload.daily_spend_guard_yuan ||
          payload.product_category !== 'WIS隐形水润面膜'
        ) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ detail: 'safety gate rejected' }));
          return;
        }
        if (
          qianchuanRecords.size >= payload.daily_material_limit &&
          !qianchuanRecords.has(payload.idempotency_key)
        ) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ detail: '今日自动混剪投放数量上限' }));
          return;
        }
        let task = qianchuanRecords.get(payload.idempotency_key);
        if (!task) {
          task = {
            id: `qianchuan-${qianchuanRecords.size + 1}`,
            asset_id: payload.asset_id,
            asset_name: '自动混剪-WIS隐形水润面膜.mp4',
            advertiser_id: payload.target.advertiser_id,
            advertiser_name: '营销部WIS-厚拓（爱创）-2',
            plan_id: payload.target.plan_id,
            plan_name: '2026-07-10_直播全域投放_09:35:45',
            plan_type: payload.target.plan_type,
            platform_asset_id: 'real-video-1',
            idempotency_key: payload.idempotency_key,
            status: 'success',
            message: '千川真实计划已添加视频',
            metrics: { stat_cost: 20, pay_order_amount: 60 },
            metrics_link_status: 'verified',
            metrics_data_status: 'fresh',
            metrics_fresh_through: '2026-08-31',
            metrics_coverage: { completed: 1, expected: 1 },
            created_at: '2026-09-01T00:00:00Z',
            updated_at: '2026-09-01T00:01:00Z',
          };
          qianchuanRecords.set(payload.idempotency_key, task);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'queued', task }));
        return;
      }
      if (
        req.method === 'GET' &&
        url.pathname.startsWith('/api/workstation/qianchuan/deliveries/')
      ) {
        const key = decodeURIComponent(
          url.pathname.slice('/api/workstation/qianchuan/deliveries/'.length),
        );
        const task = qianchuanRecords.get(key);
        res.writeHead(task ? 200 : 404, {
          'Content-Type': 'application/json',
        });
        res.end(
          JSON.stringify(
            task ? { status: 'found', task } : { detail: 'missing' },
          ),
        );
        return;
      }
      if (
        req.method === 'POST' &&
        url.pathname === '/api/workstation/returns/presign'
      ) {
        const payload = await readJsonBody(req);
        let record = returnRecords.get(payload.idempotency_key);
        if (!record) {
          const timestamp = '2026-08-17T10:05:00Z';
          record = {
            ...payload,
            status: 'pending',
            object_key: `uploads/remix/${encodeURIComponent(payload.idempotency_key)}.mp4`,
            asset_id: null,
            provenance: {
              source_asset_ids: payload.source_asset_ids,
              source_clip_ids: payload.source_clip_ids,
              framework_id: payload.framework_id,
              maker_id: payload.maker_id,
              review_status: payload.review_status,
            },
            created_at: timestamp,
            updated_at: timestamp,
            completed_at: null,
          };
          returnRecords.set(payload.idempotency_key, record);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ...returnPayload(record),
            upload_required: record.status !== 'completed',
            upload_url: `https://127.0.0.1:${materialCenterPort}/upload/${encodeURIComponent(payload.idempotency_key)}`,
            headers: { 'Content-Type': 'video/mp4' },
            expires_in: 900,
          }),
        );
        return;
      }
      if (
        req.method === 'POST' &&
        url.pathname === '/api/workstation/returns/complete'
      ) {
        const payload = await readJsonBody(req);
        const record = returnRecords.get(payload.idempotency_key);
        if (!record || !returnedUploads.has(payload.idempotency_key)) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ detail: 'upload missing' }));
          return;
        }
        record.status = 'completed';
        record.asset_id = 9101;
        record.completed_at = '2026-08-17T10:06:00Z';
        record.updated_at = record.completed_at;
        record.asset = {
          ...materialAsset,
          id: record.asset_id,
          filename: record.filename,
          object_key: record.object_key,
          size: returnedUploads.get(payload.idempotency_key).length,
          category: '隐形水润面膜',
          asset_subtype: 'AI混剪成片',
          source: 'wis_remix_workstation',
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(returnPayload(record)));
        return;
      }
      if (
        req.method === 'GET' &&
        url.pathname.startsWith('/api/workstation/returns/')
      ) {
        const key = decodeURIComponent(
          url.pathname.slice('/api/workstation/returns/'.length),
        );
        const record = returnRecords.get(key);
        res.writeHead(record ? 200 : 404, {
          'Content-Type': 'application/json',
        });
        res.end(
          JSON.stringify(
            record ? returnPayload(record) : { detail: 'missing' },
          ),
        );
        return;
      }
    }
    if (
      req.method === 'GET' &&
      [
        '/download/7101',
        '/download/7102',
        '/download/7103',
        '/download/7106',
      ].includes(url.pathname)
    ) {
      const file = await fs.readFile(sourcePath);
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': String(file.length),
      });
      res.end(file);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/download/7104') {
      const file = await fs.readFile(longSourcePath);
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': String(file.length),
      });
      res.end(file);
      return;
    }
    if (req.method === 'PUT' && url.pathname.startsWith('/upload/')) {
      const key = decodeURIComponent(url.pathname.slice('/upload/'.length));
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      returnedUploads.set(key, Buffer.concat(chunks));
      returnUploadCount += 1;
      res.writeHead(200);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: String(error) }));
  }
});
await new Promise((resolve, reject) => {
  materialCenterServer.once('error', reject);
  materialCenterServer.listen(materialCenterPort, '127.0.0.1', resolve);
});

let cutterTaskChecks = 0;
let cutterSubmitted = false;
let cutterAssetId = 7101;
const cutterResults = [
  {
    id: 1,
    time_range: '00:00.000-00:02.000',
    script_text: '真实识别第一段文案。',
    scene_description: '竖版人物口播',
    scene_text: '产品场景',
    camera_angle: '平视',
    shot_size: '中景',
    camera_movement: '固定',
  },
  {
    id: 2,
    time_range: '00:02.000-00:04.000',
    script_text: '真实识别第二段文案。',
    scene_description: '人物继续讲解',
    scene_text: '使用说明',
    camera_angle: '平视',
    shot_size: '近景',
    camera_movement: '固定',
  },
  {
    id: 3,
    time_range: '00:04.000-00:08.000',
    script_text: '真实识别第三段文案。',
    scene_description: '结尾收口',
    scene_text: '行动引导',
    camera_angle: '平视',
    shot_size: '中景',
    camera_movement: '固定',
  },
];
const longCutterResults = [
  {
    id: 1,
    time_range: '00:00.000-00:08.000',
    script_text: '第一段完整内容。',
    scene_description: '开头完整场景',
    scene_text: '问题引入',
  },
  {
    id: 2,
    time_range: '00:08.000-00:16.000',
    script_text: '第二段完整内容。',
    scene_description: '中段完整场景',
    scene_text: '产品方案',
  },
  {
    id: 3,
    time_range: '00:16.000-00:24.000',
    script_text: '第三段完整内容。',
    scene_description: '结尾完整场景',
    scene_text: '体验证明',
  },
];
const cutterServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${cutterPort}`);
  const respond = (status, data, message = 'ok') => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 0, data, message }));
  };
  if (req.method === 'POST' && url.pathname === '/cutter/save') {
    const payload = await readJsonBody(req);
    const assetMatch = String(payload.oss_url || '').match(
      /\/download\/(7101|7104)$/u,
    );
    if (!assetMatch) {
      respond(400, {}, 'invalid oss_url');
      return;
    }
    cutterAssetId = Number(assetMatch[1]);
    cutterSubmitted = true;
    respond(202, {
      success: true,
      task_id: 'smoke-cutter-task',
      status: 'pending',
      accepted: true,
      reused: false,
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/cutter/task') {
    cutterTaskChecks += 1;
    respond(200, {
      success: true,
      task_id: 'smoke-cutter-task',
      status: cutterTaskChecks >= 2 ? 'success' : 'processing',
      error_message: '',
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/cutter/select') {
    const selectedResults =
      cutterAssetId === longEffectiveAsset.id
        ? longCutterResults
        : cutterResults;
    respond(200, {
      success: true,
      count:
        cutterSubmitted && cutterTaskChecks >= 2 ? selectedResults.length : 0,
      results: cutterSubmitted && cutterTaskChecks >= 2 ? selectedResults : [],
    });
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve, reject) => {
  cutterServer.once('error', reject);
  cutterServer.listen(cutterPort, '127.0.0.1', resolve);
});

const worker = spawn(process.execPath, [path.join(workerRoot, 'server.mjs')], {
  cwd: path.resolve(workerRoot, '..'),
  windowsHide: true,
  env: {
    ...process.env,
    // This child uses only isolated fixtures and local mock services.
    RENDER_WORKER_SHARED_SECRET: '',
    RENDER_WORKER_PORT: String(port),
    RENDER_WORKER_DATA_DIR: workerDataDir,
    WIS_MATERIAL_CENTER_BASE_URL: materialCenterBaseUrl,
    WIS_MATERIAL_CENTER_TOKEN: materialCenterToken,
    WIS_MATERIAL_CENTER_READ_TIMEOUT_MS: '250',
    WIS_MATERIAL_CENTER_READ_MAX_ATTEMPTS: '3',
    WIS_MATERIAL_CENTER_READ_RETRY_DELAY_MS: '10',
    WIS_CUTTER_BASE_URL: cutterBaseUrl,
    AUTO_REMIX_SCHEDULER_INTERVAL_MS: '250',
    AUTO_REMIX_REMEDIATION_DELAY_MS: '5000',
    CLIP_REPLENISHMENT_RETRY_BASE_MS: '50',
    CLIP_REPLENISHMENT_RETRY_MAX_MS: '100',
    CONTINUOUS_CLIP_SUPPLY_INITIAL_DELAY_MS: '600000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let workerLogs = '';
for (const stream of [worker.stdout, worker.stderr]) {
  stream.on('data', (chunk) => {
    workerLogs = (workerLogs + chunk.toString()).slice(-8000);
  });
}

try {
  let health;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch {
      // Worker is still starting.
    }
    await wait(250);
  }
  if (
    !health?.capabilities?.clipRemix ||
    !health?.capabilities?.materialCenterBidirectional ||
    !health?.capabilities?.cutterRecognition ||
    !health?.capabilities?.localSubtitleOcr ||
    health?.resourceGovernance?.processMaxConcurrency !== Number(process.env.RENDER_WORKER_PROCESS_MAX_CONCURRENCY || 2) ||
    health?.resourceGovernance?.ocrProcessMaxConcurrency !== 2 ||
    health?.resourceGovernance?.autoJobMaxConcurrency !== 1 ||
    health?.resourceGovernance?.clipReplenishmentMaxConcurrency !== 1 ||
    health?.resourceGovernance?.libraryCached !== true
  ) {
    throw new Error(`混剪切片能力或资源并发保护没有就绪。${workerLogs}`);
  }

  const materialAssets = await request(
    '/api/remix/material-center/assets?library_type=source&page=1&page_size=20',
  );
  if (
    materialAssets.total !== 504 ||
    !materialAssets.items.some((item) => item.id === materialAsset.id) ||
    !materialAssets.items.some((item) => item.id === automaticSourceAsset.id) ||
    [
      '待分类',
      '其他 WIS 素材',
      '晶润眼膜',
      '隐形水润面膜',
      '肌活蛋白喷雾',
      '深海次抛',
      '燕窝面膜',
      '黑晶面膜',
      '通用',
      '美白针',
      '黄金面膜',
      '颈膜',
    ].some(
      (category, index) =>
        materialAssets.filters.categories[index]?.value !== category,
    )
  ) {
    throw new Error('工作台没有读到素材中心有效原片或完整产品分类。');
  }
  const supplyLibrary = await request('/api/remix/library');
  if (
    supplyLibrary.automation.clipSupply?.enabled !== true ||
    supplyLibrary.automation.clipSupply?.status !== 'watching' ||
    supplyLibrary.automation.clipSupply?.targetApprovedPerProduct !== 500 ||
    supplyLibrary.automation.clipSupply?.targetApprovedPerRole !== 7 ||
    !supplyLibrary.automation.clipSupply?.inventory.some(
      (item) => item.productCategory === 'WIS隐形水润面膜',
    )
  ) {
    throw new Error('24小时切片供应线没有持久化库存水位与监听状态。');
  }
  const remixAssets = await request(
    '/api/remix/material-center/assets?library_type=remix&page=1&page_size=10',
  );
  if (
    remixAssets.total !== 1 ||
    remixAssets.libraryType !== 'remix' ||
    remixAssets.items[0]?.id !== materialRemixAsset.id ||
    remixAssets.items[0]?.coverUrl !== materialRemixAsset.cover_url
  ) {
    throw new Error('工作台没有读到混剪成片筛选结果或真实封面。');
  }
  const allVideosSecondPage = await request(
    '/api/remix/material-center/assets?library_type=all&page=2&page_size=1',
  );
  if (
    allVideosSecondPage.total !== 505 ||
    allVideosSecondPage.page !== 2 ||
    allVideosSecondPage.pageSize !== 1 ||
    allVideosSecondPage.items.length !== 1
  ) {
    throw new Error('素材中心全部视频分页没有按页码和每页数量返回。');
  }
  const filteredMaterialAssets = await request(
    `/api/remix/material-center/assets?library_type=all&page=1&page_size=20&category=${encodeURIComponent(materialRemixAsset.category)}&folder_name=${encodeURIComponent(materialRemixAsset.folder_name)}`,
  );
  if (
    filteredMaterialAssets.total !== 1 ||
    filteredMaterialAssets.items[0]?.id !== materialRemixAsset.id ||
    filteredMaterialAssets.selectedCategory !== materialRemixAsset.category ||
    filteredMaterialAssets.selectedFolder !== materialRemixAsset.folder_name ||
    !filteredMaterialAssets.filters.categories.some(
      (option) => option.value === materialAsset.category,
    )
  ) {
    throw new Error('素材中心分类或文件夹筛选没有透传真实元数据。');
  }
  const importedSources = await Promise.all(
    [1, 2].map(() =>
      request('/api/remix/material-center/imports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: materialAsset.id }),
      }),
    ),
  );
  const source = importedSources[0].source;
  if (
    source.id !== importedSources[1].source.id ||
    source.materialCenterAssetId !== materialAsset.id ||
    source.productCategory !== 'WIS隐形水润面膜'
  ) {
    throw new Error('素材中心原片并发导入没有幂等复用或缺少来源编号。');
  }
  const importedRemixSource = (
    await request('/api/remix/material-center/imports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetId: materialRemixAsset.id }),
    })
  ).source;
  if (
    importedRemixSource.materialCenterAssetId !== materialRemixAsset.id ||
    importedRemixSource.materialCenterLibraryType !== 'remix'
  ) {
    throw new Error('混剪成片导入后没有保留素材中心类型与来源编号。');
  }
  const manualSourceForm = new FormData();
  manualSourceForm.append(
    'source',
    new Blob([await fs.readFile(sourcePath)], { type: 'video/mp4' }),
    '手动补充样片.mp4',
  );
  manualSourceForm.append('batchId', 'manual-source-batch');
  manualSourceForm.append('clientFingerprint', 'manual-source-fingerprint');
  const manualSourceResult = await request('/api/remix/sources', {
    method: 'POST',
    body: manualSourceForm,
  });
  const manualSource = manualSourceResult.source;
  if (
    !manualSource.id ||
    manualSource.materialCenterAssetId ||
    manualSourceResult.reused
  ) {
    throw new Error('手动补充来源的兼容入口不可用。');
  }
  const duplicateManualSourceForm = new FormData();
  duplicateManualSourceForm.append(
    'source',
    new Blob([await fs.readFile(sourcePath)], { type: 'video/mp4' }),
    '手动补充样片-重复提交.mp4',
  );
  duplicateManualSourceForm.append('batchId', 'manual-source-batch');
  duplicateManualSourceForm.append(
    'clientFingerprint',
    'manual-source-fingerprint',
  );
  const duplicateManualSource = await request('/api/remix/sources', {
    method: 'POST',
    body: duplicateManualSourceForm,
  });
  if (
    !duplicateManualSource.reused ||
    duplicateManualSource.source.id !== manualSource.id
  ) {
    throw new Error('手动补充来源重复提交时没有复用相同内容。');
  }
  const incompatibleSourceForm = new FormData();
  incompatibleSourceForm.append(
    'source',
    new Blob([await fs.readFile(incompatibleSourcePath)], {
      type: 'video/x-msvideo',
    }),
    '非浏览器原片.avi',
  );
  const incompatibleSource = (
    await request('/api/remix/sources', {
      method: 'POST',
      body: incompatibleSourceForm,
    })
  ).source;
  if (incompatibleSource.browserPreviewStatus === 'processing') {
    throw new Error('上传请求不应等待兼容预览转码。');
  }
  const compatiblePreviewResponse = await fetch(
    `${baseUrl}/api/remix/media/source/${incompatibleSource.id}`,
  );
  if (
    !compatiblePreviewResponse.ok ||
    !String(compatiblePreviewResponse.headers.get('content-type')).startsWith(
      'video/mp4',
    )
  ) {
    throw new Error('兼容预览接口没有返回可播放 MP4。');
  }
  const compatiblePreviewPath = path.join(fixturesDir, 'browser-preview.mp4');
  const previewLibrary = await request('/api/remix/library');
  if (
    previewLibrary.sources.find((source) => source.id === incompatibleSource.id)
      ?.browserPreviewStatus !== 'transcoded'
  ) {
    throw new Error('非 H.264/AAC MP4 来源按需生成兼容预览失败。');
  }
  await fs.writeFile(
    compatiblePreviewPath,
    Buffer.from(await compatiblePreviewResponse.arrayBuffer()),
  );
  const compatiblePreviewCodec = await probeCodec(compatiblePreviewPath);
  if (
    compatiblePreviewCodec.codec !== 'h264' ||
    compatiblePreviewCodec.pixelFormat !== 'yuv420p'
  ) {
    throw new Error('浏览器兼容预览不是 H.264 yuv420p。');
  }
  const compatiblePreviewUrl = `${baseUrl}/api/remix/media/source/${incompatibleSource.id}`;
  const headPreviewResponse = await fetch(compatiblePreviewUrl, {
    method: 'HEAD',
  });
  if (
    headPreviewResponse.status !== 200 ||
    headPreviewResponse.headers.get('accept-ranges') !== 'bytes' ||
    (await headPreviewResponse.arrayBuffer()).byteLength !== 0
  ) {
    throw new Error('浏览器兼容预览没有正确处理 HEAD 请求。');
  }
  await new Promise((resolve, reject) => {
    const abortRequest = http.get(compatiblePreviewUrl, (response) => {
      response.once('data', () => {
        response.destroy();
        resolve();
      });
      response.once('end', resolve);
      response.once('error', (error) => {
        if (error?.code === 'ECONNRESET') resolve();
        else reject(error);
      });
    });
    abortRequest.once('error', (error) => {
      if (error?.code === 'ECONNRESET') resolve();
      else reject(error);
    });
  });
  await wait(100);
  await request('/api/remix/library');
  const uploadDirectClip = async (fileName, relativePath) => {
    const form = new FormData();
    form.append(
      'source',
      new Blob([await fs.readFile(sourcePath)], { type: 'video/mp4' }),
      fileName,
    );
    form.append('batchId', 'batch-folder-smoke');
    form.append('relativePath', relativePath);
    form.append('targetFolderId', '');
    form.append(
      'clientFingerprint',
      `${relativePath}|${sourceStat.size}|smoke`,
    );
    form.append('productCategory', '通用切片');
    return request('/api/remix/clip-uploads', {
      method: 'POST',
      body: form,
    });
  };
  const firstDirectUpload = await uploadDirectClip(
    '批量切片1.mp4',
    '批量上传验收/产品镜头/批量切片1.mp4',
  );
  const repeatedDirectUpload = await uploadDirectClip(
    '批量切片副本.mp4',
    '批量上传验收/产品镜头/批量切片副本.mp4',
  );
  if (
    !firstDirectUpload.contentSha256 ||
    firstDirectUpload.contentSha256 !== repeatedDirectUpload.contentSha256 ||
    firstDirectUpload.clip.id !== repeatedDirectUpload.clip.id ||
    repeatedDirectUpload.reused !== true ||
    firstDirectUpload.clip.reviewStatus !== 'pending' ||
    firstDirectUpload.clip.productCategory !== '通用切片' ||
    firstDirectUpload.clip.isMine !== true ||
    firstDirectUpload.folderPath !== '批量上传验收 / 产品镜头' ||
    'folderAssignments' in firstDirectUpload.clip ||
    'contentSha256' in firstDirectUpload.source
  ) {
    throw new Error('切片批量直传、内容指纹幂等、待审核状态或隐私脱敏失败。');
  }
  const directUploadLibrary = await request('/api/remix/library');
  const directUploadFolder = directUploadLibrary.folders.find(
    (folder) => folder.name === '批量上传验收',
  );
  const directUploadChildFolder = directUploadLibrary.folders.find(
    (folder) =>
      folder.name === '产品镜头' && folder.parentId === directUploadFolder?.id,
  );
  if (
    !directUploadFolder ||
    !directUploadChildFolder ||
    directUploadLibrary.clips.filter(
      (clip) => clip.id === firstDirectUpload.clip.id,
    ).length !== 1 ||
    directUploadLibrary.clips.find(
      (clip) => clip.id === firstDirectUpload.clip.id,
    )?.folderId !== directUploadChildFolder.id
  ) {
    throw new Error('文件夹上传没有保留个人目录层级或重复生成切片。');
  }
  const directClipDimensions = await probeDimensions(
    path.join(
      workerDataDir,
      'clip-remix',
      'clips',
      `${firstDirectUpload.clip.id}.mp4`,
    ),
  );
  if (
    directClipDimensions.width !== 1080 ||
    directClipDimensions.height !== 1920
  ) {
    throw new Error('直接上传生成的切片没有统一转为9:16。');
  }
  const analyzedSource = (
    await request(`/api/remix/sources/${source.id}/analyze`, {
      method: 'POST',
    })
  ).source;
  if (
    analyzedSource.analysisStatus !== 'ready' ||
    analyzedSource.analysisProvider !== 'cutter' ||
    !Number.isFinite(analyzedSource.analysisDurationMs) ||
    analyzedSource.analysisDurationMs < 0 ||
    analyzedSource.speechSegments.length !== 3 ||
    analyzedSource.speechSegments[0]?.label !== '真实识别第一段文案。' ||
    Math.abs(analyzedSource.speechSegments.at(-1)?.endSeconds - 8) > 0.1
  ) {
    throw new Error('Cutter 文案、切点或视频时长收口没有正确生成。');
  }
  const recognition = (
    await request(`/api/remix/sources/${source.id}/framework-recognition`, {
      method: 'POST',
    })
  ).recognition;
  if (
    recognition.mode !== 'rules' ||
    recognition.sourceId !== source.id ||
    recognition.slots.length < 2 ||
    !recognition.description.includes('未进行语义识别')
  ) {
    throw new Error('上传视频后的规则框架识别结果不透明或不可用。');
  }
  const firstSegment = analyzedSource.speechSegments[0];
  const updatedSource = (
    await request(
      `/api/remix/sources/${source.id}/segments/${firstSegment.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: '人工核对后的第一段口播',
          clipName: '人工保存的第一段切片名称',
          startSeconds: firstSegment.startSeconds,
          endSeconds: firstSegment.endSeconds,
        }),
      },
    )
  ).source;
  if (
    updatedSource.speechSegments[0].label !== '人工核对后的第一段口播' ||
    updatedSource.speechSegments[0].clipName !== '人工保存的第一段切片名称'
  ) {
    throw new Error('切片名称、口播文本或切点没有持久化。');
  }
  const reanalyzedSource = (
    await request(`/api/remix/sources/${source.id}/analyze`, {
      method: 'POST',
    })
  ).source;
  if (
    reanalyzedSource.speechSegments[0].label !== '人工核对后的第一段口播' ||
    reanalyzedSource.speechSegments[0].clipName !==
      '人工保存的第一段切片名称' ||
    reanalyzedSource.speechSegments[0].transcriptSource !== 'manual'
  ) {
    throw new Error('重新识别覆盖了人工校准的文案或切点。');
  }
  const invalidSegmentResponse = await fetch(
    `${baseUrl}/api/remix/sources/${source.id}/segments/${firstSegment.id}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: '不应保存的过短片段',
        startSeconds: 0,
        endSeconds: 0.4,
      }),
    },
  );
  if (invalidSegmentResponse.status !== 400) {
    throw new Error('无效切点未在保存阶段被阻止。');
  }
  const secondSegment = reanalyzedSource.speechSegments[1];
  const thirdSegment = reanalyzedSource.speechSegments[2];
  const clipCountBeforeBatchSave = (await request('/api/remix/library')).clips
    .length;
  const batchSaveResult = await request(
    `/api/remix/sources/${source.id}/segments`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        segments: [
          {
            id: secondSegment.id,
            label: '批量保存后的第二段口播',
            clipName: '批量保存第二段',
            startSeconds: secondSegment.startSeconds,
            endSeconds: secondSegment.endSeconds,
          },
          {
            id: thirdSegment.id,
            label: '批量保存后的第三段口播',
            clipName: '批量保存第三段',
            startSeconds: thirdSegment.startSeconds,
            endSeconds: thirdSegment.endSeconds,
          },
        ],
      }),
    },
  );
  const batchSavedSecond = batchSaveResult.source.speechSegments.find(
    (segment) => segment.id === secondSegment.id,
  );
  const batchSavedThird = batchSaveResult.source.speechSegments.find(
    (segment) => segment.id === thirdSegment.id,
  );
  if (
    batchSaveResult.updatedCount !== 2 ||
    batchSavedSecond?.clipName !== '批量保存第二段' ||
    batchSavedThird?.clipName !== '批量保存第三段' ||
    (await request('/api/remix/library')).clips.length !==
      clipCountBeforeBatchSave
  ) {
    throw new Error('勾选片段没有批量持久化，或批量保存错误生成了切片。');
  }
  const invalidBatchSaveResponse = await fetch(
    `${baseUrl}/api/remix/sources/${source.id}/segments`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        segments: [
          {
            id: secondSegment.id,
            label: '不应部分落库的第二段',
            clipName: '不应部分落库',
            startSeconds: secondSegment.startSeconds,
            endSeconds: secondSegment.endSeconds,
          },
          {
            id: thirdSegment.id,
            label: '无效的第三段',
            clipName: '无效切点',
            startSeconds: 0,
            endSeconds: 0.4,
          },
        ],
      }),
    },
  );
  const libraryAfterInvalidBatchSave = await request('/api/remix/library');
  const sourceAfterInvalidBatchSave = libraryAfterInvalidBatchSave.sources.find(
    (candidate) => candidate.id === source.id,
  );
  if (
    invalidBatchSaveResponse.status !== 400 ||
    sourceAfterInvalidBatchSave?.speechSegments.find(
      (segment) => segment.id === secondSegment.id,
    )?.label !== '批量保存后的第二段口播'
  ) {
    throw new Error('批量保存校验失败时发生了部分落库。');
  }
  const parsedFramework = (
    await request('/api/remix/frameworks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '参考解析框架',
        description: '端到端验收',
        tags: ['口播', '规则识别'],
        sourceType: 'parsed',
        sourceId: source.id,
        slots: [{ label: '开头段' }, { label: '收口段' }],
      }),
    })
  ).framework;
  const libraryWithFramework = await request('/api/remix/library');
  if (
    !libraryWithFramework.frameworks.some(
      (framework) =>
        framework.id === parsedFramework.id &&
        framework.tags.includes('规则识别'),
    )
  ) {
    throw new Error('参考解析框架或标签没有持久化。');
  }
  const promotedFramework = (
    await request(`/api/remix/frameworks/${parsedFramework.id}/promote`, {
      method: 'POST',
    })
  ).framework;
  if (
    promotedFramework.sourceType !== 'preset' ||
    promotedFramework.promotedFromId !== parsedFramework.id
  ) {
    throw new Error('视频识别框架没有正确加入预设。');
  }
  await request(`/api/remix/frameworks/${promotedFramework.id}`, {
    method: 'DELETE',
  });
  await request('/api/remix/frameworks/benefit-solution-demo-proof-urgency', {
    method: 'DELETE',
  });
  const libraryAfterFrameworkDeletes = await request('/api/remix/library');
  if (
    libraryAfterFrameworkDeletes.frameworks.some(
      (framework) =>
        framework.id === promotedFramework.id ||
        framework.id === 'benefit-solution-demo-proof-urgency',
    )
  ) {
    throw new Error('预设框架删除后仍出现在框架库。');
  }

  const clipDefinitions = [
    ['hook', 0, 1.2],
    ['pain', 1.2, 2.4],
    ['solution', 2.4, 3.6],
    ['proof', 3.6, 4.8],
    ['cta', 4.8, 6],
    ['hook', 6, 7.2, '通用切片'],
  ];
  const clips = [];
  for (const [
    role,
    startSeconds,
    endSeconds,
    productCategory = 'WIS隐形水润面膜',
  ] of clipDefinitions) {
    const clip = (
      await request('/api/remix/clips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceId: source.id,
          role,
          startSeconds,
          endSeconds,
          name: `测试-${role}-${startSeconds}`,
          tags: `验收,${role}`,
          productCategory,
        }),
      })
    ).clip;
    if (!clip.isMine || 'createdByIds' in clip) {
      throw new Error('“我的切片”身份标记缺失或内部用户 ID 被暴露。');
    }
    clips.push(clip);
    await request(`/api/remix/clips/${clip.id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewStatus: 'approved' }),
    });
  }
  await request(`/api/remix/clips/${clips[0].id}/metadata`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '剧情演绎开头验收',
      tags: ['验收', 'hook', '剧情演绎'],
      productCategory: 'WIS隐形水润面膜',
    }),
  });
  const misplacedDramaClip = (
    await request('/api/remix/clips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceId: source.id,
        role: 'pain',
        startSeconds: 6,
        endSeconds: 7.2,
        name: '剧情演绎中段应被排除',
        tags: '验收,剧情演绎',
        productCategory: 'WIS隐形水润面膜',
      }),
    })
  ).clip;
  await request(`/api/remix/clips/${misplacedDramaClip.id}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewStatus: 'approved' }),
  });
  const reusedClip = (
    await request('/api/remix/clips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceId: source.id,
        role: 'hook',
        startSeconds: 0,
        endSeconds: 1.2,
        name: '重复提交不应生成新文件',
        productCategory: 'WIS隐形水润面膜',
      }),
    })
  ).clip;
  if (reusedClip.id !== clips[0].id) {
    throw new Error('重复提交同一切点时没有复用已有切片。');
  }
  const concurrentPayload = {
    sourceId: source.id,
    role: 'proof',
    startSeconds: 6,
    endSeconds: 7.2,
    name: '并发幂等验收',
    productCategory: 'WIS隐形水润面膜',
  };
  const concurrentClips = await Promise.all(
    [1, 2].map(() =>
      request('/api/remix/clips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(concurrentPayload),
      }),
    ),
  );
  if (concurrentClips[0].clip.id !== concurrentClips[1].clip.id) {
    throw new Error('并发提交同一切点时生成了重复切片。');
  }
  const otherProductClipId = concurrentClips[0].clip.id;
  await request(`/api/remix/clips/${otherProductClipId}/metadata`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '黑晶面膜证明片段',
      tags: ['品类隔离'],
      productCategory: '黑晶面膜',
    }),
  });
  await request(`/api/remix/clips/${otherProductClipId}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewStatus: 'approved' }),
  });
  const crossProductRender = await fetch(`${baseUrl}/api/remix/renders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '跨品类应拦截',
      slotSelections: {
        hook: [clips[0].id],
        proof: [otherProductClipId],
      },
      productCategory: 'WIS隐形水润面膜',
      maxOutputs: 1,
    }),
  });
  const crossProductPayload = await crossProductRender.json();
  if (
    crossProductRender.status !== 400 ||
    !String(crossProductPayload.message || '').includes('只能使用')
  ) {
    throw new Error('不同产品品类的切片未被服务端阻止混剪。');
  }
  const clipDimensions = await probeDimensions(
    path.join(workerDataDir, 'clip-remix', 'clips', clips[0].storedName),
  );
  if (clipDimensions.width !== 1080 || clipDimensions.height !== 1920) {
    throw new Error(
      `切片不是9:16，实际为${clipDimensions.width}x${clipDimensions.height}。`,
    );
  }

  const folderRequests = await Promise.all(
    [1, 2].map(() =>
      request('/api/remix/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '已确认产品镜头' }),
      }),
    ),
  );
  const folder = folderRequests[0].folder;
  if (!folder.id || folder.id !== folderRequests[1].folder.id) {
    throw new Error('重复创建同名团队文件夹时没有幂等复用。');
  }
  const childFolder = (
    await request('/api/remix/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '二级目录', parentId: folder.id }),
    })
  ).folder;
  const grandchildFolder = (
    await request('/api/remix/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '三级空目录', parentId: childFolder.id }),
    })
  ).folder;
  if (
    childFolder.parentId !== folder.id ||
    grandchildFolder.parentId !== childFolder.id
  ) {
    throw new Error('二级、三级文件夹层级没有持久化。');
  }
  await request(`/api/remix/folders/${grandchildFolder.id}`, {
    method: 'DELETE',
  });
  const categorizedClip = (
    await request(`/api/remix/clips/${clips[0].id}/folder`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: folder.id }),
    })
  ).clip;
  const libraryWithFolder = await request('/api/remix/library');
  if (
    categorizedClip.folderId !== folder.id ||
    !libraryWithFolder.folders.some((item) => item.id === folder.id) ||
    libraryWithFolder.clips.find((item) => item.id === clips[0].id)
      ?.folderId !== folder.id
  ) {
    throw new Error('团队文件夹或切片归类没有持久化读回。');
  }
  const nonEmptyFolderDelete = await fetch(
    `${baseUrl}/api/remix/folders/${folder.id}`,
    { method: 'DELETE' },
  );
  if (nonEmptyFolderDelete.status !== 409) {
    throw new Error('含有切片或子目录的文件夹未阻止删除。');
  }
  const mineReadback = libraryWithFolder.clips.filter((item) => item.isMine);
  if (mineReadback.length < clips.length) {
    throw new Error('当前登录用户无法在“我的切片”中读回自己生成的切片。');
  }

  const slots = {
    hook: [clips[0].id, clips[5].id],
    pain: clips[1].id,
    solution: clips[2].id,
    proof: clips[3].id,
    cta: clips[4].id,
  };
  const customWorkspaceFrameworkDraft = {
    sourceFrameworkId: parsedFramework.id,
    name: '工作台自定义验收框架',
    description: '编辑分组后由成功生成自动沉淀',
    tags: ['工作台自定义', '真实烟测'],
    slots: [
      {
        ...parsedFramework.slots[0],
        label: '可编辑开头组',
        note: '编辑后的第一组说明',
      },
      {
        ...parsedFramework.slots[1],
        label: '可编辑收口组',
        note: '编辑后的第二组说明',
      },
    ],
  };
  const customShotAliases = {
    [parsedFramework.slots[0].id]: {
      [clips[0].id]: '工作台自定义镜头名',
    },
  };
  const fullCombinationRender = (
    await request('/api/remix/renders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '完整组合上限验收',
        frameworkId: parsedFramework.id,
        frameworkDraft: customWorkspaceFrameworkDraft,
        shotAliases: customShotAliases,
        slotSelections: {
          [parsedFramework.slots[0].id]: clips
            .slice(0, 4)
            .map((clip) => clip.id),
          [parsedFramework.slots[1].id]: clips
            .slice(2, 6)
            .map((clip) => clip.id),
        },
        productCategory: 'WIS隐形水润面膜',
        maxOutputs: 12,
      }),
    })
  ).render;
  if (fullCombinationRender.variants.length !== 12) {
    throw new Error(
      `生成数量仍被旧上限截断，预期12条，实际${fullCombinationRender.variants.length}条。`,
    );
  }
  if (
    fullCombinationRender.shotAliases?.[parsedFramework.slots[0].id]?.[
      clips[0].id
    ] !== '工作台自定义镜头名' ||
    fullCombinationRender.variants[0].shotAliases?.[
      parsedFramework.slots[0].id
    ]?.[clips[0].id] !== '工作台自定义镜头名'
  ) {
    throw new Error('工作台局部镜头名称没有随任务和成片持久化。');
  }
  const libraryAfterCustomRender = await request('/api/remix/library');
  const savedWorkspaceFramework = libraryAfterCustomRender.frameworks.find(
    (framework) => framework.id === fullCombinationRender.templateId,
  );
  if (
    savedWorkspaceFramework?.sourceType !== 'custom' ||
    savedWorkspaceFramework.name !== customWorkspaceFrameworkDraft.name ||
    savedWorkspaceFramework.derivedFromFrameworkId !== parsedFramework.id ||
    savedWorkspaceFramework.slots[0]?.label !== '可编辑开头组' ||
    'workspaceFingerprint' in savedWorkspaceFramework
  ) {
    throw new Error('自定义分组未在成功生成后安全沉淀到手动框架库。');
  }
  const repeatedCustomRender = (
    await request('/api/remix/renders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '自定义框架幂等验收',
        frameworkId: parsedFramework.id,
        frameworkDraft: customWorkspaceFrameworkDraft,
        shotAliases: customShotAliases,
        slotSelections: {
          [parsedFramework.slots[0].id]: [clips[0].id],
          [parsedFramework.slots[1].id]: [clips[1].id],
        },
        productCategory: 'WIS隐形水润面膜',
        maxOutputs: 1,
      }),
    })
  ).render;
  const libraryAfterRepeatedCustomRender = await request('/api/remix/library');
  if (
    repeatedCustomRender.templateId !== fullCombinationRender.templateId ||
    libraryAfterRepeatedCustomRender.frameworks.filter(
      (framework) => framework.id === fullCombinationRender.templateId,
    ).length !== 1
  ) {
    throw new Error('重复生成时创建了重复的手动框架。');
  }
  let blankDisclaimerBlocked = false;
  try {
    await request('/api/remix/renders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '空警示语验收',
        slots,
        productCategory: 'WIS隐形水润面膜',
        includeUsageDisclaimer: true,
        usageDisclaimerText: '   ',
      }),
    });
  } catch (error) {
    blankDisclaimerBlocked = String(error).includes('警示语');
  }
  if (!blankDisclaimerBlocked) {
    throw new Error('启用警示语但未填内容时，系统仍允许生成。');
  }
  const render = (
    await request('/api/remix/renders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '混剪验收',
        slots,
        productCategory: 'WIS隐形水润面膜',
        includeUsageDisclaimer: true,
        usageDisclaimerText: '请根据自身肤质合理使用',
      }),
    })
  ).render;
  if (
    render.variants.length !== 2 ||
    render.generationMode !== 'manual' ||
    render.productCategory !== 'WIS隐形水润面膜' ||
    !render.variants.every(
      (variant) =>
        variant.usageDisclaimerApplied &&
        variant.usageDisclaimerText === '请根据自身肤质合理使用',
    )
  ) {
    throw new Error(`预期生成2条变体，实际为${render.variants.length}条。`);
  }
  const outputDimensions = await probeDimensions(
    path.join(
      workerDataDir,
      'clip-remix',
      'outputs',
      render.variants[0].storedName,
    ),
  );
  if (outputDimensions.width !== 1080 || outputDimensions.height !== 1920) {
    throw new Error(
      `混剪成片不是9:16，实际为${outputDimensions.width}x${outputDimensions.height}。`,
    );
  }
  const partialRender = (
    await request('/api/remix/renders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '允许空框架位',
        slotSelections: { hook: [clips[0].id] },
        productCategory: 'WIS隐形水润面膜',
        maxOutputs: 1,
      }),
    })
  ).render;
  if (
    partialRender.variants.length !== 1 ||
    partialRender.variants[0].qualityAssessment?.level !== 'review'
  ) {
    throw new Error('允许空框架位或基础质量评分没有生效。');
  }

  const preview = await fetch(
    `${baseUrl}/api/remix/media/output/${render.id}/${render.variants[0].id}`,
    { headers: { Range: 'bytes=0-1023' } },
  );
  if (preview.status !== 206 || !preview.headers.get('content-range')) {
    throw new Error('混剪成片的分段预览不可用。');
  }
  const suffixPreview = await fetch(
    `${baseUrl}/api/remix/media/output/${render.id}/${render.variants[0].id}`,
    { headers: { Range: 'bytes=-128' } },
  );
  if (
    suffixPreview.status !== 206 ||
    (await suffixPreview.arrayBuffer()).byteLength !== 128 ||
    !/^bytes \d+-\d+\/\d+$/u.test(
      String(suffixPreview.headers.get('content-range')),
    )
  ) {
    throw new Error('视频接口没有正确处理浏览器后缀 Range 请求。');
  }

  const pendingDownload = await fetch(
    `${baseUrl}/api/remix/media/output/${render.id}/${render.variants[0].id}?download=1`,
  );
  if (pendingDownload.status !== 403) {
    throw new Error('成片审核前下载未被拦截。');
  }
  await request(
    `/api/remix/renders/${render.id}/variants/${render.variants[0].id}/review`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewStatus: 'approved' }),
    },
  );
  const approvedDownload = await fetch(
    `${baseUrl}/api/remix/media/output/${render.id}/${render.variants[0].id}?download=1`,
  );
  if (!approvedDownload.ok) {
    throw new Error('成片审核通过后下载不可用。');
  }
  const returnPath = `/api/remix/renders/${render.id}/variants/${render.variants[0].id}/return-to-material-center`;
  const firstReturn = (await request(returnPath, { method: 'POST' })).result;
  const repeatedReturn = (await request(returnPath, { method: 'POST' })).result;
  if (
    firstReturn.status !== 'completed' ||
    firstReturn.assetId !== 9101 ||
    repeatedReturn.assetId !== firstReturn.assetId ||
    returnUploadCount !== 1
  ) {
    throw new Error('审核成片回传或幂等重试没有通过。');
  }
  const centerRecord = returnRecords.get(firstReturn.idempotencyKey);
  if (
    !centerRecord?.provenance?.source_asset_ids?.includes(materialAsset.id) ||
    centerRecord.provenance.review_status !== 'approved' ||
    centerRecord.category !== '隐形水润面膜'
  ) {
    throw new Error('回传记录没有保留来源素材和审核状态。');
  }
  const libraryAfterReturn = await request('/api/remix/library');
  const returnedVariant = libraryAfterReturn.renders
    .find((item) => item.id === render.id)
    ?.variants.find((item) => item.id === render.variants[0].id);
  if (
    returnedVariant?.materialCenterReturn?.status !== 'completed' ||
    returnedVariant.materialCenterReturn.assetId !== 9101
  ) {
    throw new Error('工作台没有持久化素材中心回传读回状态。');
  }

  const [qianchuanAccounts, qianchuanProductPlanMap, qianchuanPlans] =
    await Promise.all([
      request('/api/remix/automation/qianchuan/accounts'),
      request('/api/remix/automation/qianchuan/product-plan-map'),
      request(
        '/api/remix/automation/qianchuan/plans?advertiser_id=1869672250595328',
      ),
    ]);
  if (
    qianchuanAccounts.total !== 1 ||
    qianchuanProductPlanMap.source.revision !== 536 ||
    qianchuanProductPlanMap.items[0]?.rules[0]?.planId !== '1870289794646204' ||
    qianchuanPlans.total !== 2 ||
    !qianchuanPlans.items.some((item) => item.planType === 'standard')
  ) {
    throw new Error('自动混剪没有读取到云管家完整的千川账户和计划目录。');
  }

  const autoJob = (
    await request('/api/remix/automation/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '每日自动混剪验收',
        frameworkId: 'hook-pain-solution-proof-cta',
        productCategory: 'WIS隐形水润面膜',
        dailyTarget: 3,
        scheduleEnabled: false,
        scheduleTime: '09:00',
        targetDurationSeconds: 30,
        includeUsageDisclaimer: true,
        usageDisclaimerText: '护肤体验请以实际使用为准',
        autoApproveOutputs: true,
        autoReturnAfterApproval: true,
        qianchuanDelivery: {
          enabled: true,
          confirmed: true,
          advertiserId: '1869672250595328',
          advertiserName: '营销部WIS-厚拓（爱创）-2',
          planId: '1870289794646204',
          planName: '',
          planAlias: 'WIS官方旗舰店优选',
          planType: 'multiplication',
          targets: [
            {
              advertiserId: '1869672250595328',
              advertiserName: '营销部WIS-厚拓（爱创）-2',
              planId: '1870289794646204',
              planName: '直播全域投放计划',
              planType: 'multiplication',
            },
            {
              advertiserId: '1869672250595328',
              advertiserName: '营销部WIS-厚拓（爱创）-2',
              planId: '1870289794646205',
              planName: '商品标准推广计划',
              planType: 'standard',
            },
          ],
          dailyMaterialLimit: 1,
          dailySpendGuardYuan: 100,
        },
        sourceSelectionLimit: 1,
        runImmediately: true,
      }),
    })
  ).job;
  if (
    autoJob.usageDisclaimerText !== '护肤体验请以实际使用为准' ||
    autoJob.qianchuanDelivery.targets.length !== 2 ||
    !autoJob.createdAt
  ) {
    throw new Error('自动任务没有保存自定义警示语、多计划目标或建立时间。');
  }
  let automatedLibrary = null;
  let automatedJob = null;
  // Includes three deliberately timed-out upstream requests, recovery backoff,
  // real encoding and clip review under the production 0.5 CPU quota.
  // Keep every business assertion below; allow the whole recovery path to finish.
  const autoRecoveryDeadline = Date.now() + 180_000;
  for (let attempt = 0; Date.now() < autoRecoveryDeadline; attempt += 1) {
    if (attempt % 5 === 0) {
      const healthStartedAt = Date.now();
      const healthResponse = await fetch(`${baseUrl}/health`);
      const busyHealth = await healthResponse.json();
      if (
        !healthResponse.ok ||
        Date.now() - healthStartedAt > 5000 ||
        busyHealth.resourceGovernance.activeProcessCount >
          busyHealth.resourceGovernance.processMaxConcurrency ||
        busyHealth.resourceGovernance.activeOcrProcessCount >
          busyHealth.resourceGovernance.ocrProcessMaxConcurrency ||
        busyHealth.resourceGovernance.activeAutoJobCount > 1
      ) {
        throw new Error('后台自动混剪运行时，健康检查或资源并发保护失效。');
      }
    }
    automatedLibrary = await request('/api/remix/library');
    automatedJob = automatedLibrary.automation.jobs.find(
      (item) => item.id === autoJob.id,
    );
    if (
      automatedJob?.latestRun?.status === 'awaiting_sources' &&
      automatedJob.readiness?.durationShortfallSeconds > 0 &&
      automatedJob.latestRun.stageReports.find(
        (report) => report.key === 'source_selection',
      )?.status === 'completed'
    ) {
      break;
    }
    await wait(500);
  }
  if (
    automatedJob?.latestRun?.status !== 'awaiting_sources' ||
    automatedJob.latestRun.generatedCount !== 0 ||
    automatedJob.latestRun.attemptedCount !== 0 ||
    automatedJob.readiness.approvedClipCount < 6 ||
    automatedJob.readiness.uniqueOpenerCount < 2 ||
    automatedJob.readiness.maxComposableDurationSeconds >= 30 ||
    automatedJob.readiness.durationShortfallSeconds <= 0 ||
    automatedJob.sourceSelectionLimit !== 1 ||
    automatedJob.scheduleEnabled !== false ||
    automatedJob.targetDurationSeconds !== 30 ||
    automatedJob.latestRun.targetDurationSeconds !== 30 ||
    !automatedJob.latestRun.selectedAssetIds.includes(
      automaticSourceAsset.id,
    ) ||
    automatedJob.latestRun.selectedSourceIds.length !== 1 ||
    automatedJob.latestRun.createdClipIds.length < 1 ||
    automatedJob.latestRun.recoveryCount < 1 ||
    !automatedJob.latestRun.lastRecoveryMessage.includes('自动') ||
    automaticSourceTimeoutRequests !== 3
  ) {
    throw new Error(
      `后台自动混剪没有自动退回不合格成片并进入补源续跑。${JSON.stringify(automatedJob)}`,
    );
  }
  const stageByKey = new Map(
    automatedJob.latestRun.stageReports.map((report) => [report.key, report]),
  );
  if (
    automatedJob.latestRun.stageReports.length !== 8 ||
    stageByKey.get('source_selection')?.status !== 'completed' ||
    stageByKey.get('source_slicing')?.status !== 'completed' ||
    stageByKey.get('clip_calibration')?.status !== 'completed' ||
    !['completed', 'partial'].includes(stageByKey.get('clip_review')?.status) ||
    stageByKey.get('remix_generation')?.status !== 'blocked' ||
    stageByKey.get('output_review')?.status !== 'pending' ||
    stageByKey.get('material_center_return')?.status !== 'pending' ||
    stageByKey.get('material_center_return')?.totalCount !== 3 ||
    stageByKey.get('qianchuan_delivery')?.status !== 'pending' ||
    stageByKey.get('qianchuan_delivery')?.totalCount !== 6 ||
    stageByKey.get('qianchuan_delivery')?.uploadedCount !== 0 ||
    stageByKey.get('qianchuan_delivery')?.boundCount !== 0 ||
    !stageByKey
      .get('source_selection')
      ?.evidence.some((item) => item.includes('历史效果保持“待核验”')) ||
    !stageByKey
      .get('source_slicing')
      ?.evidence.some((item) => item.includes('导入与识别'))
  ) {
    throw new Error(
      `八段自动化阶段状态或真实证据不完整。${JSON.stringify(
        automatedJob.latestRun.stageReports,
      )}`,
    );
  }
  const automaticClips = automatedJob.latestRun.createdClipIds
    .map((clipId) => automatedLibrary.clips.find((item) => item.id === clipId))
    .filter(Boolean);
  if (
    automaticClips.length !== automatedJob.latestRun.createdClipIds.length ||
    !automaticClips.every(
      (clip) =>
        clip.automaticAssessment?.mode === 'rules' &&
        clip.automaticAssessment?.boundaryIntegrity?.score >= 0 &&
        clip.automaticAssessment?.assessedAt,
    ) ||
    !automaticClips.some(
      (clip) =>
        clip.reviewStatus === 'approved' &&
        clip.automaticAssessment?.status === 'passed' &&
        clip.automaticAssessment?.autoApproved === true,
    ) ||
    !automaticClips.every(
      (clip) =>
        clip.automaticAssessment?.status !== 'passed' ||
        clip.reviewStatus === 'approved',
    )
  ) {
    throw new Error(
      `自动切片没有按完整边界自动入池或保留异常复核证据。${JSON.stringify(automaticClips)}`,
    );
  }
  const automatedRenders = automatedLibrary.renders.filter(
    (item) =>
      item.automation?.jobId === autoJob.id &&
      item.automation?.runId === automatedJob.latestRun.id,
  );
  const automatedVariants = automatedRenders.flatMap((render) =>
    render.variants.map((variant) => ({ render, variant })),
  );
  if (
    automatedRenders.length !== 0 ||
    automatedVariants.length !== 0 ||
    automatedJob.latestRun.attemptedCount !== 0 ||
    !automatedJob.latestRun.errorMessage.includes('最多可拼约')
  ) {
    throw new Error('自动任务没有在渲染前阻断注定短于目标时长的组合。');
  }
  const automatedOpeners = automatedVariants
    .filter(({ variant }) => variant.reviewStatus === 'approved')
    .map(({ variant }) => variant.clipSequence[0]);
  if (
    new Set(automatedOpeners).size !== automatedOpeners.length ||
    automatedVariants.some(({ variant }) =>
      variant.clipSequence.slice(1).includes(misplacedDramaClip.id),
    ) ||
    automatedVariants.some(
      ({ variant }) =>
        variant.clipSequence.slice(1).includes(clips[0].id) &&
        variant.clipSequence[0] !== clips[0].id,
    )
  ) {
    throw new Error('自动任务复用了同一开头，或把剧情演绎切片放进了中段。');
  }
  const autoReadback = await request('/api/remix/library');
  const autoJobReadback = autoReadback.automation.jobs.find(
    (item) => item.id === autoJob.id,
  );
  if (
    autoJobReadback?.latestRun?.reviewedCount !==
      autoJobReadback?.latestRun?.attemptedCount ||
    autoJobReadback.latestRun.approvedCount !== 0 ||
    autoJobReadback.latestRun.returnedCount !== 0 ||
    autoJobReadback.latestRun.qianchuanUploadedCount !== 0 ||
    autoJobReadback.latestRun.placedCount !== 0 ||
    qianchuanRecords.size !== 0
  ) {
    throw new Error('未通过自动成片审核的输出不应回传或进入千川。');
  }
  let missingBudgetBlocked = false;
  try {
    await request('/api/remix/automation/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '缺少预算护栏的危险任务',
        frameworkId: 'hook-pain-solution-proof-cta',
        productCategory: 'WIS隐形水润面膜',
        dailyTarget: 1,
        scheduleEnabled: false,
        targetDurationSeconds: 30,
        includeUsageDisclaimer: true,
        autoApproveOutputs: true,
        autoReturnAfterApproval: true,
        sourceSelectionLimit: 1,
        runImmediately: false,
        qianchuanDelivery: {
          enabled: true,
          confirmed: true,
          advertiserId: '1869672250595328',
          planId: '1870289794646204',
          planType: 'multiplication',
          dailyMaterialLimit: 1,
          dailySpendGuardYuan: null,
        },
      }),
    });
  } catch (error) {
    missingBudgetBlocked = String(error).includes('每日消耗护栏');
  }
  if (!missingBudgetBlocked) {
    throw new Error('未配置每日消耗护栏时，工作台仍允许开启真实千川投放。');
  }
  const recategorizedAutoJob = (
    await request(`/api/remix/automation/jobs/${autoJob.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productCategory: '黑晶面膜' }),
    })
  ).job;
  const restoredAutoJob = (
    await request(`/api/remix/automation/jobs/${autoJob.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productCategory: 'WIS隐形水润面膜' }),
    })
  ).job;
  if (
    recategorizedAutoJob.productCategory !== '黑晶面膜' ||
    restoredAutoJob.productCategory !== 'WIS隐形水润面膜'
  ) {
    throw new Error('已有自动任务无法补充或修改目标产品品类。');
  }
  const pausedAutoJob = (
    await request(`/api/remix/automation/jobs/${autoJob.id}/pause`, {
      method: 'POST',
    })
  ).job;
  const resumedAutoJob = (
    await request(`/api/remix/automation/jobs/${autoJob.id}/resume`, {
      method: 'POST',
    })
  ).job;
  if (
    pausedAutoJob.status !== 'paused' ||
    resumedAutoJob.status !== 'active' ||
    pausedAutoJob.nextRunAt !== null ||
    !resumedAutoJob.nextRunAt ||
    resumedAutoJob.scheduleEnabled !== false ||
    resumedAutoJob.latestRun?.id !== pausedAutoJob.latestRun?.id
  ) {
    throw new Error('恢复等待补源任务必须续跑原批次，不能改变定时开关或新建批次。');
  }
  const idleJob = (await request('/api/remix/automation/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '未启用定时的空闲任务', frameworkId: autoJob.frameworkId,
      productCategory: 'WIS隐形水润面膜', dailyTarget: 1,
      scheduleEnabled: false, runImmediately: false,
    }),
  })).job;
  await request(`/api/remix/automation/jobs/${idleJob.id}/pause`, { method: 'POST' });
  const idleResumed = (await request(`/api/remix/automation/jobs/${idleJob.id}/resume`, { method: 'POST' })).job;
  if (idleResumed.status !== 'active' || idleResumed.nextRunAt !== null || idleResumed.latestRun) {
    throw new Error('空闲任务未启用定时时，恢复不得创建日程或批次。');
  }
  const scheduledAutoJob = (
    await request(`/api/remix/automation/jobs/${autoJob.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scheduleEnabled: true,
        scheduleTime: '10:30',
        targetDurationSeconds: 90,
      }),
    })
  ).job;
  if (
    scheduledAutoJob.scheduleEnabled !== true ||
    scheduledAutoJob.scheduleTime !== '10:30' ||
    scheduledAutoJob.targetDurationSeconds !== 90 ||
    !scheduledAutoJob.nextRunAt
  ) {
    throw new Error('可选定时或自定义目标时长没有持久化。');
  }

  await request(`/api/remix/clips/${clips[3].id}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewStatus: 'changes_requested' }),
  });
  const blocked = await fetch(`${baseUrl}/api/remix/renders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '应被拦截',
      slots,
      productCategory: 'WIS隐形水润面膜',
    }),
  });
  const blockedBody = await blocked.json();
  if (
    blocked.status !== 400 ||
    !String(blockedBody.message || '').includes('审核通过')
  ) {
    throw new Error('退回切片没有阻止成片生成。');
  }

  const missingIntegrationToken = await fetch(
    `${baseUrl}/api/integrations/material-center/effective-clips/status?asset_id=${materialAsset.id}`,
  );
  if (missingIntegrationToken.status !== 401) {
    throw new Error('云管家切片联动接口缺少服务凭证时未拒绝。');
  }
  const importEffective = async () => {
    const response = await fetch(
      `${baseUrl}/api/integrations/material-center/effective-clips/import`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-WIS-Workstation-Token': materialCenterToken,
        },
        body: JSON.stringify({
          assetId: materialAsset.id,
          actorNumber: 'FD-EFFECTIVE',
          actorName: '有效素材测试同事',
        }),
      },
    );
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(
        `有效一创切片导入失败：${payload.message || response.status}`,
      );
    }
    return payload.status;
  };
  const effectiveImport = await importEffective();
  const effectiveImportRepeat = await importEffective();
  if (
    effectiveImport.state !== 'approved' ||
    effectiveImport.approvedCount < 1 ||
    effectiveImport.technicalAttentionCount !== 0 ||
    effectiveImportRepeat.clipCount !== effectiveImport.clipCount ||
    !effectiveImport.clips.every(
      (clip) =>
        clip.reviewStatus === 'approved' &&
        clip.approvalSource === 'material_center_effective' &&
        clip.automaticAssessment?.contentApprovalInherited === true,
    )
  ) {
    throw new Error('有效一创没有幂等继承内容审核或未通过自动技术门禁。');
  }
  const longEffectiveResponse = await fetch(
    `${baseUrl}/api/integrations/material-center/effective-clips/import`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-WIS-Workstation-Token': materialCenterToken,
      },
      body: JSON.stringify({
        assetId: longEffectiveAsset.id,
        actorNumber: 'FD-EFFECTIVE',
        actorName: '有效素材测试同事',
      }),
    },
  );
  const longEffectivePayload = await longEffectiveResponse.json();
  const longEffectiveImport = longEffectivePayload.status;
  if (
    !longEffectiveResponse.ok ||
    longEffectiveImport?.state !== 'approved' ||
    longEffectiveImport.clipCount !== 3 ||
    longEffectiveImport.clips.some(
      (clip) => clip.durationSeconds > 20 || clip.reviewStatus !== 'approved',
    )
  ) {
    throw new Error(
      `超过20秒的有效一创没有按完整语义段拆分并通过技术门禁：${JSON.stringify(longEffectivePayload)}`,
    );
  }

  const replenishmentLibrary = await request('/api/remix/library');
  const replenishmentApprovedCount = replenishmentLibrary.clips.filter(
    (clip) =>
      clip.productCategory === 'WIS隐形水润面膜' &&
      clip.reviewStatus === 'approved',
  ).length;
  const replenishmentResponse = await fetch(
    `${baseUrl}/api/integrations/material-center/clip-replenishment`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-WIS-Workstation-Token': materialCenterToken,
      },
      body: JSON.stringify({
        name: '整数秒切片补库验收',
        targets: [
          {
            productCategory: 'WIS隐形水润面膜',
            targetApprovedCount: replenishmentApprovedCount,
          },
        ],
      }),
    },
  );
  const replenishmentPayload = await replenishmentResponse.json();
  if (
    !replenishmentResponse.ok ||
    replenishmentPayload.job?.status !== 'completed' ||
    replenishmentPayload.job?.boundaryMode !==
      'integer-second-boundary-guard-v3'
  ) {
    throw new Error(
      `整数秒切片持久化补库任务未通过幂等验收：${JSON.stringify(replenishmentPayload)}`,
    );
  }

  clipReplenishmentListFailuresRemaining = 3;
  const resilientReplenishmentResponse = await fetch(
    `${baseUrl}/api/integrations/material-center/clip-replenishment`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-WIS-Workstation-Token': materialCenterToken,
      },
      body: JSON.stringify({
        name: '素材中心502容错验收',
        targets: [
          {
            productCategory: 'WIS隐形水润面膜',
            targetApprovedCount: replenishmentApprovedCount + 1,
          },
        ],
      }),
    },
  );
  const resilientReplenishmentPayload =
    await resilientReplenishmentResponse.json();
  let resilientReplenishmentJob = resilientReplenishmentPayload.job;
  const replenishmentDeadline = Date.now() + 180_000;
  while (Date.now() < replenishmentDeadline) {
    if (resilientReplenishmentJob?.status === 'completed') break;
    await wait(100);
    const statusResponse = await fetch(
      `${baseUrl}/api/integrations/material-center/clip-replenishment?job_id=${encodeURIComponent(resilientReplenishmentJob.id)}`,
      {
        headers: {
          'X-WIS-Workstation-Token': materialCenterToken,
        },
      },
    );
    resilientReplenishmentJob = (await statusResponse.json()).job;
  }
  const resilientHealthResponse = await fetch(`${baseUrl}/health`);
  if (
    !resilientReplenishmentResponse.ok ||
    resilientReplenishmentJob?.status !== 'completed' ||
    Number(resilientReplenishmentJob?.infrastructureFailureCount || 0) < 1 ||
    !resilientHealthResponse.ok ||
    worker.exitCode !== null
  ) {
    throw new Error(
      `素材中心502导致补库任务或主服务退出：${JSON.stringify(resilientReplenishmentJob)}；worker=${worker.exitCode}`,
    );
  }

  const supplyRunResponse = await fetch(
    `${baseUrl}/api/integrations/material-center/clip-supply/run-now`,
    {
      method: 'POST',
      headers: { 'X-WIS-Workstation-Token': materialCenterToken },
    },
  );
  const supplyRunPayload = await supplyRunResponse.json();
  let supplyReadback = null;
  let supplyJobReadback = supplyRunPayload.job;
  // A full source is analyzed, encoded and reviewed at the production CPU cap.
  const supplyDeadline = Date.now() + 180_000;
  while (Date.now() < supplyDeadline) {
    supplyReadback = (await request('/api/remix/library')).automation
      .clipSupply;
    const statusResponse = await fetch(
      `${baseUrl}/api/integrations/material-center/clip-replenishment?job_id=${encodeURIComponent(supplyRunPayload.job?.id || '')}`,
      { headers: { 'X-WIS-Workstation-Token': materialCenterToken } },
    );
    supplyJobReadback = (await statusResponse.json()).job;
    if (supplyReadback?.processedAssetCount >= 1) break;
    await wait(100);
  }
  const waterSupplyTarget = supplyJobReadback?.targets?.find(
    (target) => target.productCategory === 'WIS隐形水润面膜',
  );
  if (
    !supplyRunResponse.ok ||
    supplyReadback?.processedAssetCount < 1 ||
    supplyReadback?.approvedClipCount < 1 ||
    !waterSupplyTarget?.processedAssetIds?.includes(historicalSourceAsset.id) ||
    waterSupplyTarget?.processedAssetIds?.includes(
      recursiveAutoRemixSourceAsset.id,
    )
  ) {
    throw new Error(
      `24小时供应线没有处理新源素材，或错误地再次拆解自动混剪成片：${JSON.stringify({ supplyReadback, supplyJobReadback })}`,
    );
  }

  await fs.writeFile(
    path.join(artifactsDir, 'result.json'),
    JSON.stringify(
      {
        source,
        manualSource,
        recognition,
        folder,
        clips,
        render,
        firstReturn,
        autoJob: autoJobReadback,
        effectiveImport,
        longEffectiveImport,
        replenishmentJob: replenishmentPayload.job,
        resilientReplenishmentJob,
        continuousClipSupply: supplyReadback,
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(
    JSON.stringify({
      ok: true,
      sourceId: source.id,
      speechSegmentCount: analyzedSource.speechSegments.length,
      recognizedFrameworkSlotCount: recognition.slots.length,
      sharedFolderId: folder.id,
      nestedFolderId: childFolder.id,
      clipCount: clips.length,
      outputCount: render.variants.length,
      clipDimensions,
      outputDimensions,
      materialCenterSourceAssetId: source.materialCenterAssetId,
      returnedAssetId: firstReturn.assetId,
      returnUploadCount,
      automaticOutputCount: autoJobReadback.latestRun.generatedCount,
      automaticReturnedCount: autoJobReadback.latestRun.returnedCount,
      automaticSelectedAssetIds: autoJobReadback.latestRun.selectedAssetIds,
      automaticCreatedClipCount:
        autoJobReadback.latestRun.createdClipIds.length,
      automaticStageStatuses: Object.fromEntries(
        autoJobReadback.latestRun.stageReports.map((report) => [
          report.key,
          report.status,
        ]),
      ),
      crossProductGuard: true,
      effectiveClipImportCount: effectiveImport.clipCount,
      longEffectiveClipImportCount: longEffectiveImport.clipCount,
      replenishmentJobStatus: replenishmentPayload.job.status,
      artifactsDir,
    }),
  );
} finally {
  worker.kill();
  await new Promise((resolve) => materialCenterServer.close(resolve));
  await new Promise((resolve) => cutterServer.close(resolve));
}
