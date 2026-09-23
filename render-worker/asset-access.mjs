export const normalizeVisibility = (value) =>
  value === 'private' ? 'private' : 'team';
export const canReadSource = (source, identity) =>
  Boolean(source) &&
  (source.visibility !== 'private' || source.createdById === identity?.id);
export const canReadClip = (clip, source, identity) =>
  Boolean(clip) &&
  canReadSource(source, identity) &&
  (clip.visibility !== 'private' || clip.createdByIds?.includes(identity?.id));
export const clipIsBlocked = (clip) =>
  clip?.reviewStatus === 'rejected' ||
  clip?.deliveryBlocked === true ||
  (clip?.reviewStatus === 'changes_requested' &&
    /卡审|违规|禁用|侵权|虚假/u.test(clip.reviewNote || ''));
export const assertSourceAccess = (source, identity) => {
  if (!canReadSource(source, identity))
    throw new Error('素材不存在或无权访问。');
};
