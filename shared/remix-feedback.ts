import type {
  ClipRemixVariant,
  QianchuanAutomaticDeliveryState,
} from './material-workstation.interface';

export const remixGenerationLabel = (automatic: boolean) =>
  automatic ? '全自动混剪' : 'AI混剪';

export function outputDeliveryStates(
  variant: ClipRemixVariant,
): QianchuanAutomaticDeliveryState[] {
  const automatic = variant.qianchuanDeliveries?.length
    ? variant.qianchuanDeliveries
    : variant.qianchuanDelivery
      ? [variant.qianchuanDelivery]
      : [];
  // A task's updatedAt may predate its separately refreshed daily metrics.
  // Compare the receipt read time for cloud snapshots, not just task mutations.
  const items = [
    ...(variant.cloudDeliveryFeedback?.items || []).map((state) => ({
      state,
      readAt: variant.cloudDeliveryFeedback?.checkedAt || state.updatedAt,
    })),
    ...automatic.map((state) => ({ state, readAt: state.updatedAt })),
  ]
    .sort((a, b) => String(b.readAt).localeCompare(String(a.readAt)))
    .map(({ state }) => state);
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.advertiserId}:${item.planId}:${item.platformAssetId || item.idempotencyKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function verifiedDeliveryMetric(
  state: QianchuanAutomaticDeliveryState,
  key: string,
): number | null {
  if (
    state.metricsLinkStatus !== 'verified' ||
    !['fresh', 'partial', 'partial_error', 'no_data'].includes(
      state.metricsDataStatus,
    )
  )
    return null;
  const raw = state.metrics?.[key];
  if (
    !['string', 'number'].includes(typeof raw) ||
    (typeof raw === 'string' && !raw.trim())
  )
    return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export const deliveryWasVerified = (state: QianchuanAutomaticDeliveryState) =>
  state.status === 'success' &&
  Boolean(state.platformAssetId && state.bindingVerifiedAt);

export const outputWasPushed = (variant: ClipRemixVariant) =>
  outputDeliveryStates(variant).some(deliveryWasVerified);
