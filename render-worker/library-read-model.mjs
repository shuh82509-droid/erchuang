// Derived, request-scoped indexes. Never attach indexes to the mutable writer.
export const readIndexes = Symbol('remix-read-indexes');
export const indexedLibrary = (library) => ({
  ...library,
  [readIndexes]: {
    sources: new Map(library.sources.map(item => [item.id, item])),
    clips: new Map(library.clips.map(item => [item.id, item])),
  },
});

const sourceFields = [
  'visibility', 'id', 'originalName', 'tags', 'isMine', 'size', 'durationSeconds',
  'hasAudio', 'frameRate', 'nominalFrameRate', 'variableFrameRate', 'timeBase',
  'frameCount', 'uploadedAt', 'previewUrl', 'browserPreviewStatus',
  'browserPreviewError', 'analysisStatus', 'analysisMessage', 'analysisProvider',
  'analysisTaskId', 'analysisUpdatedAt', 'sourceType', 'materialCenterAssetId',
  'cloudPrivateAssetId', 'materialCenterObjectKey', 'materialCenterCategory',
  'materialCenterFolderName', 'materialCenterLibraryType', 'materialCenterImportedAt',
  'materialCenterEffective', 'materialCenterEffectiveMarkedAt',
  'materialCenterEffectiveImportedAt', 'productCategory',
];
export const sourceSummary = (source) => ({
  ...Object.fromEntries(sourceFields.filter(key => source[key] !== undefined).map(key => [key, source[key]])),
  speechSegments: [],
  speechSegmentCount: source.speechSegments?.length || 0,
  detailsLoaded: false,
});

export const selectRecordPage = (items, params, kind, folders = []) => {
  const pageSize = Math.max(1, Math.min(100, Math.trunc(Number(params.get('pageSize')) || 24)));
  const requestedPage = Math.max(1, Math.trunc(Number(params.get('page')) || 1));
  const ids = params.has('ids') ? new Set(params.get('ids').split(',').slice(0, 100).filter(Boolean)) : null;
  const query = (params.get('q') || '').trim().toLocaleLowerCase('zh-CN');
  const category = params.get('productCategory');
  const role = params.get('role');
  const status = params.get('status');
  const folder = params.get('folder');
  const descendants = new Set();
  if (folder?.startsWith('folder:')) {
    descendants.add(folder.slice(7));
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of folders) if (descendants.has(row.parentId) && !descendants.has(row.id)) {
        descendants.add(row.id); changed = true;
      }
    }
  }
  const filtered = items.filter(item => {
    if (ids && !ids.has(item.id)) return false;
    if (query && ![item.originalName, item.name, item.role, item.productCategory, ...(item.tags || [])].join(' ').toLocaleLowerCase('zh-CN').includes(query)) return false;
    if (category && category !== 'all' && item.productCategory !== category) return false;
    if (role && role !== 'all' && item.role !== role) return false;
    if (status && status !== 'all' && item.reviewStatus !== status) return false;
    if (folder === 'mine' && !item.isMine) return false;
    if (folder === 'private' && item.visibility !== 'private') return false;
    if (kind === 'clips') {
      if (['pending', 'approved', 'changes_requested'].includes(folder) && item.reviewStatus !== folder) return false;
      if (folder?.startsWith('source:') && item.sourceId !== folder.slice(7)) return false;
      if (descendants.size && !descendants.has(item.folderId)) return false;
    }
    return true;
  });
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(filtered.length / pageSize)));
  return { items: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, page, pageSize };
};
