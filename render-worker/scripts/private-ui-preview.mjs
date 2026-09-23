// Local-only UI acceptance harness. No OA, cloud assets, Qianchuan or production
// credentials are inherited. Synthetic media stays in an isolated data folder.
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const staticRoot = path.join(projectRoot, 'dist/stable-client');
const dataDir = await fs.mkdtemp(path.join(projectRoot, 'render-worker/artifacts/private-ui-'));
const prefix = '/fd-026222/wis-remix/';
const api = 'http://127.0.0.1:8847';
const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'PATHEXT'].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
Object.assign(env, { RENDER_WORKER_HOST: '127.0.0.1', RENDER_WORKER_PORT: '8847', RENDER_WORKER_DATA_DIR: dataDir, PRIVATE_UPLOADS_ENABLED: 'true', CONTINUOUS_CLIP_SUPPLY_INITIAL_DELAY_MS: '3600000', RENDER_WORKER_ALLOWED_ORIGINS: 'http://127.0.0.1:8848' });
if (process.env.PRIVATE_CLOUD_LOOPBACK_QA === 'true') Object.assign(env, {
  WIS_MATERIAL_CENTER_BASE_URL: 'http://127.0.0.1:8849/fd-026222/wis-video-center/api/workstation',
  WIS_MATERIAL_CENTER_TOKEN: 'private-vault-loopback-acceptance-only-20260905',
});
const worker = spawn(process.execPath, [path.join(projectRoot, 'render-worker/server.mjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let workerLog = '';
for (const stream of [worker.stdout, worker.stderr]) stream.on('data', (chunk) => { workerLog = (workerLog + chunk).slice(-2000); });
const stop = () => { worker.kill(); server.close(); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith(prefix)) { res.writeHead(302, { Location: prefix }); res.end(); return; }
    const relative = decodeURIComponent(url.pathname.slice(prefix.length)) || 'index.html';
    const file = path.resolve(staticRoot, relative);
    if (!file.startsWith(staticRoot + path.sep)) { res.writeHead(404); res.end(); return; }
    let bytes = await fs.readFile(file);
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream';
    if (relative === 'index.html') bytes = Buffer.from(bytes.toString().replace('<head>', `<head><script>window.__WIS_RENDER_WORKER_SESSION__=${JSON.stringify({ enabled: true, workerBaseUrl: api, accessToken: null, expiresAt: null, message: '仅本机候选验收' })}</script>`));
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' }); res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { ready = (await fetch(api + '/health', { signal: AbortSignal.timeout(1000) })).ok; } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error(workerLog);
  const json = async (url, body) => {
    const response = await fetch(api + url, { method: 'POST', body: body instanceof FormData ? body : JSON.stringify(body), headers: body instanceof FormData ? {} : { 'Content-Type': 'application/json' } });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  };
  const folder = (await json('/api/remix/folders', { name: '候选验收_我的切片' })).folder;
  await json('/api/remix/folders', { name: '二级目录_喷雾', parentId: folder.id });
  const fixture = path.join(dataDir, 'private-fixture.mp4');
  const ffmpeg = spawn('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:d=6:r=25', '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p', fixture], { env, windowsHide: true, stdio: 'ignore' });
  if ((await once(ffmpeg, 'close'))[0] !== 0) throw new Error('Fixture generation failed');
  const sourceForm = new FormData(); sourceForm.append('source', new Blob([await fs.readFile(fixture)]), '候选验收_私人测试视频.mp4'); sourceForm.append('visibility', 'private');
  const { source } = await json('/api/remix/sources', sourceForm);
  await json('/api/remix/operations', { type: 'clip', payload: { sourceId: source.id, startSeconds: 1, endSeconds: 4, name: '候选验收_私人3秒切片', role: 'hook', productCategory: '肌活蛋白喷雾' } });
  await new Promise((resolve) => server.listen(8848, '127.0.0.1', resolve));
  console.log(JSON.stringify({ url: `http://127.0.0.1:8848${prefix}`, dataDir, productionAccess: false }));
  setTimeout(stop, 15 * 60 * 1000).unref();
} catch (error) { stop(); throw error; }
