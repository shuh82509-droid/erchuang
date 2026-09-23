import {
  autoRemixClipQuality,
  autoRemixMaxClipCount,
  autoRemixRoleCandidateLimit,
  deferQianchuanDeliveryForCapacity,
  isQianchuanDailyCapacityDeferred,
  isRecoverableAutoPipelineError,
  nextQianchuanDeliveryWindowAt,
  normalizeAutoRemixDuration,
  qianchuanRetryDelayMs,
  selectDurationBalancedItems,
  sourceSilenceStatsForClip,
} from '../clip-remix-service.mjs';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

for (const duration of [30, 45, 60, 90, 120, 180]) {
  assert(
    normalizeAutoRemixDuration(duration) === duration,
    `合法目标时长 ${duration} 秒没有通过校验。`,
  );
}

for (const duration of [0, 29, 181, 360]) {
  let rejected = false;
  try {
    normalizeAutoRemixDuration(duration);
  } catch {
    rejected = true;
  }
  assert(rejected, `越界目标时长 ${duration} 秒没有被拦截。`);
}

assert(
  autoRemixRoleCandidateLimit(90, 5) > 8,
  '90 秒任务仍被旧的每框架位 8 条候选上限截断。',
);
assert(
  autoRemixMaxClipCount(90, 5) === 45,
  '90 秒任务的碎片数量上限没有按平均每条至少 2 秒计算。',
);
const durationCandidates = Array.from({ length: 100 }, (_, index) => ({
  slot: { id: `slot-${index % 4}` },
  clip: { id: `clip-${index}`, durationSeconds: 1 },
}));
const selectedDurationItems = selectDurationBalancedItems({
  items: durationCandidates,
  currentDurationSeconds: 10,
  targetDurationSeconds: 90,
  toleranceSeconds: 7.2,
});
const selectedDuration = selectedDurationItems.reduce(
  (total, item) => total + item.clip.durationSeconds,
  10,
);
assert(
  Math.abs(selectedDuration - 90) <= 7.2,
  `完整切片组合没有拼到 90 秒允许范围，实际 ${selectedDuration} 秒。`,
);
const fewerClipItems = selectDurationBalancedItems({
  items: [
    ...Array.from({ length: 4 }, (_, index) => ({
      slot: { id: 'solution' },
      clip: { id: `short-${index}`, durationSeconds: 1 },
    })),
    {
      slot: { id: 'solution' },
      clip: { id: 'complete-4s', durationSeconds: 4 },
    },
  ],
  currentDurationSeconds: 0,
  targetDurationSeconds: 4,
  toleranceSeconds: 0,
});
assert(
  fewerClipItems.length === 1 && fewerClipItems[0].clip.id === 'complete-4s',
  '相同时长下没有优先选择更完整、数量更少的切片。',
);
const cappedDurationItems = selectDurationBalancedItems({
  items: durationCandidates,
  currentDurationSeconds: 10,
  targetDurationSeconds: 90,
  toleranceSeconds: 7.2,
  maxItemCount: 45,
});
assert(
  cappedDurationItems.length <= 45,
  '时长组合超过了自动混剪的碎片数量上限。',
);

const voicedClip = {
  startSeconds: 10,
  endSeconds: 14,
  durationSeconds: 4,
  reviewStatus: 'approved',
  automaticAssessment: {
    status: 'passed',
    autoApproved: true,
    boundaryIntegrity: { status: 'passed' },
  },
};
const voicedSource = {
  hasAudio: true,
  analysisSilenceWindows: [{ startSeconds: 13.7, endSeconds: 14 }],
};
assert(
  sourceSilenceStatsForClip(voicedClip, voicedSource).passed &&
    autoRemixClipQuality(voicedClip, voicedSource).eligible,
  '有完整边界且声音有效的切片被误拦截。',
);
const silentSource = {
  hasAudio: true,
  analysisSilenceWindows: [{ startSeconds: 10, endSeconds: 14 }],
};
assert(
  !sourceSilenceStatsForClip(voicedClip, silentSource).passed &&
    !autoRemixClipQuality(voicedClip, silentSource).eligible,
  '整段静音切片仍能进入自动混剪。',
);

for (const error of [
  new Error('The operation was aborted due to timeout'),
  new Error('fetch failed: ECONNRESET'),
  new Error('素材中心响应超时，请稍后重试'),
]) {
  assert(
    isRecoverableAutoPipelineError(error),
    `临时错误没有进入自动恢复：${error.message}`,
  );
}

for (const error of [
  new Error('千川账户无权限'),
  new Error('目标计划已结束'),
  new Error('素材中心双向接口尚未配置'),
  new Error('仅允许投放工作台回传且统一带有“自动混剪”的成片'),
]) {
  assert(
    !isRecoverableAutoPipelineError(error),
    `外部硬阻断不应被无休止自动重试：${error.message}`,
  );
}

assert(
  qianchuanRetryDelayMs(8, '系统请求频率超限，请稍后重试。') === 3 * 60_000,
  '千川限频仍进入小时级退避，没有按串行上传策略加速解决。',
);
assert(
  qianchuanRetryDelayMs(
    8,
    '原视频已上传，但千川视频列表暂未返回详情，请稍后重试',
  ) ===
    3 * 60_000,
  '已上传视频的计划绑定仍进入小时级退避。',
);
assert(
  qianchuanRetryDelayMs(8, '计划正在更新中，请稍后重试') === 3 * 60_000,
  '千川计划更新中的临时状态仍进入小时级退避。',
);

assert(
  isQianchuanDailyCapacityDeferred('已达到该计划今日自动混剪投放数量上限'),
  '千川每日数量上限应顺延，而不是标记为运行失败。',
);
assert(
  !isQianchuanDailyCapacityDeferred('千川账户无权限'),
  '账户权限异常不能被误判为每日额度顺延。',
);
assert(
  nextQianchuanDeliveryWindowAt('2026-09-01T11:30:00.000Z') ===
    '2026-09-01T16:05:00.000Z',
  '顺延时间应为北京时间次日 00:05。',
);
const deferredDelivery = deferQianchuanDeliveryForCapacity(
  { status: 'failed', errorMessage: '旧失败信息' },
  '已达到该计划今日自动混剪投放数量上限',
);
assert(
  deferredDelivery.status === 'deferred' &&
    deferredDelivery.errorMessage === '' &&
    Date.parse(deferredDelivery.nextRetryAt) > Date.now(),
  '额度顺延状态必须可在服务初始化时安全迁移。',
);

console.log('CLIP_REMIX_DURATION_TEST=passed');
