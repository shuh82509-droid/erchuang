import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Long-running work must outlive an HTTP request. Only the authenticated owner
// can read results; payloads are persisted so a restart resumes the same work.
export const createManualOperations = ({
  directory,
  execute,
  concurrency = 2,
  afterCompleted = async () => {},
}) => {
  const jobs = new Map();
  let active = 0;
  let writes = Promise.resolve();
  const persist = (job) => {
    const snapshot = JSON.stringify(job);
    const operation = writes.then(async () => {
      await fs.mkdir(directory, { recursive: true });
      const target = path.join(directory, `${job.id}.json`);
      await fs.writeFile(`${target}.tmp`, snapshot);
      await fs.rename(`${target}.tmp`, target);
    });
    writes = operation.catch(() => undefined);
    return operation;
  };
  const view = (job) => {
    const {
      payload: _payload,
      identity: _identity,
      key: _key,
      ...result
    } = job;
    return result;
  };
  const pump = () => {
    while (active < concurrency) {
      const job = [...jobs.values()].find((item) => item.status === 'queued');
      if (!job) break;
      job.status = 'running';
      job.updatedAt = new Date().toISOString();
      active += 1;
      void (async () => {
        try {
          await persist(job);
          job.result = await execute(job.type, job.payload, job.identity);
          job.status = 'completed';
          job.message = '处理完成';
        } catch (error) {
          job.status = 'failed';
          job.message = String(error?.message || '处理失败，可重试').slice(
            0,
            500,
          );
        } finally {
          job.updatedAt = new Date().toISOString();
          try {
            await persist(job);
            if (job.status === 'completed')
              await afterCompleted(job.type, job.payload, job.result);
          } catch (error) {
            console.error('Operation persistence/cleanup:', error);
          }
          active -= 1;
          pump();
        }
      })();
    }
  };
  return {
    async initialize() {
      await fs.mkdir(directory, { recursive: true });
      for (const name of await fs.readdir(directory)) {
        if (!/^[a-f0-9-]+\.json$/u.test(name)) continue;
        const job = JSON.parse(
          await fs.readFile(path.join(directory, name), 'utf8'),
        );
        if (['queued', 'running'].includes(job.status)) job.status = 'queued';
        jobs.set(job.id, job);
      }
      pump();
    },
    async submit(type, payload, identity) {
      const key = createHash('sha256')
        .update(JSON.stringify([identity.id, type, payload]))
        .digest('hex');
      let job = [...jobs.values()]
        .reverse()
        .find(
          (item) =>
            item.key === key &&
            !(type === 'analyze' && item.status === 'completed'),
        );
      if (job && job.status !== 'failed') return view(job);
      if (
        [...jobs.values()].filter(
          (item) =>
            item.identity.id === identity.id &&
            ['queued', 'running'].includes(item.status),
        ).length >= 50
      ) {
        throw new Error('最多同时提交 50 个处理任务，请等待已有任务完成。');
      }
      job = {
        id: job?.id || randomUUID(),
        key,
        type,
        payload,
        identity,
        status: 'queued',
        message: '已排队，后台处理；关闭或刷新页面不会取消',
        createdAt: job?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      jobs.set(job.id, job);
      await persist(job);
      pump();
      return view(job);
    },
    get(id, identity) {
      const job = jobs.get(id);
      return job?.identity.id === identity.id ? view(job) : null;
    },
    async retry(id, identity) {
      const job = jobs.get(id);
      if (!job || job.identity.id !== identity.id)
        throw new Error('任务不存在或无权访问。');
      if (job.status !== 'failed') return view(job);
      return this.submit(job.type, job.payload, identity);
    },
    list(identity) {
      return [...jobs.values()]
        .filter((job) => job.identity.id === identity.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 50)
        .map(view);
    },
  };
};
