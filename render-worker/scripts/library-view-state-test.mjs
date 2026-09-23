import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const code = ts.transpileModule(await readFile(new URL('../../client/src/pages/material-studio/library-view-state.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { mergeLibrarySnapshot, stableValue } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const fixture = () => ({
  sources: [{ id: 's', originalName: 'source', detailsLoaded: true, speechSegments: [{ id: 'cut', startSeconds: 1, endSeconds: 4 }] }],
  clips: [{ id: 'c', sourceId: 's', reviewStatus: 'approved' }], renders: [], frameworks: [], folders: [],
  automation: { jobs: [] }, permissions: { autoRemix: { currentUser: { id: 'A' } } },
});
test('compact polling preserves loaded cuts and stable unrelated arrays', () => {
  const old = fixture();
  const compact = structuredClone(old);
  compact.sources[0].speechSegments = [];
  compact.sources[0].detailsLoaded = false;
  const next = mergeLibrarySnapshot(old, compact);
  assert.strictEqual(next.sources, old.sources);
  assert.strictEqual(next.clips, old.clips);
  assert.strictEqual(next.automation, old.automation);
  assert.deepEqual(next.sources[0].speechSegments, [{ id: 'cut', startSeconds: 1, endSeconds: 4 }]);
});
test('revoked/deleted sources are removed; a new identity never inherits old details', () => {
  const old = fixture();
  assert.equal(mergeLibrarySnapshot(old, { ...old, sources: [] }).sources.length, 0);
  const compact = structuredClone(old);
  compact.permissions.autoRemix.currentUser.id = 'B';
  compact.sources[0].detailsLoaded = false;
  compact.sources[0].speechSegments = [];
  assert.strictEqual(mergeLibrarySnapshot(old, compact), compact);
});
test('changed review states and saved detail content are not hidden by caching', () => {
  const old = fixture(); const next = structuredClone(old);
  next.clips[0].reviewStatus = 'changes_requested';
  next.sources[0].speechSegments[0].endSeconds = 5;
  const merged = mergeLibrarySnapshot(old, next);
  assert.equal(merged.clips[0].reviewStatus, 'changes_requested');
  assert.equal(merged.sources[0].speechSegments[0].endSeconds, 5);
  assert.strictEqual(stableValue(old.automation, structuredClone(old.automation)), old.automation);
});
