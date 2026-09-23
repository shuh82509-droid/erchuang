import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {createClipRemixService} from '../clip-remix-service.mjs';

test('read-only native media supports range and HEAD without changing library or creating preview files',async()=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'wis-native-preview-'));
 const root=path.join(dataDir,'clip-remix');await fs.mkdir(path.join(root,'sources'),{recursive:true});
 const file=path.join(root,'library.json');const source={id:'native',storedName:'native.mp4',visibility:'team',size:8};
 const original=JSON.stringify({version:7,sources:[source],clips:[],folders:[],frameworks:[],autoJobs:[],renders:[]});
 await fs.writeFile(file,original);await fs.writeFile(path.join(root,'sources','native.mp4'),'01234567');
 const service=createClipRemixService({dataDir,readOnly:true,maxFileBytes:1e6,nowIso:()=>new Date().toISOString(),
 inspectMedia:async()=>({videoCodec:'h264',pixelFormat:'yuv420p',hasAudio:true,audioCodec:'aac',duration:1}),
 runFfmpeg:async()=>{throw new Error('Must not transcode in readonly mode')},
 materialCenter:{configured:false},cutter:{configured:false},
 jsonResponse:(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body))}});
 await service.initialize();
 const server=http.createServer((req,res)=>service.route(req,res,new URL(req.url,'http://localhost'),{sub:'tester'}).catch(e=>{res.writeHead(500);res.end(e.message)}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const url=`http://127.0.0.1:${server.address().port}/api/remix/media/source/native`;
  const r=await fetch(url,{headers:{Range:'bytes=2-5'}});assert.equal(r.status,206);assert.equal(await r.text(),'2345');
  const h=await fetch(url,{method:'HEAD'});assert.equal(h.status,200);assert.equal(h.headers.get('content-length'),'8');
  assert.equal(await fs.readFile(file,'utf8'),original);assert.deepEqual(await fs.readdir(path.join(root,'sources')),['native.mp4']);
 }finally{await new Promise(r=>server.close(r));await fs.rm(dataDir,{recursive:true,force:true});}
});
