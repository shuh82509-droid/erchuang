import test from 'node:test';
import assert from 'node:assert/strict';
import {collectSourceCandidates} from '../render-worker/source-selection.mjs';

const selectors = [{category: '隐形水润面膜'}, {category: '通用'}];
const asset = id => ({id, approved: true});
const eligible = item => item.approved;

test('产品素材已足够时不等待通用库，也不拉无用后续页', async () => {
  const requests = [];
  const result = await collectSourceCandidates({selectors, limit: 1, eligible,
    listAssets: async request => {requests.push(request); if (request.category === '通用') throw Error('timeout');
      return {items: [asset(84305),asset(84306)], total: 2000, pageSize: 100};},
    compare: (a,b) => b.id-a.id});
  assert.equal(requests.length, 1);
  assert.deepEqual(result.items.map(item => item.id), [84306]);
});

test('已导入或不合规的第一页不计入补源数量，继续下一页并按真实 ID 去重', async () => {
  const requests = [];
  const result = await collectSourceCandidates({selectors, limit: 2, eligible: item => item.approved && item.id !== 1,
    listAssets: async request => {requests.push(request); return request.page === 1
      ? {items: [asset(1), {id: 2, approved: false}], total: 300, pageSize: 100}
      : {items: [asset(3), asset(3),asset(4)],total: 300,pageSize: 100};}});
  assert.deepEqual(requests.map(item => [item.category,item.page]), [['隐形水润面膜',1],['隐形水润面膜',2]]);
  assert.deepEqual(result.items.map(item => item.id),[3,4]);
});

test('后续页失败保留已经找到的真实素材和失败凭证', async () => {
  const result = await collectSourceCandidates({selectors, limit: 2, eligible,
    listAssets: async request => {if(request.category === '通用') return {items: [],total: 0};
      if(request.page === 2) throw Error('上游响应超时');
      return {items: [asset(8)],total: 200,pageSize: 100};}});
  assert.deepEqual(result.items.map(item => item.id),[8]);
  assert.equal(result.issues[0].page,2);
  assert.match(result.issues[0].message,/超时/);
});

test('产品库异常可取通用合规素材，但全部读失败不能记成零库存', async () => {
  const result = await collectSourceCandidates({selectors, limit: 1, eligible,
    listAssets: async request => {if(request.category !== '通用') throw Error('timeout');
      return {items: [asset(9)],total: 1};}});
  assert.equal(result.items[0].id,9);
  assert.equal(result.issues.length,1);
  await assert.rejects(collectSourceCandidates({selectors,limit:1,eligible,
    listAssets: async () => {throw Error('timeout');}}), /timeout/);
});

test('真实空列表可识别，畸形响应不能当空库存，零缺口不发请求', async () => {
  assert.deepEqual(await collectSourceCandidates({selectors,limit:1,eligible,
    listAssets: async () => ({items:[],total:0})}), {items:[],issues:[]});
  await assert.rejects(collectSourceCandidates({selectors,limit:1,eligible,
    listAssets: async () => ({items:[]})}), /响应不完整/);
  assert.deepEqual(await collectSourceCandidates({selectors,limit:0,eligible,
    listAssets: async () => {throw Error('must not fetch');}}), {items:[],issues:[]});
});
