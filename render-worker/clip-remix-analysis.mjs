const MIN_SEGMENT_SECONDS = 0.8;
const MAX_SEGMENT_SECONDS = 20;
const TARGET_SEGMENT_SECONDS = 14;
const CLIP_BOUNDARY_TOLERANCE_SECONDS = 0.16;
const CLIP_BOUNDARY_AUTO_ADJUST_LIMIT_SECONDS = 1.25;
const STRONG_SENTENCE_END = /[。！？!?；;…]$/u;
const PUNCTUATION_PATTERN = /[。！？!?；;…，,：:]/gu;

const roundedSeconds = (value) => Number(Number(value).toFixed(2));

const normalizedFrameRate = (value) => {
  const frameRate = Number(value);
  return Number.isFinite(frameRate) && frameRate >= 1 && frameRate <= 240
    ? frameRate
    : 30;
};

export const alignSpeechCandidatesToIntegerSeconds = ({
  candidates,
  durationSeconds,
  frameRate = 30,
}) => {
  const duration = Math.max(0, Number(durationSeconds) || 0);
  const fps = normalizedFrameRate(frameRate);
  if (duration < 1) return [];
  const lastWholeSecond = Math.floor(duration);
  const ordered = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => ({ ...candidate }))
    .sort((left, right) => left.startSeconds - right.startSeconds);
  let previousEnd = 0;
  return ordered
    .map((candidate, index) => {
      const rawStartSeconds = Math.max(
        0,
        Math.min(duration, Number(candidate.startSeconds) || 0),
      );
      const rawEndSeconds = Math.max(
        rawStartSeconds,
        Math.min(duration, Number(candidate.endSeconds) || 0),
      );
      let startSeconds = Math.round(rawStartSeconds);
      let endSeconds = Math.round(rawEndSeconds);
      // Cutter/OCR sometimes reports the first semantic event a few frames
      // after the visible action has already started.  Rounding a 0.6-0.9s
      // boundary forward to 1s produces an obviously truncated opening.  The
      // source beginning is already an exact integer boundary, so keep the
      // whole lead-in whenever the first event begins inside the first second.
      if (index === 0 && rawStartSeconds < 1) startSeconds = 0;
      startSeconds = Math.max(
        previousEnd,
        Math.min(lastWholeSecond, startSeconds),
      );
      if (endSeconds <= startSeconds) endSeconds = startSeconds + 1;
      endSeconds = Math.min(lastWholeSecond, endSeconds);
      if (endSeconds <= startSeconds) return null;
      if (endSeconds - startSeconds > MAX_SEGMENT_SECONDS) {
        endSeconds = startSeconds + MAX_SEGMENT_SECONDS;
      }
      const startShiftSeconds = roundedSeconds(startSeconds - rawStartSeconds);
      const endShiftSeconds = roundedSeconds(endSeconds - rawEndSeconds);
      const maximumShiftSeconds = Math.max(
        Math.abs(startShiftSeconds),
        Math.abs(endShiftSeconds),
      );
      const startBoundaryTrusted =
        (index === 0 && startSeconds === 0) ||
        Math.abs(startShiftSeconds) <= CLIP_BOUNDARY_TOLERANCE_SECONDS;
      const endBoundaryTrusted =
        Math.abs(endShiftSeconds) <= CLIP_BOUNDARY_TOLERANCE_SECONDS;
      const integerBoundaryTrusted =
        startBoundaryTrusted && endBoundaryTrusted;
      previousEnd = endSeconds;
      return {
        ...candidate,
        startSeconds,
        endSeconds,
        durationSeconds: endSeconds - startSeconds,
        rawStartSeconds: roundedSeconds(rawStartSeconds),
        rawEndSeconds: roundedSeconds(rawEndSeconds),
        integerSecondAligned: true,
        nativeFrameRate: Number(fps.toFixed(6)),
        startFrame: Math.round(startSeconds * fps),
        endFrame: Math.round(endSeconds * fps),
        startBoundaryTrusted,
        endBoundaryTrusted,
        integerBoundaryTrusted,
        requiresReview:
          Boolean(candidate.requiresReview) || !integerBoundaryTrusted,
        reviewReasons: [
          ...(candidate.reviewReasons || []),
          ...(!integerBoundaryTrusted
            ? [
                `原始语义边界距整数秒超过 ${CLIP_BOUNDARY_TOLERANCE_SECONDS} 秒，取整会产生多画面或少画面，禁止自动入库`,
              ]
            : []),
        ],
      };
    })
    .filter(
      (candidate) =>
        candidate &&
        candidate.durationSeconds >= 1 &&
        candidate.durationSeconds <= MAX_SEGMENT_SECONDS,
    );
};

const comparableTranscript = (value) =>
  String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[\s\p{P}\p{S}]+/gu, '');

const transcriptBigrams = (value) => {
  const normalized = comparableTranscript(value);
  if (normalized.length < 2) return new Set(normalized ? [normalized] : []);
  const result = new Set();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    result.add(normalized.slice(index, index + 2));
  }
  return result;
};

export const transcriptSimilarity = (leftValue, rightValue) => {
  const left = comparableTranscript(leftValue);
  const right = comparableTranscript(rightValue);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) {
    return (
      Math.min(left.length, right.length) / Math.max(left.length, right.length)
    );
  }
  const leftBigrams = transcriptBigrams(left);
  const rightBigrams = transcriptBigrams(right);
  let intersection = 0;
  for (const item of leftBigrams) {
    if (rightBigrams.has(item)) intersection += 1;
  }
  return (2 * intersection) / Math.max(1, leftBigrams.size + rightBigrams.size);
};

const intervalOverlapSeconds = (leftStart, leftEnd, rightStart, rightEnd) =>
  Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));

export const assessClipBoundaryIntegrity = ({
  clipStartSeconds,
  clipEndSeconds,
  sourceDurationSeconds,
  segments = [],
}) => {
  const clipStart = Math.max(0, Number(clipStartSeconds) || 0);
  const clipEnd = Math.min(
    Math.max(clipStart, Number(sourceDurationSeconds) || 0),
    Number(clipEndSeconds) || 0,
  );
  const clipDuration = Math.max(0, clipEnd - clipStart);
  const candidates = (Array.isArray(segments) ? segments : [])
    .map((segment) => {
      const startSeconds = Math.max(0, Number(segment?.startSeconds) || 0);
      const endSeconds = Math.min(
        Number(sourceDurationSeconds) || 0,
        Number(segment?.endSeconds) || 0,
      );
      const durationSeconds = Math.max(0, endSeconds - startSeconds);
      const overlapSeconds = intervalOverlapSeconds(
        clipStart,
        clipEnd,
        startSeconds,
        endSeconds,
      );
      const coverage =
        Math.min(clipDuration, durationSeconds) > 0
          ? overlapSeconds / Math.min(clipDuration, durationSeconds)
          : 0;
      const boundaryDistance =
        Math.abs(clipStart - startSeconds) + Math.abs(clipEnd - endSeconds);
      return {
        segment,
        startSeconds,
        endSeconds,
        durationSeconds,
        coverage,
        boundaryDistance,
      };
    })
    .filter(
      (candidate) =>
        candidate.durationSeconds >= MIN_SEGMENT_SECONDS &&
        candidate.coverage >= 0.5,
    )
    .sort(
      (left, right) =>
        right.coverage - left.coverage ||
        left.boundaryDistance - right.boundaryDistance,
    );
  const matched = candidates[0] || null;
  if (!matched) {
    return {
      status: 'review_required',
      score: 20,
      segmentId: null,
      transcript: '',
      canAutoAdjust: false,
      recommendedStartSeconds: null,
      recommendedEndSeconds: null,
      checks: [
        {
          name: '完整内容段匹配',
          passed: false,
          detail: '没有匹配到覆盖当前切片的可靠口播或动作段',
        },
      ],
      reasons: ['完整内容段匹配：没有匹配到覆盖当前切片的可靠口播或动作段'],
    };
  }

  const startDelta = clipStart - matched.startSeconds;
  const endDelta = clipEnd - matched.endSeconds;
  const startAligned = Math.abs(startDelta) <= CLIP_BOUNDARY_TOLERANCE_SECONDS;
  const endAligned = Math.abs(endDelta) <= CLIP_BOUNDARY_TOLERANCE_SECONDS;
  const trustedBoundary =
    !matched.segment.requiresReview &&
    ['high', 'manual'].includes(matched.segment.boundaryConfidence);
  const transcript = String(matched.segment.label || '').trim();
  const semanticClosure = trustedBoundary;
  const containsAdjacentContent =
    clipStart < matched.startSeconds - CLIP_BOUNDARY_TOLERANCE_SECONDS ||
    clipEnd > matched.endSeconds + CLIP_BOUNDARY_TOLERANCE_SECONDS;
  const targetDuration = matched.endSeconds - matched.startSeconds;
  const adjustmentDistance = Math.max(Math.abs(startDelta), Math.abs(endDelta));
  const canAutoAdjust =
    trustedBoundary &&
    targetDuration >= MIN_SEGMENT_SECONDS &&
    targetDuration <= MAX_SEGMENT_SECONDS &&
    adjustmentDistance > CLIP_BOUNDARY_TOLERANCE_SECONDS &&
    adjustmentDistance <= CLIP_BOUNDARY_AUTO_ADJUST_LIMIT_SECONDS;
  const checks = [
    {
      name: '完整内容段匹配',
      passed: matched.coverage >= 0.8,
      detail: `与候选完整段重合 ${Math.round(matched.coverage * 100)}%`,
    },
    {
      name: '起点完整',
      passed: startAligned,
      detail: startAligned
        ? '起点贴合完整内容段开头'
        : `起点偏差 ${roundedSeconds(Math.abs(startDelta))} 秒`,
    },
    {
      name: '终点完整',
      passed: endAligned && trustedBoundary,
      detail:
        endAligned && trustedBoundary
          ? '终点贴合可靠句末、停顿或视频边界'
          : !trustedBoundary
            ? '终点缺少可靠句末或停顿证据'
            : `终点偏差 ${roundedSeconds(Math.abs(endDelta))} 秒`,
    },
    {
      name: '未带入相邻内容',
      passed: !containsAdjacentContent,
      detail: containsAdjacentContent
        ? '切片超出当前完整内容段，可能带入前后无关画面'
        : '没有跨入前后相邻内容段',
    },
    {
      name: '语义闭合',
      passed: semanticClosure,
      detail: semanticClosure
        ? '文案或动作在可靠边界处完整结束'
        : '内容可能在半句话或半个动作处结束',
    },
  ];
  const reasons = checks
    .filter((check) => !check.passed)
    .map((check) => `${check.name}：${check.detail}`);
  return {
    status: reasons.length ? 'review_required' : 'passed',
    score: Math.round(
      (checks.filter((check) => check.passed).length / checks.length) * 100,
    ),
    segmentId: matched.segment.id || null,
    transcript,
    canAutoAdjust,
    recommendedStartSeconds: canAutoAdjust
      ? roundedSeconds(matched.startSeconds)
      : null,
    recommendedEndSeconds: canAutoAdjust
      ? roundedSeconds(matched.endSeconds)
      : null,
    checks,
    reasons,
  };
};

const mergeTranscript = (leftValue, rightValue) => {
  const left = String(leftValue || '').trim();
  const right = String(rightValue || '').trim();
  if (!left) return right;
  if (!right) return left;
  const comparableLeft = comparableTranscript(left);
  const comparableRight = comparableTranscript(right);
  if (comparableLeft.includes(comparableRight)) return left;
  if (comparableRight.includes(comparableLeft)) return right;
  return `${left}${STRONG_SENTENCE_END.test(left) ? '' : ' '}${right}`.trim();
};

const transcriptLooksIncremental = (leftValue, rightValue) => {
  const left = comparableTranscript(leftValue);
  const right = comparableTranscript(rightValue);
  if (!left || !right) return false;
  const containmentRatio =
    left.includes(right) || right.includes(left)
      ? Math.min(left.length, right.length) /
        Math.max(left.length, right.length)
      : 0;
  return containmentRatio >= 0.55 || transcriptSimilarity(left, right) >= 0.9;
};

export const extractSilenceWindows = (stderr, durationSeconds) => {
  const duration = Math.max(0, Number(durationSeconds) || 0);
  const events = [];
  for (const match of String(stderr || '').matchAll(
    /silence_(start|end):\s*([\d.]+)/gu,
  )) {
    events.push({ type: match[1], seconds: Number(match[2]) });
  }
  const windows = [];
  let startSeconds = null;
  for (const event of events) {
    if (!Number.isFinite(event.seconds)) continue;
    if (event.type === 'start') {
      startSeconds = Math.max(0, Math.min(duration, event.seconds));
      continue;
    }
    if (startSeconds === null) continue;
    const endSeconds = Math.max(
      startSeconds,
      Math.min(duration, event.seconds),
    );
    const silenceDuration = endSeconds - startSeconds;
    if (silenceDuration >= 0.35) {
      windows.push({
        startSeconds: roundedSeconds(startSeconds),
        endSeconds: roundedSeconds(endSeconds),
        midpointSeconds: roundedSeconds((startSeconds + endSeconds) / 2),
        durationSeconds: roundedSeconds(silenceDuration),
      });
    }
    startSeconds = null;
  }
  return windows;
};

export const extractSceneBoundaries = (stderr, durationSeconds) => {
  const duration = Math.max(0, Number(durationSeconds) || 0);
  return [
    ...new Set(
      [...String(stderr || '').matchAll(/pts_time:([\d.]+)/gu)]
        .map((match) => roundedSeconds(Number(match[1])))
        .filter(
          (seconds) =>
            Number.isFinite(seconds) &&
            seconds >= MIN_SEGMENT_SECONDS &&
            seconds <= duration - MIN_SEGMENT_SECONDS,
        ),
    ),
  ].sort((left, right) => left - right);
};

const transcriptBoundaries = (label, startSeconds, endSeconds) => {
  const text = String(label || '').trim();
  const comparableLength = Math.max(1, comparableTranscript(text).length);
  const boundaries = [];
  for (const match of text.matchAll(PUNCTUATION_PATTERN)) {
    const prefixLength = comparableTranscript(
      text.slice(0, match.index + 1),
    ).length;
    if (prefixLength <= 0 || prefixLength >= comparableLength) continue;
    const punctuation = match[0];
    boundaries.push({
      seconds:
        startSeconds +
        ((endSeconds - startSeconds) * prefixLength) / comparableLength,
      charIndex: match.index + 1,
      type: /[。！？!?；;…]/u.test(punctuation) ? 'sentence' : 'clause',
    });
  }
  return boundaries;
};

const nearbyPause = (seconds, silenceWindows, toleranceSeconds = 0.7) =>
  silenceWindows
    .filter(
      (window) =>
        window.durationSeconds >= 0.42 &&
        Math.abs(window.midpointSeconds - seconds) <= toleranceSeconds,
    )
    .sort(
      (left, right) =>
        Math.abs(left.midpointSeconds - seconds) -
          Math.abs(right.midpointSeconds - seconds) ||
        right.durationSeconds - left.durationSeconds,
    )[0] || null;

const nearbySceneBoundary = (
  seconds,
  sceneBoundaries,
  toleranceSeconds = 0.45,
) =>
  (Array.isArray(sceneBoundaries) ? sceneBoundaries : [])
    .map(Number)
    .filter(
      (boundary) =>
        Number.isFinite(boundary) &&
        Math.abs(boundary - seconds) <= toleranceSeconds,
    )
    .sort(
      (left, right) => Math.abs(left - seconds) - Math.abs(right - seconds),
    )[0] ?? null;

const splitLongCandidate = (candidate, silenceWindows) => {
  const duration = candidate.endSeconds - candidate.startSeconds;
  if (duration <= MAX_SEGMENT_SECONDS + 0.01) return [candidate];
  const textBoundaries = transcriptBoundaries(
    candidate.label,
    candidate.startSeconds,
    candidate.endSeconds,
  );
  const pauseBoundaries = silenceWindows
    .filter(
      (window) =>
        window.midpointSeconds > candidate.startSeconds + MIN_SEGMENT_SECONDS &&
        window.midpointSeconds < candidate.endSeconds - MIN_SEGMENT_SECONDS,
    )
    .map((window) => ({
      seconds: window.midpointSeconds,
      type: 'pause',
      silenceDuration: window.durationSeconds,
      charIndex: null,
    }));
  const availableBoundaries = [...textBoundaries, ...pauseBoundaries];
  const cuts = [];
  let cursor = candidate.startSeconds;
  let previousCharIndex = 0;
  while (candidate.endSeconds - cursor > MAX_SEGMENT_SECONDS + 0.01) {
    const minimum = cursor + Math.max(2, MIN_SEGMENT_SECONDS);
    const maximum = Math.min(
      cursor + MAX_SEGMENT_SECONDS,
      candidate.endSeconds - MIN_SEGMENT_SECONDS,
    );
    const desired = Math.min(cursor + TARGET_SEGMENT_SECONDS, maximum);
    const choices = availableBoundaries.filter(
      (boundary) =>
        boundary.seconds >= minimum &&
        boundary.seconds <= maximum &&
        (boundary.charIndex === null || boundary.charIndex > previousCharIndex),
    );
    choices.sort((left, right) => {
      const weight = (boundary) =>
        boundary.type === 'sentence'
          ? 5
          : boundary.type === 'pause'
            ? 4 + Math.min(2, boundary.silenceDuration || 0)
            : 2;
      const leftScore = weight(left) - Math.abs(left.seconds - desired) / 6;
      const rightScore = weight(right) - Math.abs(right.seconds - desired) / 6;
      return rightScore - leftScore;
    });
    const chosen = choices[0] || {
      seconds: Math.min(cursor + 18, maximum),
      type: 'duration',
      charIndex: null,
    };
    if (chosen.seconds - cursor < MIN_SEGMENT_SECONDS) break;
    cuts.push(chosen);
    cursor = chosen.seconds;
    if (chosen.charIndex !== null) previousCharIndex = chosen.charIndex;
  }

  const text = String(candidate.label || '').trim();
  const boundaries = [
    { seconds: candidate.startSeconds, charIndex: 0, type: 'source' },
    ...cuts,
    { seconds: candidate.endSeconds, charIndex: text.length, type: 'source' },
  ];
  let lastTextIndex = 0;
  return boundaries.slice(0, -1).map((boundary, index) => {
    const next = boundaries[index + 1];
    const inferredTextIndex = Math.round(
      ((next.seconds - candidate.startSeconds) / duration) * text.length,
    );
    const nextTextIndex = Math.max(
      lastTextIndex,
      Math.min(text.length, next.charIndex ?? inferredTextIndex),
    );
    const semanticText = text.slice(lastTextIndex, nextTextIndex).trim();
    const boundaryTrusted = ['sentence', 'pause', 'source'].includes(next.type);
    const part = {
      ...candidate,
      startSeconds: roundedSeconds(boundary.seconds),
      endSeconds: roundedSeconds(next.seconds),
      label: semanticText || candidate.label,
      boundaryType:
        next.type === 'pause'
          ? 'pause'
          : next.type === 'duration'
            ? 'fallback'
            : candidate.boundaryType,
      boundaryConfidence: boundaryTrusted ? 'high' : 'low',
      requiresReview: candidate.requiresReview || !boundaryTrusted,
      reviewReasons: [
        ...(candidate.reviewReasons || []),
        ...(!boundaryTrusted ? ['超过20秒且附近没有可靠句末或停顿'] : []),
      ],
    };
    lastTextIndex = nextTextIndex;
    return part;
  });
};

const clampCandidate = (candidate, durationSeconds) => {
  const startSeconds = Math.max(0, Number(candidate.startSeconds) || 0);
  const endSeconds = Math.min(
    durationSeconds,
    Number(candidate.endSeconds) || 0,
  );
  if (endSeconds - startSeconds < MIN_SEGMENT_SECONDS) return null;
  return { ...candidate, startSeconds, endSeconds };
};

const mergeAdjacentTranscriptCandidates = (candidates) => {
  const merged = [];
  for (const candidate of candidates) {
    const previous = merged[merged.length - 1];
    const gap = previous ? candidate.startSeconds - previous.endSeconds : 0;
    const incrementalTranscript = previous
      ? transcriptLooksIncremental(previous.label, candidate.label)
      : false;
    if (
      previous &&
      gap <= 1.1 &&
      incrementalTranscript &&
      candidate.endSeconds - previous.startSeconds <= MAX_SEGMENT_SECONDS + 4
    ) {
      previous.endSeconds = Math.max(previous.endSeconds, candidate.endSeconds);
      previous.label = mergeTranscript(previous.label, candidate.label);
      previous.sceneDescription = mergeTranscript(
        previous.sceneDescription,
        candidate.sceneDescription,
      );
      previous.sceneText = mergeTranscript(
        previous.sceneText,
        candidate.sceneText,
      );
      continue;
    }
    merged.push({ ...candidate });
  }
  return merged;
};

const mergeBrokenCutterSentences = (candidates, silenceWindows) => {
  const merged = [];
  for (const candidate of candidates) {
    const previous = merged[merged.length - 1];
    const gap = previous ? candidate.startSeconds - previous.endSeconds : 0;
    const previousHasTrustedEnd = previous
      ? STRONG_SENTENCE_END.test(String(previous.label || '').trim()) ||
        Boolean(nearbyPause(previous.endSeconds, silenceWindows))
      : true;
    const canCompletePreviousSentence =
      previous &&
      previous.transcriptSource === 'cutter' &&
      candidate.transcriptSource === 'cutter' &&
      String(previous.label || '').trim() &&
      String(candidate.label || '').trim() &&
      !previousHasTrustedEnd &&
      gap <= 0.8 &&
      candidate.endSeconds - previous.startSeconds <=
        MAX_SEGMENT_SECONDS + 0.01;
    if (canCompletePreviousSentence) {
      previous.endSeconds = Math.max(previous.endSeconds, candidate.endSeconds);
      previous.label = mergeTranscript(previous.label, candidate.label);
      previous.sceneDescription = mergeTranscript(
        previous.sceneDescription,
        candidate.sceneDescription,
      );
      previous.sceneText = mergeTranscript(
        previous.sceneText,
        candidate.sceneText,
      );
      previous.boundaryType = candidate.boundaryType || previous.boundaryType;
      continue;
    }
    merged.push({ ...candidate });
  }
  return merged;
};

export const normalizeSpeechCandidates = ({
  candidates,
  durationSeconds,
  silenceWindows = [],
  sceneBoundaries = [],
  frameRate = 30,
}) => {
  const duration = Math.max(0, Number(durationSeconds) || 0);
  const clamped = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => clampCandidate(candidate, duration))
    .filter(Boolean)
    .sort((left, right) => left.startSeconds - right.startSeconds);
  const merged = mergeAdjacentTranscriptCandidates(clamped);
  const sentenceMerged = mergeBrokenCutterSentences(merged, silenceWindows);
  const normalized = [];
  for (const candidate of sentenceMerged) {
    const endPause = nearbyPause(candidate.endSeconds, silenceWindows);
    const snappedEnd = endPause?.midpointSeconds;
    const sceneStart = nearbySceneBoundary(
      candidate.startSeconds,
      sceneBoundaries,
    );
    const sceneEnd = nearbySceneBoundary(candidate.endSeconds, sceneBoundaries);
    const visuallyAlignedStart =
      sceneStart !== null &&
      sceneStart <= candidate.startSeconds + 0.08 &&
      sceneStart < candidate.endSeconds - MIN_SEGMENT_SECONDS
        ? sceneStart
        : candidate.startSeconds;
    const nextCandidate = {
      ...candidate,
      startSeconds: visuallyAlignedStart,
      endSeconds:
        snappedEnd && snappedEnd > candidate.startSeconds + MIN_SEGMENT_SECONDS
          ? snappedEnd
          : sceneEnd !== null &&
              sceneEnd >= candidate.endSeconds - 0.08 &&
              sceneEnd > visuallyAlignedStart + MIN_SEGMENT_SECONDS
            ? sceneEnd
            : candidate.endSeconds,
      sceneBoundaryAligned: sceneStart !== null || sceneEnd !== null,
    };
    const hasSentenceEnd = STRONG_SENTENCE_END.test(
      String(nextCandidate.label || '').trim(),
    );
    const hasTrustedEnd =
      nextCandidate.endSeconds >= duration - 0.12 ||
      hasSentenceEnd ||
      Boolean(endPause);
    nextCandidate.boundaryConfidence = hasTrustedEnd ? 'high' : 'low';
    nextCandidate.requiresReview =
      Boolean(nextCandidate.requiresReview) || !hasTrustedEnd;
    nextCandidate.reviewReasons = [
      ...(nextCandidate.reviewReasons || []),
      ...(!hasTrustedEnd ? ['切点未贴合句末或有效停顿'] : []),
    ];
    normalized.push(...splitLongCandidate(nextCandidate, silenceWindows));
  }
  return alignSpeechCandidatesToIntegerSeconds({
    candidates: normalized.filter(
      (candidate) =>
        candidate.endSeconds - candidate.startSeconds >= MIN_SEGMENT_SECONDS,
    ),
    durationSeconds: duration,
    frameRate,
  }).slice(0, 36);
};

export const speechCandidatesFromSilence = (
  silenceWindows,
  durationSeconds,
  frameRate = 30,
) => {
  const duration = Math.max(0, Number(durationSeconds) || 0);
  const trustedBoundaries = (
    Array.isArray(silenceWindows) ? silenceWindows : []
  )
    .filter(
      (window) =>
        window.durationSeconds >= 0.5 &&
        window.midpointSeconds > 1.2 &&
        window.midpointSeconds < duration - 0.8,
    )
    .map((window) => window.midpointSeconds);
  const boundaries = [0, ...trustedBoundaries, duration];
  const candidates = [];
  let startSeconds = 0;
  for (let index = 1; index < boundaries.length; index += 1) {
    const endSeconds = boundaries[index];
    if (endSeconds - startSeconds < 1.5 && index < boundaries.length - 1) {
      continue;
    }
    candidates.push({
      startSeconds,
      endSeconds,
      boundaryType: index < boundaries.length - 1 ? 'pause' : 'fallback',
      transcriptSource: 'silence',
      label: '',
      boundaryConfidence: index < boundaries.length - 1 ? 'high' : 'low',
      requiresReview: true,
      reviewReasons: ['未获得可靠文案，候选切点必须人工确认'],
    });
    startSeconds = endSeconds;
  }
  if (!candidates.length && duration >= MIN_SEGMENT_SECONDS) {
    candidates.push({
      startSeconds: 0,
      endSeconds: duration,
      boundaryType: 'fallback',
      transcriptSource: 'silence',
      label: '',
      boundaryConfidence: 'low',
      requiresReview: true,
      reviewReasons: ['没有检测到可靠停顿，禁止自动视为语义切片'],
    });
  }
  return alignSpeechCandidatesToIntegerSeconds({
    candidates: candidates.flatMap((candidate) =>
      splitLongCandidate(candidate, silenceWindows),
    ),
    durationSeconds: duration,
    frameRate,
  });
};

export const mergeOcrSamples = (samples, intervalSeconds) => {
  const merged = [];
  for (const sample of Array.isArray(samples) ? samples : []) {
    const previous = merged[merged.length - 1];
    const gap = previous ? sample.startSeconds - previous.endSeconds : 0;
    const incrementalTranscript = previous
      ? transcriptLooksIncremental(previous.label, sample.text)
      : false;
    if (previous && gap <= intervalSeconds * 1.25 && incrementalTranscript) {
      previous.endSeconds = sample.endSeconds;
      previous.label = mergeTranscript(previous.label, sample.text);
      continue;
    }
    merged.push({
      startSeconds: sample.startSeconds,
      endSeconds: sample.endSeconds,
      boundaryType: 'ocr',
      transcriptSource: 'ocr',
      label: sample.text,
    });
  }
  return merged;
};
