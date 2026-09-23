import {VISUAL_REVIEW_VERSION} from './visual-quality.mjs';
export const hasPassedVisualReview = (assessment, sha256) => Boolean(
  sha256 && assessment?.visualReview?.status === 'passed' &&
  assessment.visualReview.sha256 === sha256 && assessment.visualReview.version === VISUAL_REVIEW_VERSION &&
  assessment.visualReview.confidence >= 0.9 &&
  Array.isArray(assessment.visualReview.issues) && assessment.visualReview.issues.length === 0,
);

export function visualTimeline(clips, sources) {
  const byId = new Map(sources.map(source => [source.id, source]));
  let cursor = 0;
  return clips.map(clip => {
    const source = byId.get(clip.sourceId);
    const sourceText = (source?.speechSegments || [])
      .filter(segment => segment.endSeconds > clip.startSeconds && segment.startSeconds < clip.endSeconds)
      .map(segment => segment.text || segment.label || '').join(' ').slice(0, 1600);
    const result = {clipId:clip.id, role:clip.role, start:cursor, duration:clip.durationSeconds,
      sourceCategory:clip.productCategory, sourceText};
    cursor += clip.durationSeconds;
    return result;
  });
}

export function needsVisualAttention(variant) {
  const review = variant.automaticAssessment?.visualReview;
  return Boolean(review && (review.status !== 'passed' || review.version !== VISUAL_REVIEW_VERSION) && review.reason !== 'technical_prerequisite');
}
