import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import ts from 'typescript';

test('dragged directories consume all readEntries batches and retain nested paths', async () => {
  const input = await fs.readFile(
    new URL('../../client/src/pages/material-studio/dropped-files.ts', import.meta.url),
    'utf8',
  );
  const { outputText } = ts.transpileModule(input, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const { collectDroppedFiles } = await import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
  );
  const fileEntry = (index) => ({
    name: `${index}.mp4`,
    isFile: true,
    file: (resolve) => resolve(new File(['fixture'], `${index}.mp4`)),
  });
  const dirEntry = (children, name = 'test') => ({
    name,
    isDirectory: true,
    createReader: () => {
      let cursor = 0;
      return {
        readEntries: (resolve) => {
          const next = children.slice(cursor, cursor + 100);
          cursor += 100;
          resolve(next);
        },
      };
    },
  });
  const transfer = (entry) => ({
    items: [{ webkitGetAsEntry: () => entry }],
    files: [],
  });
  const files = await collectDroppedFiles(
    transfer(dirEntry(Array.from({ length: 205 }, (_, i) => fileEntry(i)))),
  );
  assert.equal(files.length, 205);
  assert.equal(files[204].webkitRelativePath, 'test/204.mp4');
  await assert.rejects(
    collectDroppedFiles(transfer(dirEntry(Array.from({ length: 501 }, (_, i) => fileEntry(i))))),
    /500/u,
  );
  let deep = fileEntry(1);
  for (let i = 0; i < 18; i++) deep = dirEntry([deep]);
  await assert.rejects(collectDroppedFiles(transfer(deep)), /层级/u);
});
