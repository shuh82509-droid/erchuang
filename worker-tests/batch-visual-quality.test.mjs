import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';
import {VisualQuality} from '../render-worker/visual-quality.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const env={WIS_REMIX_VISUAL_REVIEW_ENABLED:'true',JUMP_LLM_URL:'https://example.invalid/isolated',JUMP_LLM_TOKEN:'isolated-fixture-not-a-credential',JUMP_LLM_APPLICATION:'fixture',JUMP_LLM_PROVIDER:'fixture',JUMP_LLM_VISION_MODEL:'fixture'};
function answerFor(request){return {batchKey:request.batchKey,runId:request.runId,product:request.product,skuVersion:request.skuVersion,outputs:request.outputs.map(o=>({outputId:o.outputId,sha256:o.sha256,timelineSha256:o.timelineSha256,coverage:o.coverage,decision:'pass',confidence:.95,summary:'隔离测试',issues:[]}))};}
async function fixture(t,{count=2,remaining=1,mutateResponse,networkError=false,unique=false,onFetch}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'wis-batch-visual-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const directory=path.join(root,'reviews');await fs.mkdir(directory);
 const sourceFile=path.join(root,'source.mp4'),sourceBytes=Buffer.from('actual fixture source bytes');await fs.writeFile(sourceFile,sourceBytes);
 const args={runId:'original-fixture-run',product:'黑晶面膜',skuVersion:'fixture-approved-sku',outputs:[]};
 for(let n=0;n<2;n++){
  const filePath=path.join(root,`output-${n}.mp4`),bytes=Buffer.from(`actual fixture output ${n}`);await fs.writeFile(filePath,bytes);
  const clips=Array.from({length:count},(_,i)=>n===0?i:count-i-1),timeline=clips.map((clip,i)=>({clipId:'clip-'+clip,role:i?'solution':'opening',start:i*6,duration:6,sourceText:'打开包装，取出面膜。',sourceId:'source',sourceStartSeconds:clip*6,sourceEndSeconds:(clip+1)*6,sourceSha256:sha(sourceBytes),sourceCategory:args.product,skuVersion:args.skuVersion,clipApproved:true}));
  args.outputs.push({outputId:'output-'+n,filePath,sha256:sha(bytes),technicalPassed:true,timeline,singleTimeline:timeline.map(({sourceId,sourceSha256,skuVersion,clipApproved,...x})=>x),sourceFiles:[{sourceId:'source',sha256:sha(sourceBytes),filePath:sourceFile,product:args.product,skuVersion:args.skuVersion}]});
 }
 const oldBudget=[];for(let i=0;i<4-remaining;i++){const file=path.join(directory,`budget-${sha(args.runId)}-${i}.json`),body=JSON.stringify({original:true,slot:i});await fs.writeFile(file,body);oldBudget.push([file,body]);}
 let calls=0,frames=0,request,images=0;
 const q=new VisualQuality({directory,env,runProcess:async(_cmd,cmd)=>{
  frames++;const output=args.outputs.find(o=>o.filePath===cmd[cmd.indexOf('-i')+1]),at=Number(cmd[cmd.indexOf('-ss')+1]),clip=output.timeline.find(t=>Math.abs(t.start+t.duration/2-at)<.001);
  await fs.writeFile(cmd.at(-1),Buffer.concat([Buffer.from([255,216]),Buffer.from((unique?output.outputId:'')+clip.clipId),Buffer.from([255,217])]));
 },fetchImpl:async(_url,opts)=>{calls++;const body=JSON.parse(opts.body),content=body.requests_data.messages[1].content;request=JSON.parse(content[0].text);images=content.filter(x=>x.type==='image_url').length;if(onFetch)await onFetch({args,request});if(networkError)throw Error('simulated uncertainty');let answer=answerFor(request);if(mutateResponse)answer=mutateResponse(answer,request);return {ok:true,json:async()=>({choices:[{message:{content:typeof answer==='string'?answer:JSON.stringify(answer)}}]})};}});
 return {q,args,root,directory,sourceFile,oldBudget,calls:()=>calls,frames:()=>frames,images:()=>images,request:()=>request,verifyBudget:async total=>{for(const [file,body]of oldBudget)assert.equal(await fs.readFile(file,'utf8'),body);assert.equal((await fs.readdir(directory)).filter(n=>n.startsWith('budget-')).length,total);}};
}
test('原run已用3/4：两片独立覆盖、仅相同JPEG SHA去重、一次请求和一个原预算槽',async t=>{
 const f=await fixture(t),r=await f.q.assessBatch(f.args);assert.equal(r.status,'passed');assert.equal(r.results.length,2);assert.equal(f.calls(),1);assert.equal(f.frames(),4);assert.equal(f.images(),2);await f.verifyBudget(4);
 for(const [i,result]of r.results.entries()){assert.equal(result.sha256,f.args.outputs[i].sha256);assert.equal(result.coverage.length,2);assert.equal(result.runId,f.args.runId);assert.equal(result.skuVersion,f.args.skuVersion);assert.notEqual(result.coverage[0].sampleId,r.results[1-i].coverage[0].sampleId);}
 assert.equal((await f.q.assessBatch(f.args)).status,'passed');assert.equal(f.calls(),1);await f.verifyBudget(4);
 const single=await f.q.assess({filePath:f.args.outputs[0].filePath,sha256:f.args.outputs[0].sha256,product:f.args.product,timeline:f.args.outputs[0].singleTimeline,runId:f.args.runId});assert.equal(single.reason,'batch_bound');assert.equal(f.calls(),1);
});
for(const [label,mutateResponse]of [
 ['漏掉一片',a=>({...a,outputs:a.outputs.slice(0,1)})],
 ['错误成片SHA',a=>{a.outputs[0].sha256='0'.repeat(64);return a;}],
 ['错误帧SHA',a=>{a.outputs[0].coverage[0].frameSha256='0'.repeat(64);return a;}],
 ['漏帧',a=>{a.outputs[0].coverage.pop();return a;}],
 ['重复帧覆盖',a=>{a.outputs[0].coverage[1]=a.outputs[0].coverage[0];return a;}],
 ['错时间线',a=>{a.outputs[0].timelineSha256='0'.repeat(64);return a;}],
 ['跨SKU',a=>({...a,skuVersion:'other-sku'})],
 ['错原run',a=>({...a,runId:'new-run'})],
 ['缺少独立结论',a=>{delete a.outputs[1].summary;return a;}],
 ['无结构响应',()=>'{not json'],
])test(`响应${label}不得自动通过任一片，也不重试收费`,async t=>{const f=await fixture(t,{mutateResponse}),r=await f.q.assessBatch(f.args);assert.ok(r.results.every(x=>x.status!=='passed'));await f.q.assessBatch(f.args);assert.equal(f.calls(),1);await f.verifyBudget(4);});
test('一片具体问题只影响该片：另一片必须有自己的完整通过回执',async t=>{const f=await fixture(t,{mutateResponse:a=>{a.outputs[1].decision='review_required';a.outputs[1].issues=[{kind:'overlap',at:3,description:'本片字幕重复'}];return a;}});const r=await f.q.assessBatch(f.args);assert.equal(r.results[0].status,'passed');assert.equal(r.results[1].status,'review_required');assert.equal(f.calls(),1);});
for(const label of ['unknown-sku','cross-source-sku','unapproved-clip','technical-failure','missing-transcript','old-offer'])test(`前置${label}不抽帧不请求且保留原3次预算`,async t=>{
 const f=await fixture(t);if(label==='unknown-sku')f.args.skuVersion=null;if(label==='cross-source-sku')f.args.outputs[1].sourceFiles[0].skuVersion='other';if(label==='unapproved-clip')f.args.outputs[1].timeline[0].clipApproved=false;if(label==='technical-failure')f.args.outputs[0].technicalPassed=false;if(label==='missing-transcript')f.args.outputs[0].timeline[0].sourceText='';if(label==='old-offer')f.args.outputs[0].timeline[0].sourceText='周年庆直降一折';
 const r=await f.q.assessBatch(f.args);assert.ok(r.results.every(x=>x.status!=='passed'));assert.equal(f.calls(),0);assert.equal(f.frames(),0);await f.verifyBudget(3);
});
test('只按真实SHA去重：超过12张不同画面不得删帧凑通过',async t=>{const f=await fixture(t,{count:7,unique:true});const r=await f.q.assessBatch(f.args);assert.equal(r.reason,'sample_scope');assert.equal(f.frames(),14);assert.equal(f.calls(),0);await f.verifyBudget(3);});
test('预算已满不能开新槽或自动建立新run',async t=>{const f=await fixture(t,{remaining:0});const r=await f.q.assessBatch(f.args);assert.equal(r.reason,'budget_exhausted');assert.equal(f.calls(),0);await f.verifyBudget(4);});
test('付费响应期间视频字节改变不能批准，恢复原字节可回读同一回执',async t=>{
 let original;const f=await fixture(t,{onFetch:async({args})=>{original=await fs.readFile(args.outputs[0].filePath);await fs.writeFile(args.outputs[0].filePath,'changed during review');}});const r=await f.q.assessBatch(f.args);assert.ok(r.results.every(x=>x.status!=='passed'));assert.equal((await f.q.assessBatch(f.args)).reason,'output_integrity');assert.equal(f.calls(),1);await fs.writeFile(f.args.outputs[0].filePath,original);assert.equal((await f.q.assessBatch(f.args)).status,'passed');assert.equal(f.calls(),1);await f.verifyBudget(4);
});
test('源文件变化时缓存不可批准或重新调用',async t=>{const f=await fixture(t);assert.equal((await f.q.assessBatch(f.args)).status,'passed');await fs.writeFile(f.sourceFile,'changed source');assert.equal((await f.q.assessBatch(f.args)).reason,'source_integrity');assert.equal(f.calls(),1);});
test('网络结果不明只占原一个槽，重复请求不会第二次调用',async t=>{const f=await fixture(t,{networkError:true});assert.ok((await f.q.assessBatch(f.args)).results.every(x=>x.status!=='passed'));await f.q.assessBatch(f.args);assert.equal(f.calls(),1);await f.verifyBudget(4);});
test('并发同批只发一次模型请求',async t=>{let entered,release;const gate=new Promise(r=>release=r),start=new Promise(r=>entered=r);const f=await fixture(t,{onFetch:async()=>{entered();await gate;}});const first=f.q.assessBatch(f.args);await start;assert.ok((await f.q.assessBatch(f.args)).results.every(x=>x.status!=='passed'));release();assert.equal((await first).status,'passed');assert.equal(f.calls(),1);await f.verifyBudget(4);});
test('已存付费响应而第二片回执写入中断：从原响应补齐不重收费',async t=>{
 const f=await fixture(t);const result=await f.q.assessBatch(f.args);const batchFile=path.join(f.directory,'batch-'+result.batchKey+'.json'),record=JSON.parse(await fs.readFile(batchFile));record.state='responded';await fs.writeFile(batchFile,JSON.stringify(record));
 for(const name of await fs.readdir(f.directory)){if(!/^[a-f0-9]{64}\.json$/.test(name))continue;const p=path.join(f.directory,name),r=JSON.parse(await fs.readFile(p));if(r.result?.outputId==='output-1')await fs.writeFile(p,JSON.stringify({state:'batch_preparing',batchKey:result.batchKey}));}
 assert.equal((await f.q.assessBatch(f.args)).status,'passed');assert.equal(f.calls(),1);await f.verifyBudget(4);
});
test('已有单片审核占用不得覆盖或再付费',async t=>{const f=await fixture(t),o=f.args.outputs[0],key=sha(JSON.stringify(['wis-visual-qc-20260908-v3',o.sha256,f.args.product,o.singleTimeline,env.JUMP_LLM_VISION_MODEL])),p=path.join(f.directory,key+'.json'),body='{"state":"sending","original":true}';await fs.writeFile(p,body);assert.ok((await f.q.assessBatch(f.args)).results.every(x=>x.status!=='passed'));assert.equal(await fs.readFile(p,'utf8'),body);assert.equal(f.calls(),0);await f.verifyBudget(3);});
test('源文件丢失只返回固定业务原因，不泄漏本地路径或重新收费',async t=>{const f=await fixture(t);await fs.unlink(f.sourceFile);const r=await f.q.assessBatch(f.args);assert.equal(r.reason,'integrity_unavailable');assert.equal(JSON.stringify(r).includes(f.root),false);assert.equal(f.calls(),0);});
test('原片裁切范围不连续于标记时长时拒绝，不能只靠结果文件SHA掩盖来源错绑',async t=>{const f=await fixture(t);f.args.outputs[0].timeline[0].sourceEndSeconds+=1;const r=await f.q.assessBatch(f.args);assert.equal(r.reason,'timeline_coverage');assert.equal(f.calls(),0);await f.verifyBudget(3);});
