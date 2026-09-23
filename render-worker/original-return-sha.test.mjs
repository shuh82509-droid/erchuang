import test from 'node:test';
import assert from 'node:assert/strict';
import {originalOutputSha} from './media-playback-recovery.mjs';
const sha='a'.repeat(64),key='wis-remix:render:1:'+sha.slice(0,16);
const render={id:'render'},variant={id:'1',materialCenterReturn:{assetId:123,idempotencyKey:key}};
const receipt=()=>({status:'completed',sha256:sha,assetId:123,idempotencyKey:key,provenance:{render_id:'render',variant_id:'1',sha256:sha,idempotency_key:key}});
test('original renderer hash remains authoritative',()=>{
 assert.equal(originalOutputSha(render,{...variant,contentSha256:'b'.repeat(64)},receipt()),'b'.repeat(64));
});
test('missing legacy hash requires complete original return identity',()=>{
 assert.equal(originalOutputSha(render,variant,receipt()),sha);
 for(const mutate of [r=>r.status='pending',r=>r.assetId=124,r=>r.idempotencyKey='other',r=>r.sha256='short',r=>r.provenance.render_id='other',r=>r.provenance.variant_id='2',r=>r.provenance.sha256='b'.repeat(64),r=>r.provenance.idempotency_key='other']){
  const r=receipt();mutate(r);assert.throws(()=>originalOutputSha(render,variant,r));
 }
});
test('invalid existing hash and mismatched hash prefix are not repaired by guessing',()=>{
 assert.throws(()=>originalOutputSha(render,{...variant,contentSha256:'invalid'},receipt()));
 const r=receipt();r.sha256='b'.repeat(64);r.provenance.sha256=r.sha256;
 assert.throws(()=>originalOutputSha(render,variant,r));
});
