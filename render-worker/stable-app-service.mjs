import { createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mp4', 'video/mp4'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

const SESSION_COOKIE = 'wis_oa_session';
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
const MAX_AUTH_BODY_BYTES = 16 * 1024;
const AUTHORITY_RETRY_DELAYS_MS = [0, 250, 750];

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const pipeFileToResponse = (req, res, filePath) =>
  new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
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

class StableAppError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const sendJson = (res, statusCode, payload, headers = {}) => {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
};

const sendHtml = (res, statusCode, body, headers = {}) => {
  res.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'text/html; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
};

const sendRedirect = (res, location, headers = {}) => {
  res.writeHead(303, {
    'Cache-Control': 'no-store',
    Location: location,
    ...headers,
  });
  res.end();
};

const normalizedOaToken = (value) => {
  let token = String(value || '').trim();
  try {
    token = decodeURIComponent(token);
  } catch {
    return '';
  }
  if (token.toLowerCase().startsWith('bearer ')) {
    token = token.slice('bearer '.length).trim();
  }
  return token;
};

const cookieValue = (req, name) => {
  const header = String(req.headers.cookie || '');
  for (const item of header.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    return item.slice(separator + 1).trim();
  }
  return '';
};

const readJsonBody = (req) =>
  new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_AUTH_BODY_BYTES) {
        tooLarge = true;
        body = '';
        return;
      }
      if (!tooLarge) body += chunk;
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new StableAppError(413, '登录请求内容过大。'));
        return;
      }
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new StableAppError(400, '登录请求格式无效。'));
      }
    });
    req.on('error', reject);
  });

const escapeHtml = (value) =>
  String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const safeScriptJson = (value) =>
  JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');

const userIdentity = (user) => ({
  id: String(
    user.number ||
      user.userId ||
      user.id ||
      user.open_id ||
      user.username ||
      '',
  ).trim(),
  name: String(user.realName || user.name || user.userName || '').trim(),
});

export const createStableAppService = ({
  sharedSecret,
  staticDir,
  publicPrefix,
  workerPublicUrl,
  oaApiBaseUrl = 'https://api.fandow.com',
  oaClientId = '',
  oaClientSecret = '',
  oaGrantType = 'password',
  accessAuthorityUrl = '',
  accessAuthorityToken = '',
  integratedMode = false,
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) => {
  const root = staticDir ? path.resolve(staticDir) : '';
  const prefix = String(publicPrefix || '').replace(/\/+$/u, '');
  const workerUrl = String(workerPublicUrl || '').replace(/\/+$/u, '');
  const apiBaseUrl = String(oaApiBaseUrl || '').replace(/\/+$/u, '');
  const clientId = String(oaClientId || '').trim();
  const clientSecret = String(oaClientSecret || '').trim();
  const grantType = String(oaGrantType || 'password').trim() || 'password';
  const authorityUrl = String(accessAuthorityUrl || '').trim();
  const authorityToken = String(accessAuthorityToken || '').trim();
  const accessAuthorityConfigured = Boolean(
    authorityUrl && authorityToken.length >= 32,
  );
  const configured = Boolean(
    sharedSecret &&
      root &&
      prefix &&
      workerUrl &&
      apiBaseUrl &&
      accessAuthorityConfigured,
  );
  const passwordLoginConfigured = Boolean(clientId && clientSecret);

  const sessionCookie = (token, { clear = false } = {}) => {
    const value = clear ? '' : encodeURIComponent(token);
    const maxAge = clear ? 0 : SESSION_MAX_AGE_SECONDS;
    return `${SESSION_COOKIE}=${value}; Path=${prefix || '/'}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
  };

  const requestToken = (req) =>
    normalizedOaToken(
      integratedMode
        ? cookieValue(req, SESSION_COOKIE) || cookieValue(req, 'authorization') || cookieValue(req, 'oa-authorization')
        : req.headers['x-oa-token'] || cookieValue(req, SESSION_COOKIE),
    );

  const requestOaJson = async (
    endpoint,
    { method = 'GET', payload, token = '' } = {},
  ) => {
    const headers = { Accept: 'application/json' };
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    let response;
    try {
      response = await fetchImpl(`${apiBaseUrl}${endpoint}`, {
        method,
        headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new StableAppError(503, 'OA 登录服务暂时不可用，请稍后重试。');
    }
    return {
      response,
      payload: await response.json().catch(() => null),
    };
  };

  const signWorkerSession = (user) => {
    const identity = userIdentity(user);
    if (!identity.id) {
      throw new StableAppError(403, 'OA 账号缺少可用的员工标识。');
    }
    const issuedAt = Math.floor(now() / 1000);
    const expiresAt = issuedAt + 15 * 60;
    const encodedPayload = Buffer.from(
      JSON.stringify({
        iss: 'wis-workstation',
        aud: 'wis-render-worker',
        sub: identity.id,
        name: identity.name || identity.id,
        iat: issuedAt,
        exp: expiresAt,
      }),
      'utf8',
    ).toString('base64url');
    const signature = createHmac('sha256', sharedSecret)
      .update(encodedPayload)
      .digest('base64url');
    return {
      enabled: true,
      workerBaseUrl: workerUrl,
      accessToken: `${encodedPayload}.${signature}`,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      message: null,
      stableApp: {
        appUrl: `${prefix}/`,
        logoutUrl: `${prefix}/api/auth/logout`,
        user: {
          id: identity.id,
          name: identity.name || identity.id,
          department: String(
            user.groupName || user.department || user.deptName || '',
          ).trim(),
        },
      },
    };
  };

  const validateOaUser = async (rawToken) => {
    const token = normalizedOaToken(rawToken);
    if (!token) {
      throw new StableAppError(401, 'OA 登录状态无效，请重新进入工作台。');
    }
    let lastFailure = 'network';
    for (const [attempt, delay] of AUTHORITY_RETRY_DELAYS_MS.entries()) {
      if (delay) await wait(delay);
      let response;
      try {
        response = await fetchImpl(authorityUrl, {
          headers: {
            Accept: 'application/json',
            'X-OA-Token': token,
            'X-WIS-Workstation-Token': authorityToken,
          },
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        lastFailure = 'network';
        if (attempt < AUTHORITY_RETRY_DELAYS_MS.length - 1) continue;
        break;
      }
      const payload = await response.json().catch(() => null);
      if (response.status === 401) {
        throw new StableAppError(401, 'OA 登录状态已失效，请重新进入工作台。');
      }
      if (response.status === 403) {
        throw new StableAppError(403, '当前 OA 账号未获云管家登录权限。');
      }
      if (response.ok && payload?.allowed === true && payload?.user) {
        return payload.user;
      }
      lastFailure = response.status >= 500 ? 'upstream' : 'invalid';
      if (
        (response.status >= 500 || response.ok) &&
        attempt < AUTHORITY_RETRY_DELAYS_MS.length - 1
      ) {
        continue;
      }
      break;
    }
    throw new StableAppError(
      503,
      lastFailure === 'network'
        ? '云管家登录权限服务暂时不可用，系统已自动重试，请稍后再试。'
        : '云管家登录权限服务返回异常，系统已自动重试，请稍后再试。',
    );
  };

  const loginWithPassword = async ({ username, password, captcha }) => {
    if (!passwordLoginConfigured) {
      throw new StableAppError(503, 'OA 工号密码登录尚未完成服务器配置。');
    }
    const normalizedUsername = String(username || '')
      .trim()
      .toUpperCase();
    if (!normalizedUsername || !String(password || '')) {
      throw new StableAppError(400, '请输入 OA 工号和密码。');
    }
    const requestPayload = {
      username: normalizedUsername,
      password: String(password),
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: grantType,
    };
    if (String(captcha || '').trim()) {
      requestPayload.captcha = String(captcha).trim();
    }
    const { response, payload } = await requestOaJson(
      '/authentication/password-grant',
      { method: 'POST', payload: requestPayload },
    );
    const nested =
      payload?.data && typeof payload.data === 'object' ? payload.data : {};
    const authorization = String(response.headers.get('authorization') || '');
    const headerToken = authorization.toLowerCase().startsWith('bearer ')
      ? authorization.slice('bearer '.length).trim()
      : authorization.trim();
    const token = String(
      payload?.access_token ||
        payload?.accessToken ||
        payload?.token ||
        nested.access_token ||
        nested.accessToken ||
        nested.token ||
        headerToken ||
        '',
    ).trim();
    if (!response.ok || !token) {
      const upstreamCode = String(
        payload?.code || payload?.error_code || nested.code || response.status,
      );
      if (upstreamCode === '400') {
        throw new StableAppError(428, 'OA 登录需要验证码，请获取后重试。');
      }
      const statusCode = response.status >= 500 ? 502 : 401;
      throw new StableAppError(
        statusCode,
        response.status >= 500
          ? 'OA 登录服务暂时异常，请稍后重试。'
          : 'OA 工号或密码未通过验证。',
      );
    }
    const user = await validateOaUser(token);
    return { token, user };
  };

  const sendCaptcha = async (username) => {
    const normalizedUsername = String(username || '')
      .trim()
      .toUpperCase();
    if (!normalizedUsername) {
      throw new StableAppError(400, '请先输入 OA 工号。');
    }
    const { response, payload } = await requestOaJson(
      '/authentication/captcha',
      { method: 'POST', payload: { username: normalizedUsername } },
    );
    if (!response.ok || !['', '0'].includes(String(payload?.code ?? '0'))) {
      throw new StableAppError(
        response.status >= 500 ? 502 : 400,
        '验证码发送失败，请稍后重试。',
      );
    }
    return String(payload?.msg || payload?.message || '验证码已发送。');
  };

  const renderLoginPage = (message = '') => {
    const safePrefix = safeScriptJson(prefix);
    const safeMessage = escapeHtml(message);
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>WIS 二创混剪工作台登录</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;font-family:Inter,"PingFang SC","Microsoft YaHei",sans-serif;background:linear-gradient(135deg,#f4fbfa 0%,#edf3ff 100%);color:#10223d}.page{min-height:100vh;display:grid;grid-template-columns:minmax(320px,1fr) minmax(360px,520px);gap:64px;align-items:center;padding:7vw}.brand small{color:#0f9488;font-weight:800;letter-spacing:.14em}.brand h1{font-size:clamp(38px,5vw,72px);line-height:1.06;margin:22px 0}.brand p{color:#5f718a;font-size:18px;line-height:1.8}.panel{background:#fff;border:1px solid #dbe7ef;border-radius:24px;padding:40px;box-shadow:0 30px 80px rgba(36,78,112,.14)}.logo{width:48px;height:48px;border-radius:15px;display:grid;place-items:center;background:#0f9488;color:#fff;font-weight:900;font-size:24px}.panel h2{font-size:30px;margin:22px 0 8px}.hint{color:#718096;margin:0 0 28px}.field{display:block;font-weight:700;margin:16px 0}.field input{width:100%;margin-top:8px;padding:14px 15px;border:1px solid #cad7e2;border-radius:11px;font:inherit;outline:none}.field input:focus{border-color:#0f9488;box-shadow:0 0 0 3px rgba(15,148,136,.13)}button,.unified{width:100%;min-height:48px;border:0;border-radius:11px;font:inherit;font-weight:800;cursor:pointer}.submit{margin-top:10px;background:#1769e0;color:#fff}.submit:disabled{opacity:.55;cursor:not-allowed}.unified{margin-top:12px;display:grid;place-items:center;text-decoration:none;background:#edf7f6;color:#087e74;border:1px solid #bfe5e1}.error{display:${safeMessage ? 'block' : 'none'};margin:14px 0;padding:11px 13px;border-radius:9px;background:#fff2f0;color:#b42318;font-size:14px}.captcha-row{display:none;grid-template-columns:1fr 118px;gap:8px}.captcha-row button{align-self:end;border:1px solid #bfe5e1;background:#edf7f6;color:#087e74}.foot{display:block;margin-top:20px;text-align:center;color:#8290a4}@media(max-width:850px){.page{grid-template-columns:1fr;padding:24px}.brand{display:none}.panel{padding:28px}}
</style></head><body><main class="page"><section class="brand"><small>WIS MARKETING CONTENT HUB</small><h1>二创混剪，<br/>从真实素材开始。</h1><p>使用凡岛统一 OA 身份安全访问<br/>素材选取、切片、编排、合成与审核。</p></section><section class="panel"><div class="logo">W</div><h2>欢迎回来</h2><p class="hint">使用凡岛统一 OA 账号登录二创混剪工作台</p><form id="login-form"><label class="field">OA 工号<input id="username" autocomplete="username" autocapitalize="characters" placeholder="例如 FD-026222" required/></label><label class="field">登录密码<input id="password" type="password" autocomplete="current-password" placeholder="请输入 OA 密码" required/></label><div id="captcha-row" class="captcha-row"><label class="field">登录验证码<input id="captcha" inputmode="numeric" autocomplete="one-time-code" placeholder="请输入验证码"/></label><button id="captcha-button" type="button">获取验证码</button></div><div id="error" class="error">${safeMessage}</div><button id="submit" class="submit" type="submit">登录工作台 →</button></form><a id="unified" class="unified">使用统一 OA / 飞书登录</a><small class="foot">仅限 OA 状态正常的品牌营销团队及已授权同事登录</small></section></main>
<script>const prefix=${safePrefix};const form=document.getElementById('login-form');const username=document.getElementById('username');const password=document.getElementById('password');const captcha=document.getElementById('captcha');const captchaRow=document.getElementById('captcha-row');const captchaButton=document.getElementById('captcha-button');const errorBox=document.getElementById('error');const submit=document.getElementById('submit');document.getElementById('unified').href=prefix+'/auth/unified';const showError=(message)=>{errorBox.textContent=message||'登录失败';errorBox.style.display='block'};form.addEventListener('submit',async(event)=>{event.preventDefault();submit.disabled=true;errorBox.style.display='none';try{const response=await fetch(prefix+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:username.value.trim().toUpperCase(),password:password.value,captcha:captcha.value.trim()})});const data=await response.json().catch(()=>({}));if(response.status===428){captchaRow.style.display='grid';showError(data.message);return}if(!response.ok)throw new Error(data.message||'登录失败');password.value='';window.location.replace(prefix+'/')}catch(error){showError(error.message)}finally{submit.disabled=false}});captchaButton.addEventListener('click',async()=>{captchaButton.disabled=true;errorBox.style.display='none';try{const response=await fetch(prefix+'/api/auth/captcha',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:username.value.trim().toUpperCase()})});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.message||'验证码发送失败');showError(data.message)}catch(error){showError(error.message)}finally{captchaButton.disabled=false}});</script></body></html>`;
  };

  const renderIndex = async (token) => {
    const user = await validateOaUser(token);
    const session = signWorkerSession(user);
    const indexPath = path.join(root, 'index.html');
    const originalHtml = await fs.readFile(indexPath, 'utf8');
    const html = integratedMode
      ? originalHtml.replaceAll('/fd-026222/wis-remix/', `${prefix}/`)
      : originalHtml;
    const sessionScript = `<script>window.__WIS_RENDER_WORKER_SESSION__=${safeScriptJson(session)};</script>`;
    return html.includes('</head>')
      ? html.replace('</head>', `${sessionScript}</head>`)
      : `${sessionScript}${html}`;
  };

  const route = async (req, res, url) => {
    if (!prefix || String(req.headers['x-forwarded-prefix'] || '') !== prefix) {
      return false;
    }
    if (!configured) {
      sendJson(res, 503, { message: '稳定版工作台尚未完成配置。' });
      return true;
    }
    let relativePath;
    try {
      relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    } catch {
      sendJson(res, 400, { message: '请求路径无效。' });
      return true;
    }

    if (integratedMode) {
      // One hub session and live module policy, including static HTML routes.
      // Child workbenches must not create a competing path-scoped OA cookie.
      if (['api/auth/login', 'api/auth/captcha', 'api/auth/logout'].includes(relativePath)) {
        sendJson(res, 409, { code: 'USE_HUB_SESSION', message: '请通过中枢首页统一管理登录。' });
        return true;
      }
      try {
        await validateOaUser(requestToken(req));
      } catch (error) {
        sendJson(res, error instanceof StableAppError ? error.statusCode : 503,
          { code: 'HUB_SESSION_REQUIRED', message: error.message });
        return true;
      }
      if (relativePath === 'auth/unified') {
        sendRedirect(res, `${prefix}/`);
        return true;
      }
    }

    try {
      if (relativePath === 'api/auth/login' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const { token, user } = await loginWithPassword(body);
        sendJson(
          res,
          200,
          { ok: true, user: userIdentity(user) },
          { 'Set-Cookie': sessionCookie(token) },
        );
        return true;
      }
      if (relativePath === 'api/auth/captcha' && req.method === 'POST') {
        const body = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          message: await sendCaptcha(body.username),
        });
        return true;
      }
      if (relativePath === 'api/auth/me' && req.method === 'GET') {
        const user = await validateOaUser(requestToken(req));
        sendJson(res, 200, { ok: true, user: userIdentity(user) });
        return true;
      }
      if (
        relativePath === 'api/workstation/render-session' &&
        req.method === 'GET'
      ) {
        const user = await validateOaUser(requestToken(req));
        sendJson(res, 200, signWorkerSession(user), {
          'Cache-Control': 'no-store',
        });
        return true;
      }
      if (relativePath === 'api/auth/logout' && req.method === 'POST') {
        sendJson(
          res,
          200,
          { ok: true },
          { 'Set-Cookie': sessionCookie('', { clear: true }) },
        );
        return true;
      }
      if (relativePath === 'auth/unified' && req.method === 'GET') {
        const token = normalizedOaToken(req.headers['x-oa-token']);
        await validateOaUser(token);
        sendRedirect(res, `${prefix}/`, {
          'Set-Cookie': sessionCookie(token),
        });
        return true;
      }
    } catch (error) {
      const statusCode =
        error instanceof StableAppError ? error.statusCode : 500;
      const message =
        error instanceof StableAppError
          ? error.message
          : 'OA 登录暂时无法完成。';
      if (relativePath === 'auth/unified') {
        sendHtml(res, statusCode, renderLoginPage(message), {
          'Set-Cookie': sessionCookie('', { clear: true }),
        });
      } else {
        sendJson(res, statusCode, { message });
      }
      return true;
    }

    if (!['GET', 'HEAD'].includes(req.method || '')) {
      sendJson(res, 405, { message: '请求方式不受支持。' });
      return true;
    }
    const candidate = path.resolve(root, relativePath);
    const withinRoot =
      candidate === root || candidate.startsWith(`${root}${path.sep}`);
    if (!withinRoot) {
      sendJson(res, 404, { message: '页面资源不存在。' });
      return true;
    }

    let fileStat = null;
    try {
      fileStat = await fs.stat(candidate);
    } catch {
      fileStat = null;
    }
    if (fileStat?.isFile() && !(integratedMode && /(?:^|\/)index\.html$/u.test(relativePath))) {
      const extension = path.extname(candidate).toLowerCase();
      res.writeHead(200, {
        'Cache-Control': relativePath.startsWith('assets/')
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=3600',
        'Content-Length': fileStat.size,
        'Content-Type': MIME_TYPES.get(extension) || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
      });
      if (req.method === 'HEAD') {
        res.end();
      } else {
        await pipeFileToResponse(req, res, candidate);
      }
      return true;
    }
    if (relativePath.startsWith('assets/')) {
      sendJson(res, 404, { message: '页面资源不存在。' });
      return true;
    }

    const token = requestToken(req);
    if (!token) {
      const html = renderLoginPage();
      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Cache-Control': 'no-store',
          'Content-Length': Buffer.byteLength(html),
          'Content-Type': 'text/html; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end();
      } else {
        sendHtml(res, 200, html);
      }
      return true;
    }

    try {
      const html = await renderIndex(token);
      const headers = integratedMode ? {} : { 'Set-Cookie': sessionCookie(token) };
      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Cache-Control': 'no-store',
          'Content-Length': Buffer.byteLength(html),
          'Content-Type': 'text/html; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          ...headers,
        });
        res.end();
      } else {
        sendHtml(res, 200, html, headers);
      }
    } catch (error) {
      const statusCode =
        error instanceof StableAppError ? error.statusCode : 500;
      const message =
        error instanceof StableAppError
          ? error.message
          : '稳定版工作台暂时无法加载。';
      if (integratedMode) sendJson(res, statusCode, { code: 'HUB_SESSION_REQUIRED', message });
      else sendHtml(res, statusCode, renderLoginPage(message), {
        'Set-Cookie': sessionCookie('', { clear: true }),
      });
    }
    return true;
  };

  return {
    accessAuthorityConfigured,
    configured,
    passwordLoginConfigured,
    authorizeRequest: async (req) => userIdentity(await validateOaUser(requestToken(req))),
    route,
  };
};
