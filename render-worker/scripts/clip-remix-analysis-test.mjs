import {
  alignSpeechCandidatesToIntegerSeconds,
  assessClipBoundaryIntegrity,
  extractSceneBoundaries,
  extractSilenceWindows,
  mergeOcrSamples,
  normalizeSpeechCandidates,
  speechCandidatesFromSilence,
} from '../clip-remix-analysis.mjs';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const silenceWindows = extractSilenceWindows(
  [
    '[silencedetect] silence_start: 4.2',
    '[silencedetect] silence_end: 4.9 | silence_duration: 0.7',
    '[silencedetect] silence_start: 18.4',
    '[silencedetect] silence_end: 19.2 | silence_duration: 0.8',
  ].join('\n'),
  36,
);
assert(silenceWindows.length === 2, '没有正确解析完整静音区间。');
assert(
  Math.abs(silenceWindows[0].midpointSeconds - 4.55) < 0.01,
  '静音切点没有落在停顿中点。',
);

const sceneBoundaries = extractSceneBoundaries(
  [
    '[Parsed_showinfo_1] n:1 pts:1200 pts_time:4.2',
    '[Parsed_showinfo_1] n:2 pts:2500 pts_time:8.75',
  ].join('\n'),
  12,
);
assert(
  sceneBoundaries.length === 2 && sceneBoundaries[0] === 4.2,
  '画面转场时间没有被正确解析。',
);

const sceneAlignedSegments = normalizeSpeechCandidates({
  durationSeconds: 12,
  silenceWindows: [],
  sceneBoundaries,
  candidates: [
    {
      startSeconds: 0,
      endSeconds: 4,
      boundaryType: 'cutter',
      transcriptSource: 'cutter',
      label: '这一段内容完整结束。',
    },
  ],
});
assert(
  sceneAlignedSegments[0].endSeconds === 4 &&
    sceneAlignedSegments[0].endFrame === 120 &&
    sceneAlignedSegments[0].requiresReview,
  '画面转场候选应落到整数秒和原始帧号，且偏差超过硬门槛时必须退回。',
);

const integerGridSegments = alignSpeechCandidatesToIntegerSeconds({
  durationSeconds: 12,
  frameRate: 24,
  candidates: [
    { startSeconds: 0, endSeconds: 3.6, label: '第一段。' },
    { startSeconds: 3.6, endSeconds: 8.2, label: '第二段。' },
  ],
});
assert(
  integerGridSegments[0].endSeconds === 4 &&
    integerGridSegments[1].startSeconds === 4 &&
    integerGridSegments[1].startFrame === 96,
  '相邻片段没有共享整数秒边界或没有按原始帧率换算帧号。',
);

const protectedOpening = alignSpeechCandidatesToIntegerSeconds({
  durationSeconds: 5.09,
  frameRate: 30,
  candidates: [
    {
      startSeconds: 0.7,
      endSeconds: 5.07,
      label: '从拿起面膜到展示结果的完整动作。',
    },
  ],
});
assert(
  protectedOpening[0].startSeconds === 0 &&
    protectedOpening[0].endSeconds === 5 &&
    protectedOpening[0].startFrame === 0 &&
    protectedOpening[0].endFrame === 150 &&
    protectedOpening[0].integerBoundaryTrusted,
  '首个动作在前一秒内开始时，不应被四舍五入裁掉起手画面。',
);

const unsafeIntegerRounding = alignSpeechCandidatesToIntegerSeconds({
  durationSeconds: 17.74,
  frameRate: 30,
  candidates: [
    {
      startSeconds: 0,
      endSeconds: 2.65,
      label: '整数秒恰好落在下一个动作中间。',
    },
  ],
});
assert(
  unsafeIntegerRounding[0].endSeconds === 3 &&
    !unsafeIntegerRounding[0].endBoundaryTrusted &&
    !unsafeIntegerRounding[0].integerBoundaryTrusted &&
    unsafeIntegerRounding[0].requiresReview,
  '原始语义边界离整数秒过远时，不应自动入库。',
);

const noForwardStartTrim = normalizeSpeechCandidates({
  durationSeconds: 12,
  silenceWindows: [],
  sceneBoundaries: [4.2],
  candidates: [
    {
      startSeconds: 4,
      endSeconds: 8,
      boundaryType: 'cutter',
      transcriptSource: 'cutter',
      label: '不能为了贴合画面转场而裁掉开头。',
    },
  ],
});
assert(
  noForwardStartTrim[0].startSeconds === 4,
  '画面转场校准不应向后裁掉内容开头。',
);

const ocrSegments = mergeOcrSamples(
  [
    { text: '今天给大家推荐', startSeconds: 0, endSeconds: 1.5 },
    { text: '今天给大家推荐一款面膜', startSeconds: 1.5, endSeconds: 3 },
    { text: '补水以后皮肤很舒服。', startSeconds: 3, endSeconds: 4.5 },
  ],
  1.5,
);
assert(ocrSegments.length === 2, 'OCR 渐进字幕没有去重合并。');
assert(
  ocrSegments[0].label === '今天给大家推荐一款面膜',
  'OCR 合并后没有保留信息更完整的字幕。',
);

const semanticSegments = normalizeSpeechCandidates({
  durationSeconds: 36,
  silenceWindows,
  candidates: [
    {
      startSeconds: 0,
      endSeconds: 36,
      boundaryType: 'cutter',
      transcriptSource: 'cutter',
      label:
        '第一句完整介绍产品和使用场景。第二句继续说明肤感以及使用体验。第三句完成结尾提醒。',
    },
  ],
});
assert(semanticSegments.length >= 2, '长文案没有按语义边界拆分。');
assert(
  semanticSegments.every(
    (segment) => segment.endSeconds - segment.startSeconds <= 20.01,
  ),
  '语义拆分后仍存在超过20秒的片段。',
);
assert(
  semanticSegments
    .slice(0, -1)
    .every((segment) => /[。！？!?；;…]$/u.test(segment.label)),
  '长文案在一句话中间被截断。',
);

const overlappingDistinctSegments = normalizeSpeechCandidates({
  durationSeconds: 8,
  silenceWindows: [],
  candidates: [
    {
      startSeconds: 0,
      endSeconds: 3.2,
      boundaryType: 'cutter',
      transcriptSource: 'cutter',
      label: '第一句完整口播。',
    },
    {
      startSeconds: 3.1,
      endSeconds: 6,
      boundaryType: 'cutter',
      transcriptSource: 'cutter',
      label: '第二句完整口播。',
    },
  ],
});
assert(
  overlappingDistinctSegments.length === 2,
  '时间略有重叠但文案不同的句子不应被错误合并。',
);

const repairedMidSentenceCut = normalizeSpeechCandidates({
  durationSeconds: 10,
  silenceWindows: [],
  candidates: [
    {
      startSeconds: 0,
      endSeconds: 4.8,
      boundaryType: 'cutter',
      transcriptSource: 'cutter',
      label: '我今年已经七十四岁了我还有个儿子',
    },
    {
      startSeconds: 4.8,
      endSeconds: 9.6,
      boundaryType: 'cutter',
      transcriptSource: 'cutter',
      label: '他今年四十五岁了。',
    },
  ],
});
assert(
  repairedMidSentenceCut.length === 1 &&
    repairedMidSentenceCut[0].label.includes('四十五岁了。'),
  'Cutter 在句子中间返回的相邻切点没有自动合回完整句。',
);

const unsafeSegments = normalizeSpeechCandidates({
  durationSeconds: 36,
  silenceWindows: [],
  candidates: [
    {
      startSeconds: 0,
      endSeconds: 36,
      boundaryType: 'cutter',
      transcriptSource: 'cutter',
      label: '这是一整段没有任何句末标点也没有可靠停顿的连续口播文本',
    },
  ],
});
assert(
  unsafeSegments.some((segment) => segment.requiresReview),
  '无语义证据的固定时长切点没有被标记为人工复核。',
);

const silenceOnly = speechCandidatesFromSilence(silenceWindows, 36);
assert(
  silenceOnly.every((segment) => segment.requiresReview),
  '仅按停顿生成的无文案片段不应进入自动切片。',
);

const trustedContentSegments = [
  {
    id: 'complete-sentence',
    startSeconds: 2,
    endSeconds: 6.4,
    label: '这一段从开头到结尾表达完整。',
    boundaryType: 'cutter',
    boundaryConfidence: 'high',
    requiresReview: false,
  },
  {
    id: 'next-sentence',
    startSeconds: 6.4,
    endSeconds: 10,
    label: '下一段内容也完整结束。',
    boundaryType: 'cutter',
    boundaryConfidence: 'high',
    requiresReview: false,
  },
];
const completeBoundary = assessClipBoundaryIntegrity({
  clipStartSeconds: 2,
  clipEndSeconds: 6.4,
  sourceDurationSeconds: 12,
  segments: trustedContentSegments,
});
assert(
  completeBoundary.status === 'passed' && completeBoundary.score === 100,
  '完整句段没有通过自动边界审核。',
);

const extraAndMissingBoundary = assessClipBoundaryIntegrity({
  clipStartSeconds: 2.35,
  clipEndSeconds: 6.8,
  sourceDurationSeconds: 12,
  segments: trustedContentSegments,
});
assert(
  extraAndMissingBoundary.status === 'review_required' &&
    extraAndMissingBoundary.canAutoAdjust &&
    extraAndMissingBoundary.recommendedStartSeconds === 2 &&
    extraAndMissingBoundary.recommendedEndSeconds === 6.4,
  '可安全修复的多截或少截边界没有给出完整段校准建议。',
);

const untrustedBoundary = assessClipBoundaryIntegrity({
  clipStartSeconds: 0,
  clipEndSeconds: 4,
  sourceDurationSeconds: 8,
  segments: [
    {
      id: 'broken-sentence',
      startSeconds: 0,
      endSeconds: 4,
      label: '这一段在半句话中间结束',
      boundaryType: 'fallback',
      boundaryConfidence: 'low',
      requiresReview: true,
    },
  ],
});
assert(
  untrustedBoundary.status === 'review_required' &&
    !untrustedBoundary.canAutoAdjust,
  '缺少句末或停顿证据的片段不应自动通过或自动修正。',
);

console.log('CLIP_REMIX_ANALYSIS_TEST=passed');
