import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {createClipRemixService} from '../clip-remix-service.mjs';

test('external readonly publication invalidates HTTP ETag and derived models without restart',async()=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'wis-library-refresh-'));
 const root=path.join(dataDir,'clip-remix');await fs.mkdir(root,{recursive:true});
 const file=path.join(root,'library.json');
 const library={version:7,sources:[{id:'native',name:'before',storedName:'native.mp4',visibility:'team',size:8}],clips:[],folders:[],frameworks:[],autoJobs:[],renders:[]};
 await fs.writeFile(file,JSON.stringify(library));
 const service=createClipRemixService({dataDir,readOnly:true,maxFileBytes:1e6,nowIso:()=>new Date().toISOString(),
 inspectMedia:async()=>({}),runFfmpeg:async()=>{throw new Error('Unexpected renderer execution')},
 materialCenter:{configured:false},cutter:{configured:false},
 jsonResponse:(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body))}});
 await service.initialize();
 const server=http.createServer((req,res)=>service.route(req,res,new URL(req.url,'http://localhost'),{sub:'tester'}).catch(e=>{res.writeHead(500);res.end(e.message)}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const replace=async text=>{await fs.writeFile(file+'.next',text);await fs.rename(file+'.next',file)};
 try{
  const url=`http://127.0.0.1:${server.address().port}/api/remix/library`;
  const first=await fetch(url);assert.equal(first.status,200);const original=await first.json();const etag=first.headers.get('etag');assert.ok(etag);
  assert.ok(JSON.stringify(original).includes('before'));
  const unchanged=await fetch(url,{headers:{'If-None-Match':etag}});assert.equal(unchanged.status,304);
  library.sources[0].name='after!';await replace(JSON.stringify(library));
  const fresh=await fetch(url,{headers:{'If-None-Match':etag}});assert.equal(fresh.status,200);const updated=await fresh.json();
  assert.notEqual(fresh.headers.get('etag'),etag);assert.ok(JSON.stringify(updated).includes('after!'));assert.ok(!JSON.stringify(updated).includes('"name":"before"'));
  const newEtag=fresh.headers.get('etag');const stable=await fetch(url,{headers:{'If-None-Match':newEtag}});assert.equal(stable.status,304);
  await replace('{broken');const broken=await fetch(url,{headers:{'If-None-Match':newEtag}});assert.equal(broken.status,500);await broken.text();
  const restored=JSON.stringify(library);await replace(restored);const recovered=await fetch(url,{headers:{'If-None-Match':newEtag}});assert.equal(recovered.status,200);await recovered.json();
  assert.equal(await fs.readFile(file,'utf8'),restored);
 }finally{await new Promise(r=>server.close(r));await fs.rm(dataDir,{recursive:true,force:true});}
});
