import { createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(workerRoot, '..');
const dataDir = path.join(workerRoot, 'artifacts', `security-${Date.now()}`);
const port = 8802;
const baseUrl = `http://127.0.0.1:${port}`;
const secret = 'wis-render-security-test-secret-32-characters';
const materialCenterToken = 'material-center-security-secret-32-characters';
const stablePrefix = '/fd-026222/wis-remix';
const stableStaticDir = path.join(dataDir, 'stable-client');
const oaPort = 8803;
const accessAuthorityPort = 8804;

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const createToken = ({ sub = 'security-user', name = '安全测试用户' } = {}) => {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'wis-workstation',
      aud: 'wis-render-worker',
      iat: issuedAt,
      exp: issuedAt + 300,
      jti: randomUUID(),
      sub,
      name,
    }),
    'utf8',
  ).toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
};

await fs.mkdir(stableStaticDir, { recursive: true });
const remixDataDir = path.join(dataDir, 'clip-remix');
const remixOutputsDir = path.join(remixDataDir, 'outputs');
await fs.mkdir(remixOutputsDir, { recursive: true });
await fs.writeFile(
  path.join(dataDir, 'clip-remix', 'library.json'),
  JSON.stringify({
    version: 7,
    frameworks: [],
    folders: [],
    sources: [
      {
        id: 'source-fixture',
        originalName: '身份隔离测试素材.mp4',
        storedName: 'source-fixture.mp4',
        size: 1024,
        durationSeconds: 1,
        hasAudio: true,
        tags: [],
        analysisStatus: 'not_started',
        analysisMessage: '',
        speechSegments: [],
        createdAt: '2026-08-18T00:00:00.000Z',
        createdById: 'FD-026222',
        createdByName: '覃琪琪',
        productCategory: '燕窝面膜',
      },
    ],
    renders: [
      {
        id: 'owner-render',
        name: '覃琪琪的成片',
        templateId: 'hook-pain-solution-proof-cta',
        createdById: 'FD-026222',
        createdByName: '覃琪琪',
        productCategory: '燕窝面膜',
        createdAt: '2026-08-18T00:00:00.000Z',
        variants: [
          {
            id: 'owner-variant',
            storedName: 'owner-output.mp4',
            outputName: '覃琪琪成片.mp4',
            slotMapping: {},
            reviewStatus: 'pending',
            reviewNote: '',
            reviewedAt: null,
            createdAt: '2026-08-18T00:00:00.000Z',
          },
        ],
      },
      {
        id: 'colleague-render',
        name: '用户B的成片',
        templateId: 'hook-pain-solution-proof-cta',
        createdById: 'FD-000002',
        createdByName: '用户B',
        productCategory: '燕窝面膜',
        createdAt: '2026-08-18T00:01:00.000Z',
        variants: [
          {
            id: 'colleague-variant',
            storedName: 'colleague-output.mp4',
            outputName: '用户B成片.mp4',
            slotMapping: {},
            reviewStatus: 'pending',
            reviewNote: '',
            reviewedAt: null,
            createdAt: '2026-08-18T00:01:00.000Z',
          },
        ],
      },
      {
        id: 'legacy-unowned-render',
        name: '无法确认制作人的历史成片',
        templateId: 'hook-pain-solution-proof-cta',
        productCategory: '燕窝面膜',
        createdAt: '2026-08-18T00:02:00.000Z',
        variants: [
          {
            id: 'legacy-variant',
            storedName: 'legacy-output.mp4',
            outputName: '历史成片.mp4',
            slotMapping: {},
            reviewStatus: 'pending',
            reviewNote: '',
            reviewedAt: null,
            createdAt: '2026-08-18T00:02:00.000Z',
          },
        ],
      },
    ],
    autoJobs: [
      {
        id: 'owner-auto-job',
        name: '覃琪琪自动混剪',
        frameworkId: 'hook-pain-solution-proof-cta',
        frameworkName: '固定叙事模板',
        productCategory: '燕窝面膜',
        status: 'active',
        dailyTarget: 1,
        scheduleTime: '09:00',
        timeZone: 'Asia/Shanghai',
        includeUsageDisclaimer: true,
        autoReturnAfterApproval: false,
        createdById: 'FD-026222',
        createdByName: '覃琪琪',
        createdAt: '2026-08-18T00:00:00.000Z',
        updatedAt: '2026-08-18T00:00:00.000Z',
        nextRunAt: '2099-08-18T01:00:00.000Z',
        lastRunAt: null,
        combinationCursor: 0,
        runs: [],
      },
      {
        id: 'owner-completed-auto-job',
        name: '覃琪琪已完成自动混剪',
        frameworkId: 'hook-pain-solution-proof-cta',
        frameworkName: '固定叙事模板',
        productCategory: '燕窝面膜',
        status: 'active',
        dailyTarget: 1,
        scheduleEnabled: false,
        scheduleTime: '09:00',
        timeZone: 'Asia/Shanghai',
        includeUsageDisclaimer: true,
        autoReturnAfterApproval: false,
        createdById: 'FD-026222',
        createdByName: '覃琪琪',
        createdAt: '2026-08-18T00:00:00.000Z',
        updatedAt: '2026-08-18T00:10:00.000Z',
        nextRunAt: null,
        lastRunAt: '2026-08-18T00:10:00.000Z',
        combinationCursor: 1,
        runs: [
          {
            id: 'owner-completed-run',
            dateKey: '2026-08-18',
            status: 'completed',
            targetCount: 1,
            targetDurationSeconds: 30,
            generatedCount: 1,
            failedCount: 0,
            renderIds: [],
            selectedAssetIds: [],
            selectedSourceIds: [],
            createdClipIds: [],
            stageReports: [],
            startedAt: '2026-08-18T00:00:00.000Z',
            completedAt: '2026-08-18T00:10:00.000Z',
            errorMessage: '',
          },
        ],
      },
      {
        id: 'owner-deletable-auto-job',
        name: '覃琪琪可删除自动混剪',
        frameworkId: 'hook-pain-solution-proof-cta',
        frameworkName: '固定叙事模板',
        productCategory: '燕窝面膜',
        status: 'active',
        dailyTarget: 1,
        scheduleEnabled: false,
        scheduleTime: '09:00',
        timeZone: 'Asia/Shanghai',
        includeUsageDisclaimer: true,
        autoReturnAfterApproval: false,
        createdById: 'FD-026222',
        createdByName: '覃琪琪',
        createdAt: '2026-08-18T00:00:00.000Z',
        updatedAt: '2026-08-18T00:10:00.000Z',
        nextRunAt: null,
        lastRunAt: '2026-08-18T00:10:00.000Z',
        combinationCursor: 1,
        runs: [
          {
            id: 'owner-deletable-run',
            dateKey: '2026-08-18',
            status: 'completed',
            targetCount: 1,
            targetDurationSeconds: 30,
            generatedCount: 1,
            failedCount: 0,
            renderIds: [],
            selectedAssetIds: [],
            selectedSourceIds: [],
            createdClipIds: [],
            stageReports: [],
            startedAt: '2026-08-18T00:00:00.000Z',
            completedAt: '2026-08-18T00:10:00.000Z',
            errorMessage: '',
          },
        ],
      },
    ],
    autoRemixGrants: [
      {
        userId: 'FD-000003',
        userName: '历史授权用户',
        grantedAt: '2026-08-18T00:00:00.000Z',
        grantedById: 'FD-026222',
        grantedByName: '覃琪琪',
      },
    ],
    clips: [
      {
        id: 'owned-clip',
        sourceId: 'source-fixture',
        storedName: 'owned-clip.mp4',
        name: '身份隔离测试切片',
        role: 'hook',
        tags: [],
        startSeconds: 0,
        endSeconds: 1,
        durationSeconds: 1,
        reviewStatus: 'approved',
        reviewNote: '',
        createdAt: '2026-08-18T00:00:00.000Z',
        reviewedAt: '2026-08-18T00:00:00.000Z',
        folderId: null,
        createdByIds: ['FD-026222'],
        createdByNames: ['覃琪琪'],
        productCategory: '燕窝面膜',
      },
    ],
  }),
  'utf8',
);
await Promise.all(
  ['owner-output.mp4', 'colleague-output.mp4', 'legacy-output.mp4'].map(
    (fileName) => fs.writeFile(path.join(remixOutputsDir, fileName), 'video'),
  ),
);
await fs.writeFile(
  path.join(stableStaticDir, 'index.html'),
  '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
  'utf8',
);
let lastPasswordGrantPayload = null;
const oaServer = http.createServer(async (request, response) => {
  if (
    request.method === 'POST' &&
    request.url === '/authentication/password-grant'
  ) {
    let rawBody = '';
    for await (const chunk of request) rawBody += chunk;
    lastPasswordGrantPayload = JSON.parse(rawBody || '{}');
    const valid =
      lastPasswordGrantPayload.username === 'FD-TEST' &&
      lastPasswordGrantPayload.password === 'correct-password';
    const captchaRequired = lastPasswordGrantPayload.username === 'FD-CAPTCHA';
    response.writeHead(valid ? 200 : 401, {
      'Content-Type': 'application/json; charset=utf-8',
      ...(valid ? { Authorization: 'Bearer valid-oa-token' } : {}),
    });
    response.end(
      JSON.stringify(
        valid ? { code: 0 } : { code: captchaRequired ? 400 : 401 },
      ),
    );
    return;
  }
  if (request.method === 'POST' && request.url === '/authentication/captcha') {
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify({ code: 0, msg: '验证码已发送' }));
    return;
  }
  const token = String(request.headers.authorization || '').replace(
    /^Bearer\s+/iu,
    '',
  );
  const users = {
    'valid-oa-token': {
      number: 'FD-TEST',
      realName: '稳定入口测试用户',
      groupName: '品牌营销部',
      status: 'normal',
    },
    'wrong-department-token': {
      number: 'FD-OTHER',
      realName: '其他部门用户',
      groupName: '其他部门',
      status: 'normal',
    },
    'second-department-token': {
      number: 'FD-WIS',
      realName: 'WIS 品牌中心用户',
      groupName: '品牌管理部-WIS品牌中心',
      status: 'normal',
    },
    'explicit-user-token': {
      number: 'FD-EXPLICIT',
      realName: '例外授权用户',
      groupName: '其他部门',
      status: 'normal',
    },
    'abnormal-user-token': {
      number: 'FD-FROZEN',
      realName: '冻结用户',
      groupName: '品牌营销部',
      status: 'frozen',
    },
  };
  const user = users[token];
  response.writeHead(user ? 200 : 401, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(user ? { code: 0, data: user } : { code: 401 }));
});
await new Promise((resolve, reject) => {
  oaServer.once('error', reject);
  oaServer.listen(oaPort, '127.0.0.1', resolve);
});
const authorityUsers = {
  'valid-oa-token': {
    number: 'FD-TEST',
    realName: '稳定入口测试用户',
    groupName: '品牌营销部',
    status: 'normal',
  },
  'second-department-token': {
    number: 'FD-WIS',
    realName: 'WIS 品牌中心用户',
    groupName: '品牌管理部-WIS品牌中心',
    status: 'normal',
  },
  'explicit-user-token': {
    number: 'FD-EXPLICIT',
    realName: '例外授权用户',
    groupName: '其他部门',
    status: 'normal',
  },
  'yang-wen-token': {
    number: 'FD-YANGWEN',
    realName: '杨雯',
    groupName: '品牌创意中心',
    status: 'normal',
  },
};
let authorityRequestCount = 0;
let transientAuthorityRequestCount = 0;
const accessAuthorityServer = http.createServer((request, response) => {
  authorityRequestCount += 1;
  const serviceToken = String(request.headers['x-wis-workstation-token'] || '');
  const oaToken = String(request.headers['x-oa-token'] || '');
  if (serviceToken !== materialCenterToken) {
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ detail: 'invalid workstation token' }));
    return;
  }
  if (oaToken === 'authority-error-token') {
    response.writeHead(503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ detail: 'authority unavailable' }));
    return;
  }
  if (oaToken === 'authority-transient-token') {
    transientAuthorityRequestCount += 1;
    if (transientAuthorityRequestCount < 3) {
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ detail: 'transient authority outage' }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        allowed: true,
        authority: 'wis-video-center',
        user: authorityUsers['valid-oa-token'],
      }),
    );
    return;
  }
  const user = authorityUsers[oaToken];
  if (!user) {
    response.writeHead(oaToken === 'expired-oa-token' ? 401 : 403, {
      'Content-Type': 'application/json',
    });
    response.end(JSON.stringify({ detail: 'not allowed' }));
    return;
  }
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(
    JSON.stringify({
      allowed: true,
      authority: 'wis-video-center',
      user,
    }),
  );
});
await new Promise((resolve, reject) => {
  accessAuthorityServer.once('error', reject);
  accessAuthorityServer.listen(accessAuthorityPort, '127.0.0.1', resolve);
});
const worker = spawn(process.execPath, [path.join(workerRoot, 'server.mjs')], {
  cwd: projectRoot,
  windowsHide: true,
  env: {
    ...process.env,
    RENDER_WORKER_PORT: String(port),
    RENDER_WORKER_DATA_DIR: dataDir,
    RENDER_WORKER_SHARED_SECRET: secret,
    RENDER_WORKER_PUBLIC_URL: 'https://worker.example.test',
    STABLE_APP_PUBLIC_PREFIX: stablePrefix,
    STABLE_APP_STATIC_DIR: stableStaticDir,
    OA_API_BASE_URL: `http://127.0.0.1:${oaPort}`,
    OA_CLIENT_ID: 'oa-client-security-test',
    OA_CLIENT_SECRET: 'oa-client-security-secret',
    OA_GRANT_TYPE: 'password',
    OA_ACCESS_AUTHORITY_URL: `http://127.0.0.1:${accessAuthorityPort}`,
    AUTO_REMIX_ADMIN_USERS: 'FD-026222,覃琪琪',
    WIS_MATERIAL_CENTER_BASE_URL: 'http://127.0.0.1:65534/api/workstation',
    WIS_MATERIAL_CENTER_TOKEN: materialCenterToken,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let logs = '';
for (const stream of [worker.stdout, worker.stderr]) {
  stream.on('data', (chunk) => {
    logs = (logs + chunk.toString()).slice(-8000);
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
  if (!health?.authRequired) {
    throw new Error(`渲染鉴权未启用。${logs}`);
  }
  if (!health.stableAppConfigured) {
    throw new Error('稳定工作台入口未完成配置。');
  }
  if (!health.stableAccessAuthorityConfigured) {
    throw new Error('稳定工作台未接入云管家实时登录权限。');
  }
  if (!health.stablePasswordLoginConfigured) {
    throw new Error('稳定工作台工号密码登录未完成配置。');
  }
  if (
    !health.capabilities?.materialCenterBidirectional ||
    !health.capabilities?.cutterRecognition ||
    !health.capabilities?.localSubtitleOcr ||
    JSON.stringify(health).includes(materialCenterToken)
  ) {
    throw new Error('素材中心能力状态不正确或健康检查泄露了服务令牌。');
  }

  const preflight = await fetch(
    `${baseUrl}/api/remix/sources/example/segments/example`,
    {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://workbench.example.test',
        'Access-Control-Request-Method': 'PATCH',
      },
    },
  );
  if (
    !String(
      preflight.headers.get('access-control-allow-methods') || '',
    ).includes('PATCH') ||
    !String(
      preflight.headers.get('access-control-allow-methods') || '',
    ).includes('DELETE')
  ) {
    throw new Error('跨域预检未允许PATCH或DELETE。');
  }

  const noToken = await fetch(`${baseUrl}/api/jobs/${randomUUID()}`);
  if (noToken.status !== 401) throw new Error('缺少令牌时未返回401。');
  const materialCenterNoToken = await fetch(
    `${baseUrl}/api/remix/material-center/assets`,
  );
  if (materialCenterNoToken.status !== 401) {
    throw new Error('素材中心代理接口缺少工作台令牌时未返回401。');
  }

  const badToken = await fetch(`${baseUrl}/api/jobs/${randomUUID()}`, {
    headers: { Authorization: 'Bearer invalid-token' },
  });
  if (badToken.status !== 401) throw new Error('无效令牌未被拒绝。');

  const validToken = await fetch(`${baseUrl}/api/jobs/${randomUUID()}`, {
    headers: { Authorization: `Bearer ${createToken()}` },
  });
  if (validToken.status !== 404) throw new Error('有效令牌未通过鉴权。');

  const stableWithoutOa = await fetch(`${baseUrl}/`, {
    headers: { 'X-Forwarded-Prefix': stablePrefix },
  });
  const loginHtml = await stableWithoutOa.text();
  if (
    stableWithoutOa.status !== 200 ||
    !loginHtml.includes('OA 工号') ||
    loginHtml.includes('__WIS_RENDER_WORKER_SESSION__')
  ) {
    throw new Error('稳定入口未安全显示 OA 登录页。');
  }
  const stableWrongDepartment = await fetch(`${baseUrl}/`, {
    headers: {
      'X-Forwarded-Prefix': stablePrefix,
      'X-OA-Token': 'wrong-department-token',
    },
  });
  if (stableWrongDepartment.status !== 403) {
    throw new Error('稳定入口未拒绝无权限部门。');
  }
  const stableSecondDepartment = await fetch(`${baseUrl}/`, {
    headers: {
      'X-Forwarded-Prefix': stablePrefix,
      'X-OA-Token': 'second-department-token',
    },
  });
  if (!stableSecondDepartment.ok) {
    throw new Error('稳定入口未允许云管家配置的 WIS 品牌中心部门。');
  }
  const stableExplicitUser = await fetch(`${baseUrl}/`, {
    headers: {
      'X-Forwarded-Prefix': stablePrefix,
      'X-OA-Token': 'explicit-user-token',
    },
  });
  if (!stableExplicitUser.ok) {
    throw new Error('稳定入口未允许例外授权用户。');
  }
  const stableYangWen = await fetch(`${baseUrl}/`, {
    headers: {
      'X-Forwarded-Prefix': stablePrefix,
      'X-OA-Token': 'yang-wen-token',
    },
  });
  if (!stableYangWen.ok) {
    throw new Error('稳定入口未允许云管家动态授权的杨雯账号。');
  }
  const stableRevokedUser = await fetch(`${baseUrl}/`, {
    headers: {
      'X-Forwarded-Prefix': stablePrefix,
      'X-OA-Token': 'revoked-user-token',
    },
  });
  if (stableRevokedUser.status !== 403) {
    throw new Error('稳定入口未实时拒绝云管家已撤权用户。');
  }
  const stableAuthorityUnavailable = await fetch(`${baseUrl}/`, {
    headers: {
      'X-Forwarded-Prefix': stablePrefix,
      'X-OA-Token': 'authority-error-token',
    },
  });
  if (stableAuthorityUnavailable.status !== 503) {
    throw new Error('云管家权限服务异常时稳定入口未安全拒绝。');
  }
  const stableAbnormalUser = await fetch(`${baseUrl}/`, {
    headers: {
      'X-Forwarded-Prefix': stablePrefix,
      'X-OA-Token': 'abnormal-user-token',
    },
  });
  if (stableAbnormalUser.status !== 403) {
    throw new Error('稳定入口未拒绝状态异常的 OA 账号。');
  }

  const passwordLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-Prefix': stablePrefix,
    },
    body: JSON.stringify({
      username: 'fd-test',
      password: 'correct-password',
    }),
  });
  const passwordCookie = passwordLogin.headers.get('set-cookie') || '';
  if (
    !passwordLogin.ok ||
    !passwordCookie.includes('wis_oa_session=') ||
    !passwordCookie.includes('HttpOnly') ||
    !passwordCookie.includes('Secure') ||
    !passwordCookie.includes('SameSite=Lax') ||
    lastPasswordGrantPayload?.client_id !== 'oa-client-security-test' ||
    lastPasswordGrantPayload?.client_secret !== 'oa-client-security-secret' ||
    lastPasswordGrantPayload?.grant_type !== 'password'
  ) {
    throw new Error('OA 工号密码登录、客户端字段或安全会话 Cookie 不正确。');
  }
  const passwordSessionCookie = passwordCookie.split(';', 1)[0];
  const stablePasswordPage = await fetch(`${baseUrl}/`, {
    headers: {
      Cookie: passwordSessionCookie,
      'X-Forwarded-Prefix': stablePrefix,
    },
  });
  if (
    !stablePasswordPage.ok ||
    !(await stablePasswordPage.text()).includes('__WIS_RENDER_WORKER_SESSION__')
  ) {
    throw new Error('OA 工号密码会话无法进入稳定工作台。');
  }
  const captchaRequired = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-Prefix': stablePrefix,
    },
    body: JSON.stringify({
      username: 'FD-CAPTCHA',
      password: 'requires-captcha',
    }),
  });
  if (captchaRequired.status !== 428) {
    throw new Error('OA 要求验证码时未返回可识别状态。');
  }
  const captchaResponse = await fetch(`${baseUrl}/api/auth/captcha`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-Prefix': stablePrefix,
    },
    body: JSON.stringify({ username: 'FD-CAPTCHA' }),
  });
  if (
    !captchaResponse.ok ||
    !(await captchaResponse.json()).message.includes('验证码已发送')
  ) {
    throw new Error('OA 登录验证码发送流程无效。');
  }
  const unifiedCallback = await fetch(`${baseUrl}/auth/unified`, {
    redirect: 'manual',
    headers: {
      'X-Forwarded-Prefix': stablePrefix,
      'X-OA-Token': 'valid-oa-token',
    },
  });
  if (
    unifiedCallback.status !== 303 ||
    unifiedCallback.headers.get('location') !== `${stablePrefix}/` ||
    !String(unifiedCallback.headers.get('set-cookie') || '').includes(
      'wis_oa_session=',
    )
  ) {
    throw new Error('统一 OA/飞书登录回调未建立工作台会话。');
  }
  const transientUnifiedCallback = await fetch(`${baseUrl}/auth/unified`, {
    redirect: 'manual',
    headers: {
      'X-Forwarded-Prefix': stablePrefix,
      'X-OA-Token': 'authority-transient-token',
    },
  });
  if (
    transientUnifiedCallback.status !== 303 ||
    transientAuthorityRequestCount !== 3
  ) {
    throw new Error('统一登录没有在权限服务短暂异常后自动重试成功。');
  }
  const failedUnifiedCallback = await fetch(`${baseUrl}/auth/unified`, {
    redirect: 'manual',
    headers: {
      'X-Forwarded-Prefix': stablePrefix,
      'X-OA-Token': 'authority-error-token',
    },
  });
  const failedUnifiedHtml = await failedUnifiedCallback.text();
  if (
    failedUnifiedCallback.status !== 503 ||
    !String(failedUnifiedCallback.headers.get('content-type') || '').includes(
      'text/html',
    ) ||
    !failedUnifiedHtml.includes('系统已自动重试') ||
    failedUnifiedHtml.trim().startsWith('{')
  ) {
    throw new Error('统一登录持续异常时仍返回裸 JSON 或缺少可重试登录页。');
  }
  const logoutResponse = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { 'X-Forwarded-Prefix': stablePrefix },
  });
  if (
    !logoutResponse.ok ||
    !String(logoutResponse.headers.get('set-cookie') || '').includes(
      'Max-Age=0',
    )
  ) {
    throw new Error('稳定入口退出登录未清除会话。');
  }
  const stablePage = await fetch(`${baseUrl}/`, {
    headers: {
      'X-Forwarded-Prefix': stablePrefix,
      'X-OA-Token': 'valid-oa-token',
    },
  });
  const stableHtml = await stablePage.text();
  if (!stablePage.ok || !stableHtml.includes('__WIS_RENDER_WORKER_SESSION__')) {
    throw new Error('稳定入口未注入短期渲染会话。');
  }
  const sessionMatch = stableHtml.match(
    /window\.__WIS_RENDER_WORKER_SESSION__=(\{.*?\});<\/script>/u,
  );
  const stableSession = sessionMatch ? JSON.parse(sessionMatch[1]) : null;
  if (
    !stableSession?.accessToken ||
    stableSession.workerBaseUrl !== 'https://worker.example.test' ||
    stableSession.stableApp?.user?.id !== 'FD-TEST' ||
    stableSession.stableApp?.logoutUrl !== `${stablePrefix}/api/auth/logout`
  ) {
    throw new Error('稳定入口生成的渲染会话或 OA 用户信息无效。');
  }
  const stableLibrary = await fetch(`${baseUrl}/api/remix/library`, {
    headers: { Authorization: `Bearer ${stableSession.accessToken}` },
  });
  if (!stableLibrary.ok) {
    throw new Error('稳定入口签发的短期令牌无法访问渲染服务。');
  }

  const renewedSessionResponse = await fetch(
    `${baseUrl}/api/workstation/render-session`,
    {
      headers: {
        'X-Forwarded-Prefix': stablePrefix,
        'X-OA-Token': 'valid-oa-token',
      },
    },
  );
  const renewedSession = await renewedSessionResponse.json();
  if (
    !renewedSessionResponse.ok ||
    !renewedSession?.accessToken ||
    renewedSession?.stableApp?.user?.id !== 'FD-TEST' ||
    renewedSessionResponse.headers.get('cache-control') !== 'no-store'
  ) {
    throw new Error('稳定入口无法自动续签短期渲染会话。');
  }
  const anonymousRenewal = await fetch(
    `${baseUrl}/api/workstation/render-session`,
    { headers: { 'X-Forwarded-Prefix': stablePrefix } },
  );
  if (anonymousRenewal.status !== 401) {
    throw new Error('渲染会话续签接口未拒绝未登录访问。');
  }

  const ownerToken = createToken({ sub: 'FD-026222', name: '覃琪琪' });
  const colleagueToken = createToken({ sub: 'FD-000002', name: '用户B' });

  const [ownerLibraryResponse, colleagueLibraryResponse] = await Promise.all([
    fetch(`${baseUrl}/api/remix/library`, {
      headers: {
        Authorization: `Bearer ${ownerToken}`,
      },
    }),
    fetch(`${baseUrl}/api/remix/library`, {
      headers: {
        Authorization: `Bearer ${colleagueToken}`,
      },
    }),
  ]);
  const [ownerLibrary, colleagueLibrary] = await Promise.all([
    ownerLibraryResponse.json(),
    colleagueLibraryResponse.json(),
  ]);
  const ownerClip = ownerLibrary.clips?.find(
    (clip) => clip.id === 'owned-clip',
  );
  const colleagueClip = colleagueLibrary.clips?.find(
    (clip) => clip.id === 'owned-clip',
  );
  if (
    ownerClip?.isMine !== true ||
    colleagueClip?.isMine !== false ||
    !colleagueClip ||
    'createdByIds' in ownerClip
  ) {
    throw new Error('“我的切片”身份隔离、全部切片共享或用户ID脱敏失败。');
  }
  if (
    ownerLibrary.automation?.jobs?.[0]?.id !== 'owner-auto-job' ||
    colleagueLibrary.automation?.jobs?.length !== 0 ||
    'createdById' in ownerLibrary.automation.jobs[0] ||
    ownerLibrary.permissions?.autoRemix?.isAdmin !== true ||
    colleagueLibrary.permissions?.autoRemix?.canUse !== false ||
    ownerLibrary.permissions.autoRemix.grants?.[0]?.verified !== false
  ) {
    throw new Error('自动混剪计划没有按登录人隔离或暴露了内部用户ID。');
  }
  if (
    ownerLibrary.renders?.length !== 1 ||
    ownerLibrary.renders[0]?.id !== 'owner-render' ||
    ownerLibrary.renders[0]?.isMine !== true ||
    'createdById' in ownerLibrary.renders[0] ||
    colleagueLibrary.renders?.length !== 1 ||
    colleagueLibrary.renders[0]?.id !== 'colleague-render' ||
    colleagueLibrary.renders[0]?.isMine !== true ||
    ownerLibrary.renders.some(
      (render) => render.id === 'legacy-unowned-render',
    ) ||
    colleagueLibrary.renders.some(
      (render) => render.id === 'legacy-unowned-render',
    )
  ) {
    throw new Error(
      '成片列表没有按登录人隔离，或未确认制作人的历史成片未隐藏。',
    );
  }

  const colleagueReviewOwnerRender = await fetch(
    `${baseUrl}/api/remix/renders/owner-render/variants/owner-variant/review`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${colleagueToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reviewStatus: 'approved', reviewNote: '' }),
    },
  );
  const colleagueReadOwnerRender = await fetch(
    `${baseUrl}/api/remix/media/output/owner-render/owner-variant`,
    { headers: { Authorization: `Bearer ${colleagueToken}` } },
  );
  const colleagueReturnOwnerRender = await fetch(
    `${baseUrl}/api/remix/renders/owner-render/variants/owner-variant/return-to-material-center`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${colleagueToken}` },
    },
  );
  const ownerReviewOwnRender = await fetch(
    `${baseUrl}/api/remix/renders/owner-render/variants/owner-variant/review`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reviewStatus: 'approved', reviewNote: '' }),
    },
  );
  const ownerReadOwnRender = await fetch(
    `${baseUrl}/api/remix/media/output/owner-render/owner-variant`,
    { headers: { Authorization: `Bearer ${ownerToken}` } },
  );
  if (
    colleagueReviewOwnerRender.status !== 403 ||
    colleagueReadOwnerRender.status !== 404 ||
    colleagueReturnOwnerRender.status !== 403 ||
    !ownerReviewOwnRender.ok ||
    !ownerReadOwnRender.ok
  ) {
    throw new Error('成片预览、下载、审核或回传接口未完整校验制作人。');
  }
  const colleagueAutoControl = await fetch(
    `${baseUrl}/api/remix/automation/jobs/owner-auto-job/pause`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${colleagueToken}` },
    },
  );
  const ownerAutoControl = await fetch(
    `${baseUrl}/api/remix/automation/jobs/owner-auto-job/pause`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
    },
  );
  if (colleagueAutoControl.ok || !ownerAutoControl.ok) {
    throw new Error('自动混剪计划的控制权限没有按创建人隔离。');
  }
  const colleagueCleanupOwnerJob = await fetch(
    `${baseUrl}/api/remix/automation/jobs/cleanup`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${colleagueToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jobIds: ['owner-completed-auto-job'] }),
    },
  );
  const ownerCleanupUnfinishedJob = await fetch(
    `${baseUrl}/api/remix/automation/jobs/cleanup`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jobIds: ['owner-auto-job'] }),
    },
  );
  const ownerCleanupCompletedJob = await fetch(
    `${baseUrl}/api/remix/automation/jobs/cleanup`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jobIds: ['owner-completed-auto-job'] }),
    },
  );
  const ownerLibraryAfterCleanup = await (
    await fetch(`${baseUrl}/api/remix/library`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    })
  ).json();
  if (
    colleagueCleanupOwnerJob.ok ||
    ownerCleanupUnfinishedJob.ok ||
    !ownerCleanupCompletedJob.ok ||
    ownerLibraryAfterCleanup.automation.jobs.some(
      (job) => job.id === 'owner-completed-auto-job',
    )
  ) {
    throw new Error('已完成自动计划的归档清理、完成态限制或身份隔离失效。');
  }
  const colleagueDeleteOwnerJob = await fetch(
    `${baseUrl}/api/remix/automation/jobs/owner-deletable-auto-job`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${colleagueToken}` },
    },
  );
  const ownerDeleteUnfinishedJob = await fetch(
    `${baseUrl}/api/remix/automation/jobs/owner-auto-job`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerToken}` },
    },
  );
  const ownerDeleteCompletedJob = await fetch(
    `${baseUrl}/api/remix/automation/jobs/owner-deletable-auto-job`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerToken}` },
    },
  );
  const ownerLibraryAfterDelete = await (
    await fetch(`${baseUrl}/api/remix/library`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    })
  ).json();
  if (
    colleagueDeleteOwnerJob.ok ||
    ownerDeleteUnfinishedJob.ok ||
    !ownerDeleteCompletedJob.ok ||
    ownerLibraryAfterDelete.automation.jobs.some(
      (job) => job.id === 'owner-deletable-auto-job',
    )
  ) {
    throw new Error('已完成自动计划的永久删除、完成态限制或身份隔离失效。');
  }
  const fakeGrantResponse = await fetch(
    `${baseUrl}/api/remix/automation/access/grants`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId: 'FD-999999' }),
    },
  );
  const grantResponse = await fetch(
    `${baseUrl}/api/remix/automation/access/grants`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: 'FD-000002',
        userName: '伪造姓名不得写入',
      }),
    },
  );
  const grantPayload = await grantResponse.json();
  const colleagueAfterGrant = await (
    await fetch(`${baseUrl}/api/remix/library`, {
      headers: { Authorization: `Bearer ${colleagueToken}` },
    })
  ).json();
  const revokeResponse = await fetch(
    `${baseUrl}/api/remix/automation/access/grants/FD-000002`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerToken}` },
    },
  );
  const colleagueAfterRevoke = await (
    await fetch(`${baseUrl}/api/remix/library`, {
      headers: { Authorization: `Bearer ${colleagueToken}` },
    })
  ).json();
  const migratedLibrary = JSON.parse(
    await fs.readFile(path.join(remixDataDir, 'library.json'), 'utf8'),
  );
  if (
    fakeGrantResponse.status !== 409 ||
    !grantResponse.ok ||
    grantPayload.access?.grants?.find((grant) => grant.userId === 'FD-000002')
      ?.userName !== '用户B' ||
    grantPayload.access?.grants?.find((grant) => grant.userId === 'FD-000002')
      ?.verified !== true ||
    colleagueAfterGrant.permissions?.autoRemix?.canUse !== true ||
    colleagueAfterGrant.permissions?.autoRemix?.isAdmin !== false ||
    colleagueAfterGrant.permissions?.autoRemix?.grants?.length !== 0 ||
    !revokeResponse.ok ||
    colleagueAfterRevoke.permissions?.autoRemix?.canUse !== false ||
    migratedLibrary.version !== 10
  ) {
    throw new Error('自动混剪白名单授权、脱敏、收回或旧库迁移失败。');
  }

  const createPersonalFolder = async (token, name) => {
    const response = await fetch(`${baseUrl}/api/remix/folders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name }),
    });
    return { response, payload: await response.json() };
  };
  const [ownerFolderResult, colleagueFolderResult] = await Promise.all([
    createPersonalFolder(ownerToken, '个人目录'),
    createPersonalFolder(colleagueToken, '个人目录'),
  ]);
  if (
    !ownerFolderResult.response.ok ||
    !colleagueFolderResult.response.ok ||
    ownerFolderResult.payload.folder?.id ===
      colleagueFolderResult.payload.folder?.id
  ) {
    throw new Error('不同用户的同名个人文件夹没有独立保存。');
  }
  const ownerFolderId = ownerFolderResult.payload.folder.id;
  const colleagueFolderId = colleagueFolderResult.payload.folder.id;
  const ownerCategorize = await fetch(
    `${baseUrl}/api/remix/clips/owned-clip/folder`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ folderId: ownerFolderId }),
    },
  );
  const colleagueAfterOwnerCategorize = await (
    await fetch(`${baseUrl}/api/remix/library`, {
      headers: { Authorization: `Bearer ${colleagueToken}` },
    })
  ).json();
  if (
    !ownerCategorize.ok ||
    colleagueAfterOwnerCategorize.folders?.some(
      (folder) => folder.id === ownerFolderId,
    ) ||
    colleagueAfterOwnerCategorize.clips?.find(
      (clip) => clip.id === 'owned-clip',
    )?.folderId
  ) {
    throw new Error('个人文件夹或个人归类结果泄露给了其他用户。');
  }
  const colleagueCategorize = await fetch(
    `${baseUrl}/api/remix/clips/owned-clip/folder`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${colleagueToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ folderId: colleagueFolderId }),
    },
  );
  const ownerReadbackAfterBoth = await (
    await fetch(`${baseUrl}/api/remix/library`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    })
  ).json();
  const colleagueReadbackAfterBoth = await (
    await fetch(`${baseUrl}/api/remix/library`, {
      headers: { Authorization: `Bearer ${colleagueToken}` },
    })
  ).json();
  if (
    !colleagueCategorize.ok ||
    ownerReadbackAfterBoth.clips?.find((clip) => clip.id === 'owned-clip')
      ?.folderId !== ownerFolderId ||
    colleagueReadbackAfterBoth.clips?.find((clip) => clip.id === 'owned-clip')
      ?.folderId !== colleagueFolderId ||
    'folderAssignments' in
      ownerReadbackAfterBoth.clips.find((clip) => clip.id === 'owned-clip') ||
    'folderAssignments' in
      colleagueReadbackAfterBoth.clips.find((clip) => clip.id === 'owned-clip')
  ) {
    throw new Error(
      '同一共享切片无法按用户独立归入个人文件夹，或内部归类身份被暴露。',
    );
  }

  const ownerClipMetadata = await fetch(
    `${baseUrl}/api/remix/clips/owned-clip/metadata`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: '已重命名切片', tags: ['已验证'] }),
    },
  );
  const colleagueClipMetadata = await fetch(
    `${baseUrl}/api/remix/clips/owned-clip/metadata`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${colleagueToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: '越权修改', tags: [] }),
    },
  );
  const ownerSourceMetadata = await fetch(
    `${baseUrl}/api/remix/sources/source-fixture/metadata`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: '已重命名素材.mp4', tags: ['口播'] }),
    },
  );
  const colleagueSourceMetadata = await fetch(
    `${baseUrl}/api/remix/sources/source-fixture/metadata`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${colleagueToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: '越权修改.mp4', tags: [] }),
    },
  );
  if (
    !ownerClipMetadata.ok ||
    colleagueClipMetadata.status !== 403 ||
    !ownerSourceMetadata.ok ||
    colleagueSourceMetadata.status !== 403
  ) {
    throw new Error('素材或切片重命名与标签权限校验失败。');
  }

  console.log(
    JSON.stringify({
      ok: true,
      authRequired: true,
      corsPatchAllowed: true,
      corsDeleteAllowed: true,
      myClipsIdentityIsolation: true,
      personalFolderIsolation: true,
      metadataOwnership: true,
      autoRemixJobIsolation: true,
      autoCompletedPlanCleanup: true,
      autoCompletedPlanDeletion: true,
      autoRemixWhitelist: true,
      autoRemixOaIdentityVerification: true,
      librarySchemaMigration: true,
      personalOutputIsolation: true,
      renderSessionRenewal: true,
      stableOaEntry: true,
      stablePasswordLogin: true,
      stableUnifiedLogin: true,
      stableOaPolicyAligned: authorityRequestCount > 0,
      sharedAccessAuthority: true,
      dynamicGrantAndRevocation: true,
    }),
  );
} finally {
  worker.kill();
  await new Promise((resolve) => oaServer.close(resolve));
  await new Promise((resolve) => accessAuthorityServer.close(resolve));
}
