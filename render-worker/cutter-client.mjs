const baseUrl = String(
  process.env.WIS_CUTTER_BASE_URL ||
    'https://cloud.fandow.com/gpt/marketing-video',
)
  .trim()
  .replace(/\/$/, '');

const configured = /^https?:\/\//i.test(baseUrl);

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const parsePayload = async (response) => {
  const payload = await response.json().catch(() => null);
  const message =
    payload && typeof payload === 'object' ? String(payload.message || '') : '';
  if (!response.ok || Number(payload?.code) !== 0) {
    const error = new Error(
      String(message || `Cutter 请求失败（${response.status}）`).slice(0, 240),
    );
    error.status = response.status;
    throw error;
  }
  return payload?.data && typeof payload.data === 'object' ? payload.data : {};
};

const request = async (pathName, init = {}) => {
  if (!configured) throw new Error('Cutter 文案识别服务尚未配置。');
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(30000),
  });
  return parsePayload(response);
};

const select = async (ossUrl) => {
  const search = new URLSearchParams({ oss_url: ossUrl });
  const data = await request(`/cutter/select?${search.toString()}`);
  return Array.isArray(data.results) ? data.results : [];
};

const submit = async (ossUrl) => {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await request('/cutter/save', {
        method: 'POST',
        body: JSON.stringify({ oss_url: ossUrl }),
      });
    } catch (error) {
      lastError = error;
      if (error?.status !== 429 || attempt === 3) throw error;
      await delay(2000 * 2 ** attempt);
    }
  }
  throw lastError || new Error('Cutter 任务提交失败。');
};

const getTask = async (taskId) => {
  const search = new URLSearchParams({ task_id: taskId });
  return request(`/cutter/task?${search.toString()}`);
};

const analyze = async (ossUrl, { timeoutMs = 6 * 60 * 1000 } = {}) => {
  const normalizedUrl = String(ossUrl || '').trim();
  if (!/^https?:\/\//i.test(normalizedUrl)) {
    throw new Error('Cutter 只能识别可公开访问的 http/https 视频地址。');
  }

  const existing = await select(normalizedUrl);
  if (existing.length) {
    return { taskId: null, reused: true, results: existing };
  }

  const submitted = await submit(normalizedUrl);
  const taskId = String(submitted.task_id || '').trim();
  if (!taskId) throw new Error('Cutter 没有返回任务 ID。');
  if (submitted.status === 'success') {
    return {
      taskId,
      reused: Boolean(submitted.reused),
      results: await select(normalizedUrl),
    };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(2000);
    const task = await getTask(taskId);
    if (task.status === 'success') {
      const results = await select(normalizedUrl);
      if (!results.length)
        throw new Error('Cutter 任务完成，但没有返回拆解结果。');
      return { taskId, reused: Boolean(task.duplicated), results };
    }
    if (task.status === 'failed') {
      throw new Error(
        String(
          task.error_message || task.message || 'Cutter 文案识别失败。',
        ).slice(0, 240),
      );
    }
  }
  throw new Error('Cutter 文案识别超时，请稍后重试。');
};

const cutterClient = { configured, analyze };

export { cutterClient };
