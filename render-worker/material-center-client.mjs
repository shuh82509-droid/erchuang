import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const baseUrl = String(process.env.WIS_MATERIAL_CENTER_BASE_URL || '')
  .trim()
  .replace(/\/$/, '');
const apiToken = String(process.env.WIS_MATERIAL_CENTER_TOKEN || '').trim();
const configured = Boolean(baseUrl && apiToken.length >= 32);
const MATERIAL_CENTER_READ_TIMEOUT_MS = Math.max(
  250,
  Number(process.env.WIS_MATERIAL_CENTER_READ_TIMEOUT_MS) || 60_000,
);
const MATERIAL_CENTER_READ_MAX_ATTEMPTS = Math.max(
  1,
  Math.min(
    5,
    Math.trunc(Number(process.env.WIS_MATERIAL_CENTER_READ_MAX_ATTEMPTS) || 3),
  ),
);
const MATERIAL_CENTER_READ_RETRY_DELAY_MS = Math.max(
  10,
  Number(process.env.WIS_MATERIAL_CENTER_READ_RETRY_DELAY_MS) || 1_000,
);

const MATERIAL_CENTER_PRODUCT_CATEGORIES = Object.freeze([
  '待分类',
  '其他 WIS 素材',
  '晶润眼膜',
  '隐形水润面膜',
  '肌活蛋白喷雾',
  '深海次抛',
  '燕窝面膜',
  '黑晶面膜',
  '通用',
  '美白针',
  '黄金面膜',
  '颈膜',
]);

const MATERIAL_CENTER_CATEGORY_ALIASES = new Map([
  ['WIS隐形水润面膜', '隐形水润面膜'],
  ['水润面膜', '隐形水润面膜'],
  ['WIS晶润紧致眼膜', '晶润眼膜'],
  ['晶润紧致眼膜', '晶润眼膜'],
  ['通用切片', '通用'],
]);

const materialCenterCategoryForProduct = (value) => {
  const category = String(value || '')
    .normalize('NFKC')
    .trim();
  return MATERIAL_CENTER_CATEGORY_ALIASES.get(category) || category;
};

const workstationProductCategoryForMaterialCenter = (value) => {
  const category = materialCenterCategoryForProduct(value);
  if (!category || category === '待分类') return '';
  if (category === '隐形水润面膜') return 'WIS隐形水润面膜';
  if (category === '晶润眼膜') return '晶润紧致眼膜';
  if (category === '通用') return '通用切片';
  return category;
};

const parseResponse = async (response) => {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail =
      payload && typeof payload === 'object'
        ? payload.detail || payload.message
        : '';
    throw Object.assign(new Error(
      String(detail || `素材中心请求失败（${response.status}）`).slice(0, 240),
    ), {statusCode:response.status});
  }
  return payload;
};

const wait = (durationMs) =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

const isRetryableReadResponse = (status) =>
  [408, 425, 429].includes(Number(status)) || Number(status) >= 500;

const isRetryableReadError = (error) =>
  /abort|timeout|timed out|fetch failed|network|socket|econnreset|etimedout|eai_again/iu.test(
    `${error?.name || ''} ${error?.message || error || ''}`,
  );

const request = async (pathName, init = {}, policy = {}) => {
  if (!configured) throw new Error('素材中心双向接口尚未配置。');
  const headers = new Headers(init.headers);
  headers.set('X-WIS-Workstation-Token', apiToken);
  if (
    init.body &&
    !(init.body instanceof Uint8Array) &&
    !headers.has('Content-Type')
  ) {
    headers.set('Content-Type', 'application/json');
  }
  const method = String(init.method || 'GET').toUpperCase();
  const safeRead = method === 'GET' || method === 'HEAD';
  const maximumAttempts = safeRead ? (policy.maxAttempts || MATERIAL_CENTER_READ_MAX_ATTEMPTS) : 1;
  let lastError = null;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}${pathName}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(
          safeRead ? (policy.timeoutMs || MATERIAL_CENTER_READ_TIMEOUT_MS) : 30_000,
        ),
      });
      if (
        safeRead &&
        attempt < maximumAttempts &&
        !response.ok &&
        isRetryableReadResponse(response.status)
      ) {
        await response.arrayBuffer().catch(() => undefined);
        await wait(MATERIAL_CENTER_READ_RETRY_DELAY_MS * attempt);
        continue;
      }
      return parseResponse(response);
    } catch (error) {
      lastError = error;
      if (
        !safeRead ||
        attempt >= maximumAttempts ||
        !isRetryableReadError(error)
      ) {
        throw error;
      }
      await wait(MATERIAL_CENTER_READ_RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError || new Error('素材中心读取失败。');
};

const mapAsset = (asset) => {
  const deletionStatus = String(
    asset.deletion_status || asset.recycle_status || asset.trash_status || '',
  );
  const isDeleted = Boolean(
    asset.is_deleted ||
    asset.deleted_at ||
    /deleted|trash|recycle|回收|删除/u.test(deletionStatus),
  );
  return {
    id: Number(asset.id),
    filename: String(asset.filename || ''),
    objectKey: String(asset.object_key || ''),
    size: Number(asset.size || 0),
    modifiedAt: String(asset.modified_at || ''),
    category: materialCenterCategoryForProduct(asset.category || '待分类'),
    contentType: String(asset.content_type || '其他'),
    assetSubtype: String(asset.asset_subtype || '其他视频素材'),
    libraryType: asset.library_type === 'remix' ? 'remix' : 'source',
    folderName: String(asset.folder_name || ''),
    tags: Array.isArray(asset.tags) ? asset.tags.map(String) : [],
    coverUrl: String(asset.cover_url || ''),
    previewUrl: String(asset.preview_url || ''),
    downloadUrl: String(asset.download_url || ''),
    storageUrl: String(asset.storage_url || ''),
    deletionStatus,
    isDeleted,
    rightsStatus: String(
      asset.rights_status ||
        asset.permission_status ||
        asset.license_status ||
        '',
    ),
    uploadedByName: String(asset.uploaded_by_name || ''),
    source: String(asset.source || ''),
    referenceUrl: String(asset.reference_url || ''),
    effective: Boolean(asset.effective),
    effectiveMarkedAt: asset.effective_marked_at
      ? String(asset.effective_marked_at)
      : null,
    effectiveMarkedByName: String(asset.effective_marked_by_name || ''),
  };
};

const mapFilterOption = (option) => {
  if (typeof option === 'string') {
    const value = option.trim();
    return value ? { value, label: value, count: null } : null;
  }
  if (!option || typeof option !== 'object') return null;
  const value = String(
    option.value || option.name || option.label || option.folder_name || '',
  ).trim();
  if (!value) return null;
  const rawCount = Number(option.count);
  return {
    value,
    label: String(option.label || option.name || value).trim() || value,
    count: Number.isFinite(rawCount) && rawCount >= 0 ? rawCount : null,
  };
};

const uniqueFilterOptions = (options) => {
  const byValue = new Map();
  for (const option of options) {
    const mapped = mapFilterOption(option);
    if (!mapped || byValue.has(mapped.value)) continue;
    byValue.set(mapped.value, mapped);
  }
  return [...byValue.values()].sort((left, right) =>
    left.label.localeCompare(right.label, 'zh-CN'),
  );
};

const orderedProductCategoryOptions = (options) => {
  const optionsByValue = new Map(
    uniqueFilterOptions(options).map((option) => {
      const value = materialCenterCategoryForProduct(option.value);
      return [value, { ...option, value, label: value }];
    }),
  );
  const knownOptions = MATERIAL_CENTER_PRODUCT_CATEGORIES.map(
    (category) =>
      optionsByValue.get(category) || {
        value: category,
        label: category,
        count: null,
      },
  );
  const extraOptions = [...optionsByValue.values()]
    .filter(
      (option) => !MATERIAL_CENTER_PRODUCT_CATEGORIES.includes(option.value),
    )
    .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'));
  return [...knownOptions, ...extraOptions];
};

const mapAssetFilters = (payload, items, selectedCategory, selectedFolder) => {
  const filters =
    payload?.filters && typeof payload.filters === 'object'
      ? payload.filters
      : {};
  const facets =
    payload?.facets && typeof payload.facets === 'object' ? payload.facets : {};
  const categories = [
    ...(Array.isArray(filters.categories) ? filters.categories : []),
    ...(Array.isArray(facets.categories) ? facets.categories : []),
    ...(Array.isArray(payload?.categories) ? payload.categories : []),
    ...(Array.isArray(payload?.category_options)
      ? payload.category_options
      : []),
  ];
  const folders = [
    ...(Array.isArray(filters.folders) ? filters.folders : []),
    ...(Array.isArray(facets.folders) ? facets.folders : []),
    ...(Array.isArray(payload?.folders) ? payload.folders : []),
    ...(Array.isArray(payload?.folder_options) ? payload.folder_options : []),
  ];
  if (!categories.length) {
    categories.push(...items.map((item) => item.category).filter(Boolean));
  }
  if (!folders.length) {
    folders.push(...items.map((item) => item.folderName).filter(Boolean));
  }
  if (selectedCategory) categories.push(selectedCategory);
  if (selectedFolder) folders.push(selectedFolder);
  return {
    categories: orderedProductCategoryOptions(categories),
    folders: uniqueFilterOptions(folders),
  };
};

const mapReturn = (payload) => ({
  idempotencyKey: String(payload.idempotency_key || ''),
  status: String(payload.status || 'pending'),
  assetId: payload.asset_id == null ? null : Number(payload.asset_id),
  assetAvailable: Boolean(payload.asset_available),
  asset: payload.asset ? mapAsset(payload.asset) : null,
  filename: String(payload.filename || ''),
  objectKey: String(payload.object_key || ''),
  sha256: String(payload.sha256 || ''),
  provenance:
    payload.provenance && typeof payload.provenance === 'object'
      ? payload.provenance
      : {},
  errorMessage: String(payload.error_message || ''),
  createdAt: String(payload.created_at || ''),
  updatedAt: String(payload.updated_at || ''),
  completedAt: payload.completed_at ? String(payload.completed_at) : null,
  attemptedAt: String(payload.updated_at || payload.created_at || ''),
});

const listAssets = async ({
  query = '',
  page = 1,
  pageSize = 20,
  libraryType = 'source',
  category = '',
  folder = '',
  effectiveOnly = false,
} = {}) => {
  const selectedCategory = materialCenterCategoryForProduct(category);
  const search = new URLSearchParams({
    q: String(query || ''),
    page: String(page),
    page_size: String(pageSize),
    library_type: String(libraryType || 'source'),
    category: selectedCategory,
    folder_name: String(folder || ''),
    effective_only: effectiveOnly ? 'true' : 'false',
  });
  const payload = await request(`/assets?${search.toString()}`);
  const items = Array.isArray(payload.items) ? payload.items.map(mapAsset) : [];
  return {
    configured: true,
    items,
    total: Number(payload.total || 0),
    page: Number(payload.page || page),
    pageSize: Number(payload.page_size || pageSize),
    libraryType: ['all', 'source', 'remix'].includes(payload.library_type)
      ? payload.library_type
      : libraryType,
    source: String(payload.source || ''),
    sourceUpdatedAt: payload.source_updated_at
      ? String(payload.source_updated_at)
      : null,
    filters: mapAssetFilters(payload, items, selectedCategory, folder),
    selectedCategory,
    selectedFolder: String(folder || ''),
    effectiveOnly: Boolean(effectiveOnly),
  };
};

const getAsset = async (assetId) =>
  mapAsset(await request(`/assets/${encodeURIComponent(String(assetId))}`));

const listPrivateAssets = async (actorNumber, { query = '', page = 1 } = {}) =>
  request(`/private-assets?${new URLSearchParams({ actor_number: actorNumber, q: query, page: String(page), page_size: '24' })}`);

const getPrivateAsset = async (assetId, actorNumber) =>
  request(`/private-assets/${encodeURIComponent(assetId)}?${new URLSearchParams({ actor_number: actorNumber })}`);

const downloadPrivateAsset = async (asset, actorNumber, destination, maxFileBytes) => {
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > maxFileBytes)
    throw new Error('私人素材大小无效或超过工作台限制。');
  const response = await fetch(`${baseUrl}/private-assets/${encodeURIComponent(asset.id)}/media?${new URLSearchParams({ actor_number: actorNumber })}`, {
    headers: { 'X-WIS-Workstation-Token': apiToken },
    redirect: 'error',
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!response.ok || !response.body) throw new Error(`私人素材读取失败（${response.status}），未改为公开下载。`);
  let received = 0;
  await pipeline(Readable.fromWeb(response.body), async function* (stream) {
    for await (const chunk of stream) {
      received += chunk.length;
      if (received > asset.size || received > maxFileBytes) throw new Error('私人素材响应超过预期大小。');
      yield chunk;
    }
  }, createWriteStream(destination, { flags: 'wx' }));
  if (received !== asset.size) throw new Error('私人素材下载不完整，请重试。');
};

const downloadAsset = async (asset, destination, maxFileBytes) => {
  if (!asset.downloadUrl) throw new Error('素材中心没有返回可下载的视频地址。');
  if (
    !Number.isFinite(asset.size) ||
    asset.size <= 0 ||
    asset.size > maxFileBytes
  ) {
    throw new Error('素材文件大小无效或超过工作台限制。');
  }
  const response = await fetch(asset.downloadUrl, {
    redirect: 'error',
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`素材中心视频下载失败（${response.status}）。`);
  }
  let received=0;
  await pipeline(Readable.fromWeb(response.body),async function*(stream){
    for await(const chunk of stream){
      received+=chunk.length;
      if(received>asset.size || received>maxFileBytes)throw new Error('素材中心视频响应超过预期大小。');
      yield chunk;
    }
  },createWriteStream(destination,{flags:'wx'}));
  const stat = await fs.stat(destination);
  if (stat.size !== asset.size) {
    await fs.rm(destination, { force: true });
    throw new Error('素材中心视频下载不完整，请重试。');
  }
};

const createReturn = async (input) => {
  const payload = await request('/returns/presign', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return {
    ...mapReturn(payload),
    uploadRequired: Boolean(payload.upload_required),
    uploadUrl: String(payload.upload_url || ''),
    headers:
      payload.headers && typeof payload.headers === 'object'
        ? payload.headers
        : {},
    expiresIn: Number(payload.expires_in || 0),
  };
};

const uploadReturnFile = async (ticket, filePath, size) => {
  if (!ticket.uploadRequired) return;
  if (!ticket.uploadUrl) throw new Error('素材中心没有返回成片上传地址。');
  const headers = new Headers(ticket.headers);
  headers.set('Content-Length', String(size));
  const response = await fetch(ticket.uploadUrl, {
    method: 'PUT',
    headers,
    body: createReadStream(filePath),
    duplex: 'half',
    signal: AbortSignal.timeout(20 * 60 * 1000),
  });
  if (!response.ok) {
    throw new Error(`成片上传到素材中心失败（${response.status}）。`);
  }
};

const completeReturn = async (idempotencyKey) =>
  mapReturn(
    await request('/returns/complete', {
      method: 'POST',
      body: JSON.stringify({ idempotency_key: idempotencyKey }),
    }),
  );

const getReturn = async (idempotencyKey) =>
  mapReturn(
    await request(`/returns/${encodeURIComponent(String(idempotencyKey))}`),
  );

const mapQianchuanTask = (task) => ({
  id: String(task?.id || ''),
  assetId: Number(task?.asset_id || 0),
  assetName: String(task?.asset_name || ''),
  advertiserId: String(task?.advertiser_id || ''),
  advertiserName: String(task?.advertiser_name || ''),
  planId: String(task?.plan_id || ''),
  planName: String(task?.plan_name || ''),
  planType: String(task?.plan_type || ''),
  platformAssetId: String(task?.platform_asset_id || ''),
  bindingVerifiedAt: task?.binding_verified_at ? String(task.binding_verified_at) : null,
  platformAudit: task?.platform_audit && typeof task.platform_audit === 'object' ? task.platform_audit : null,
  idempotencyKey: String(task?.idempotency_key || ''),
  status: String(task?.status || 'pending'),
  message: String(task?.message || ''),
  errorMessage: String(task?.error_message || ''),
  errorAdvice: String(task?.error_advice || ''),
  failureStage: String(task?.failure_stage || ''),
  metrics:
    task?.metrics && typeof task.metrics === 'object' ? task.metrics : {},
  metricsLinkStatus: String(task?.metrics_link_status || 'pending'),
  metricsDataStatus: String(task?.metrics_data_status || 'pending'),
  metricsFreshThrough: task?.metrics_fresh_through
    ? String(task.metrics_fresh_through)
    : null,
  metricsCoverage:
    task?.metrics_coverage && typeof task.metrics_coverage === 'object'
      ? task.metrics_coverage
      : { completed: 0, expected: 0 },
  dailyMetrics: Array.isArray(task?.daily_metrics) ? task.daily_metrics : [],
  createdAt: String(task?.created_at || ''),
  updatedAt: String(task?.updated_at || ''),
});

const listQianchuanAccounts = async () => {
  const payload = await request('/qianchuan/accounts');
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return {
    items: items.map((item) => ({
      id: String(item?.id || item?.advertiser_id || ''),
      name: String(item?.name || item?.advertiser_name || ''),
    })),
    total: Number(payload?.total) || items.length,
    source: String(payload?.source || ''),
    sourceReadAt: String(payload?.source_read_at || ''),
  };
};

const getQianchuanProductPlanMap = async () => {
  const payload = await request('/qianchuan/product-plan-map');
  const source =
    payload?.source && typeof payload.source === 'object' ? payload.source : {};
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return {
    source: {
      title: String(source.title || ''),
      url: String(source.url || ''),
      documentId: String(source.document_id || ''),
      revision: Number(source.revision || 0),
      verifiedAt: String(source.verified_at || ''),
    },
    items: items.map((item) => ({
      key: String(item?.key || ''),
      label: String(item?.label || ''),
      aliases: Array.isArray(item?.aliases) ? item.aliases.map(String) : [],
      rules: (Array.isArray(item?.rules) ? item.rules : []).map((rule) => ({
        advertiserId: String(rule?.advertiser_id || ''),
        advertiserName: String(rule?.advertiser_name || ''),
        scope: String(rule?.scope || 'all'),
        matchMode: String(rule?.match_mode || 'keyword'),
        keyword: String(rule?.keyword || ''),
        planId: String(rule?.plan_id || ''),
      })),
    })),
  };
};

const listQianchuanPlans = async ({
  advertiserId,
  query = '',
  scope = 'all',
  refresh = false,
  cachedOnly = false,
}) => {
  const search = new URLSearchParams({
    advertiser_id: String(advertiserId || ''),
    q: String(query || ''),
    scope: String(scope || 'all'),
    refresh: refresh ? 'true' : 'false',
    cached_only: cachedOnly ? 'true' : 'false',
  });
  const payload = await request(`/qianchuan/plans?${search.toString()}`);
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return {
    items: items.map((item) => ({
      id: String(item?.id || ''),
      name: String(item?.name || ''),
      planType: String(item?.plan_type || 'standard'),
      planTypeLabel: String(item?.plan_type_label || ''),
      status: String(item?.status || ''),
      statusLabel: String(item?.status_label || ''),
      marketingGoal: String(item?.marketing_goal || ''),
      canAttachVideo: Boolean(item?.can_attach_video),
      isFull: Boolean(item?.is_full),
      capacityMessage: String(item?.capacity_message || ''),
    })),
    total: Number(payload?.total) || items.length,
    complete: payload?.complete !== false,
    cached: Boolean(payload?.cached),
    warnings: Array.isArray(payload?.warnings)
      ? payload.warnings.map(String)
      : [],
    sourceReadAt: String(payload?.source_read_at || ''),
  };
};

const verifyQianchuanTarget = async ({ advertiserId, planId, planType }) => {
  const search = new URLSearchParams({
    advertiser_id: String(advertiserId || ''),
    plan_id: String(planId || ''),
    plan_type: String(planType || ''),
  });
  const payload = await request(
    `/qianchuan/targets/verify?${search.toString()}`,
  );
  return {
    verified: Boolean(payload.verified),
    authorized: Boolean(payload.authorized),
    account: {
      id: String(payload.account?.id || ''),
      name: String(payload.account?.name || ''),
    },
    plan: {
      id: String(payload.plan?.id || ''),
      name: String(payload.plan?.name || ''),
      planType: String(payload.plan?.plan_type || ''),
      status: String(payload.plan?.status || ''),
      statusLabel: String(payload.plan?.status_label || ''),
      marketingGoal: String(payload.plan?.marketing_goal || ''),
      canAttachVideo: Boolean(payload.plan?.can_attach_video),
    },
    verifiedAt: String(payload.verified_at || ''),
    source: String(payload.source || ''),
  };
};

const pushQianchuan = async (input) => {
  const payload = await request('/qianchuan/push', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return {
    status: String(payload.status || ''),
    message: String(payload.message || ''),
    task: payload.task ? mapQianchuanTask(payload.task) : null,
    target: payload.target || null,
    guard: payload.guard || null,
  };
};

const getQianchuanDelivery = async (idempotencyKey) => {
  const payload = await request(
    `/qianchuan/deliveries/${encodeURIComponent(String(idempotencyKey))}`,
  );
  return {
    status: String(payload.status || ''),
    task: payload.task ? mapQianchuanTask(payload.task) : null,
  };
};

const retryQianchuanDelivery = async (idempotencyKey) => {
  const payload = await request(
    `/qianchuan/deliveries/${encodeURIComponent(String(idempotencyKey))}/retry`,
    { method: 'POST' },
  );
  return {
    status: String(payload.status || ''),
    task: payload.task ? mapQianchuanTask(payload.task) : null,
  };
};

const getReturnFeedback = async ({ idempotencyKey, actorNumber, renderId, variantId }) => {
  const query = new URLSearchParams({ actor_number: actorNumber, render_id: renderId, variant_id: variantId });
  const payload = await request(`/returns/${encodeURIComponent(idempotencyKey)}/feedback?${query}`, {}, { timeoutMs: 5000, maxAttempts: 1 });
  return {
    assetId: Number(payload.asset_id || 0),
    assetAvailable: payload.asset_available === true,
    complete: payload.complete !== false,
    checkedAt: String(payload.checked_at || ''),
    items: (Array.isArray(payload.items) ? payload.items : []).map(mapQianchuanTask),
  };
};

const materialCenterClient = {
  configured,
  listAssets,
  getAsset,
  downloadAsset,
  listPrivateAssets,
  getPrivateAsset,
  downloadPrivateAsset,
  createReturn,
  uploadReturnFile,
  completeReturn,
  getReturn,
  listQianchuanAccounts,
  getQianchuanProductPlanMap,
  listQianchuanPlans,
  verifyQianchuanTarget,
  pushQianchuan,
  getQianchuanDelivery,
  retryQianchuanDelivery,
  getReturnFeedback,
};

export {
  MATERIAL_CENTER_PRODUCT_CATEGORIES,
  materialCenterCategoryForProduct,
  materialCenterClient,
  workstationProductCategoryForMaterialCenter,
};
