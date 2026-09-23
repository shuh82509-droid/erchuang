import fs from 'node:fs/promises';

const stamp = s => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');

// External CAS publishers replace a read-only library atomically. Validate the
// file identity before serving a cached object; never return lastGood as fresh
// after an unreadable or invalid replacement. Writable services keep their own
// serialized writer cache and do not use this reader.
export function createReadonlyLibrarySnapshot({file, normalize = value => value,
  onReload = () => {}, io = fs}) {
  let cached, cachedStamp, inflight;
  const read = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await io.lstat(file, {bigint: true});
      if (!before.isFile() || before.isSymbolicLink()) throw new Error('素材库快照不是普通文件');
      const version = stamp(before);
      if (cachedStamp === version) return cached;
      const body = await io.readFile(file, 'utf8');
      const after = await io.lstat(file, {bigint: true});
      if (!after.isFile() || after.isSymbolicLink() || stamp(after) !== version) continue;
      const next = normalize(JSON.parse(body));
      onReload();
      cached = next;
      cachedStamp = version;
      return cached;
    }
    throw new Error('素材库正在更新，请稍后刷新；未把旧快照标记为最新');
  };
  return () => {
    if (!inflight) inflight = read().finally(() => { inflight = null; });
    return inflight;
  };
}
