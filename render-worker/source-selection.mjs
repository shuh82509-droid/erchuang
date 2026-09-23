// Product sources come first. A slow fallback library must not discard usable
// product sources or force every category and page to be fetched for one gap.
export async function collectSourceCandidates({listAssets, selectors, limit, eligible, compare, effectiveOnly = false, maxPages = 5}) {
  const target = Math.max(0, Math.trunc(Number(limit) || 0));
  const items = new Map(), issues = [];
  if (!target) return {items: [], issues};
  for (const selector of selectors) {
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
      let page;
      try {
        page = await listAssets({...selector, libraryType: 'source', effectiveOnly, page: pageNumber, pageSize: 100});
        if (!Array.isArray(page?.items) || !Number.isFinite(Number(page.total)) || Number(page.total) < 0)
          throw new Error('素材列表响应不完整，需重新核验');
      } catch (error) {
        issues.push({selector: selector.category || selector.query || '素材库', page: pageNumber,
          message: String(error?.message || '素材读取失败').slice(0, 240)});
        break;
      }
      for (const item of page.items) {
        if (Number(item.id) > 0 && eligible(item)) items.set(Number(item.id), item);
      }
      if (items.size >= target) break;
      const pageSize = Math.max(1, Number(page.pageSize) || 100);
      if (!page.items.length || pageNumber * pageSize >= Number(page.total)) break;
    }
    if (items.size >= target) break;
  }
  if (!items.size && issues.length) {
    throw new Error(issues.map(issue => `${issue.selector}第${issue.page}页：${issue.message}`).join('；'));
  }
  const ordered = [...items.values()];
  if (compare) ordered.sort(compare);
  return {items: ordered.slice(0, target), issues};
}
