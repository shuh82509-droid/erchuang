import test from 'node:test';import assert from 'node:assert/strict';
import {verifyOriginalAsset,validateMediaResponse,serveOriginalCloudMedia} from './source-media-fallback.mjs';
import {Writable} from 'node:stream';
const s={visibility:'team',materialCenterAssetId:12,materialCenterObjectKey:'original/a.mp4',size:100};
const a={id:12,objectKey:'original/a.mp4',size:100,downloadUrl:'https://oss.fandow.com/original/a.mp4'};
test('only the linked unchanged original object is eligible',()=>assert.equal(verifyOriginalAsset(s,a,{id:'owner'},1000).host,'oss.fandow.com'));
test('private sources never use the team fallback',()=>assert.throws(()=>verifyOriginalAsset({...s,visibility:'private',createdById:'owner'},a,{id:'owner'},1000)));
test('deleted replaced or oversized original is rejected',()=>{for(const p of [{id:13},{objectKey:'other'},{size:99},{isDeleted:true}])assert.throws(()=>verifyOriginalAsset(s,{...a,...p},{id:'owner'},1000));assert.throws(()=>verifyOriginalAsset(s,a,{id:'owner'},90));});
test('unsafe URLs are rejected without disclosing credentials',()=>{for(const downloadUrl of ['http://oss.fandow.com/a','https://user:secret@oss.fandow.com/a','file:///etc/passwd'])assert.throws(()=>verifyOriginalAsset(s,{...a,downloadUrl},{id:'owner'},1000));});
test('product category conflict stays blocked while an explicit synonym is accepted',()=>{assert.throws(()=>verifyOriginalAsset({...s,productCategory:'黑晶面膜'},{...a,category:'肌活蛋白喷雾'},{id:'owner'},1000));assert.ok(verifyOriginalAsset({...s,productCategory:'WIS隐形水润面膜'},{...a,category:'隐形水润面膜'},{id:'owner'},1000));});
test('generic clip category matches generic cloud media without allowing another product',()=>{assert.ok(verifyOriginalAsset({...s,productCategory:'通用切片'},{...a,category:'通用'},{id:'owner'},1000));assert.throws(()=>verifyOriginalAsset({...s,productCategory:'通用切片'},{...a,category:'晶润紧致眼膜'},{id:'owner'},1000),/产品分类存在冲突/);});
const r=(status,length,range)=>new Response(null,{status,headers:{'content-length':String(length),...(range?{'content-range':range}:{})}});
test('full object and range totals must match source identity',()=>{assert.equal(validateMediaResponse(r(200,100),100),100);assert.equal(validateMediaResponse(r(206,10,'bytes 5-14/100'),100,'bytes=5-14'),10);for(const v of [r(200,99),r(206,10,'bytes 5-14/101'),r(206,10,'bytes 5-15/100'),r(403,100)])assert.throws(()=>validateMediaResponse(v,100,'bytes=5-14'));});
test('same-size wrong range is rejected and suffix ranges resolve correctly',()=>{assert.throws(()=>validateMediaResponse(r(206,10,'bytes 15-24/100'),100,'bytes=5-14'));assert.equal(validateMediaResponse(r(206,10,'bytes 90-99/100'),100,'bytes=-10'),10);});
class ResponseSink extends Writable {chunks=[];headersSent=false;writeHead(status,headers){this.status=status;this.headers=headers;this.headersSent=true;} _write(chunk,encoding,next){this.chunks.push(Buffer.from(chunk));next();}}
test('range streaming preserves exact bytes and never forwards actor credentials',async()=>{
 const res=new ResponseSink();let observed;
 await serveOriginalCloudMedia({method:'GET',headers:{range:'bytes=5-14',cookie:'never-forward'}},res,{source:s,identity:{id:'owner'},materialCenter:{getAsset:async()=>a},maxBytes:1000,fetchImpl:async(url,options)=>{observed=options;return new Response(new Uint8Array(10).fill(7),{status:206,headers:{'content-length':'10','content-range':'bytes 5-14/100'}});}});
 assert.equal(res.status,206);assert.equal(Buffer.concat(res.chunks).length,10);assert.deepEqual(observed.headers,{Range:'bytes=5-14'});assert.equal(observed.redirect,'error');assert.equal(res.headers['X-WIS-Media-Source'],'verified-original-cloud-object');
});
test('unauthorized private source is rejected before querying cloud',async()=>{
 let queried=false;await assert.rejects(serveOriginalCloudMedia({method:'GET',headers:{}},new ResponseSink(),{source:{...s,visibility:'private',createdById:'other'},identity:{id:'owner'},materialCenter:{getAsset:async()=>{queried=true;return a;}},maxBytes:1000}));assert.equal(queried,false);
});
