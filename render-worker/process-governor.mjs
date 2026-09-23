import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';

export function effectiveCpuCapacity(read = (file) => readFileSync(file, 'utf8'), hostCpus = availableParallelism()) {
  let capacity = Math.max(1, Number(hostCpus) || 1);
  try {
    const [quota, period] = read('/sys/fs/cgroup/cpu.max').trim().split(/\s+/u);
    if (quota !== 'max' && Number(quota) > 0 && Number(period) > 0) capacity = Math.min(capacity, Number(quota) / Number(period));
  } catch {
    try {
      const quota = Number(read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'));
      const period = Number(read('/sys/fs/cgroup/cpu/cpu.cfs_period_us'));
      if (quota > 0 && period > 0) capacity = Math.min(capacity, quota / period);
    } catch { /* Non-container environments use the process affinity limit. */ }
  }
  return capacity;
}

export function cpuProcessLimit(capacity, requested) {
  const safeLimit = Math.max(1, Math.floor(capacity));
  const parsed = Number(requested);
  return Math.min(safeLimit, Math.max(1, Math.min(4, Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 4)));
}

export function createProcessGovernor(limit) {
  const maximum = Math.max(1, Math.floor(limit));
  let active = 0;
  const waiters = [];
  const release = () => {
    const next = waiters.shift();
    if (next) next();
    else active = Math.max(0, active - 1);
  };
  return {
    snapshot: () => ({ maximum, active, waiting: waiters.length }),
    async run(operation) {
      if (active < maximum) active++;
      else await new Promise((resolve) => waiters.push(resolve));
      try { return await operation(); } finally { release(); }
    }
  };
}
