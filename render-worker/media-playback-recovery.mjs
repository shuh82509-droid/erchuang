import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {verifyOriginalAsset} from './source-media-fallback.mjs';
import {canReadClip} from './asset-access.mjs';

const fail=(message,statusCode=409)=>Object.assign(new Error(message),{statusCode});
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function originalOutputSha(render,variant,readback) {
  if (/^[a-f0-9]{64}$/.test(variant.contentSha256||'')) return variant.contentSha256;
  // Older renderer records omitted the hash. Recover it only from the exact,
  // completed original return receipt, never from a filename or a current file.
  const returned=variant.materialCenterReturn, p=readback?.provenance, sha=readback?.sha256;
  if(variant.contentSha256 || !/^[a-f0-9]{64}$/.test(sha||'') || readback.status!=='completed' ||
     readback.idempotencyKey!==returned?.idempotencyKey || readback.assetId!==returned?.assetId ||
     p?.render_id!==render.id || String(p?.variant_id)!==String(variant.id) ||
     p?.sha256!==sha || p?.idempotency_key!==returned.idempotencyKey ||
     returned.idempotencyKey!==`wis-remix:${render.id}:${variant.id}:${sha.slice(0,16)}`)
    throw fail('原版回传记录缺少一致的哈希和来源依据，未恢复。');
  return sha;
}

// This cache contains derived playback previews or hash-verified returned originals.
// It never changes the library, approval, classification or platform delivery state.
export function createPlaybackRecovery({directory,sourcesDir,materialCenter,maxFileBytes,hashFile,inspectMedia,runProcess,ffmpegPath,makeSegment,renderConfig,minimumFreeBytes=10*1024**3}) {
 const localOriginal=async source=>{
   if(!sourcesDir||!source.storedName)return null;
   const name=source.storedName;
   if(typeof name!=='string'||path.basename(name)!==name||/[\\/]/.test(name)||['.','..'].includes(name))throw fail('本地原视频路径无效。');
   const root=await fs.realpath(sourcesDir),file=path.join(root,name);
   let stat;try{stat=await fs.lstat(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}
   if(!stat.isFile()||stat.isSymbolicLink()||!Number.isSafeInteger(source.size)||source.size<=0||stat.size!==source.size||stat.size>maxFileBytes)
     throw fail('本地原视频大小或文件类型与来源记录不一致。');
   const sha256=await hashFile(file),after=await fs.lstat(file);
   if(!/^[a-f0-9]{64}$/.test(sha256)||['dev','ino','size','mtimeMs','ctimeMs'].some(k=>stat[k]!==after[k]))throw fail('本地原视频正在变化，请稍后核对。');
   for(const original of [source.contentSha256,source.sha256])if(original&&original!==sha256)throw fail('本地原视频哈希与来源记录不一致。');
   return {path:file,sha256,size:stat.size};
 };
 const createCache=()=>{
  const pending=new Map();
  let tail=Promise.resolve();
  const cache=async(key,kind,build)=>{
    if(!directory)throw fail('历史视频文件缺失，播放恢复尚未配置。',503);
    if(pending.has(key))return pending.get(key);
    if(pending.size>=8)throw fail('播放恢复队列繁忙，请稍后重试。',503);
    const operation=tail.then(async()=>{
      await fs.mkdir(directory,{recursive:true,mode:0o700});
      const dest=path.join(directory,key+'.mp4'),receipt=path.join(directory,key+'.json');
      try {
        const saved=JSON.parse(await fs.readFile(receipt,'utf8')),info=await fs.lstat(dest);
        if(!info.isFile()||saved.key!==key||saved.kind!==kind||info.size!==saved.size||await hashFile(dest)!==saved.sha256)
          throw fail('历史播放缓存校验失败，未覆盖文件。');
        return {path:dest,kind};
      }catch(error){if(error.code!=='ENOENT')throw error;}
      // Existing unreceipted objects are never silently overwritten.
      try{await fs.lstat(dest);throw fail('历史播放缓存尚待核验。');}catch(error){if(error.code!=='ENOENT')throw error;}
      const disk=await fs.statfs(directory);
      if(disk.bavail*disk.bsize<minimumFreeBytes)throw fail('播放恢复空间不足，已保留原记录和已恢复文件，请联系管理员归档或扩容。',503);
      const temp=path.join(directory,`.${randomUUID()}.mp4`);
      try {
        const details=await build(temp);
        const info=await fs.lstat(temp),media=await inspectMedia(temp);
        if(!info.isFile()||info.size<=0||info.size>maxFileBytes||!(media.duration>0))throw fail('恢复视频未通过可播放性校验。');
        const sha256=await hashFile(temp);
        await fs.link(temp,dest);
        await fs.writeFile(receipt,JSON.stringify({key,kind,size:info.size,sha256,createdAt:new Date().toISOString(),...details}),{flag:'wx',mode:0o600});
        return {path:dest,kind};
      }finally{await fs.rm(temp,{force:true});}
    });
    tail=operation.catch(()=>{});pending.set(key,operation);
    try{return await operation;}finally{pending.delete(key);}
  };
  return cache;
 };
 const cache=createCache(),sourceCache=createCache();
  const clip=async({clip,source,identity,purpose='preview'})=>{
    const forRender=purpose==='render';
    if(forRender&&(!makeSegment||!renderConfig))throw fail('混剪切片恢复未配置。',503);
    if(!canReadClip(clip,source,identity))throw fail('素材不存在或无权访问。',404);
    if(clip.sourceId!==source.id)throw fail('切片与原视频来源不一致。');
    const start=Number(clip.startSeconds),end=Number(clip.endSeconds);
    if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end-start>600)throw fail('原切点缺失或无效，不能重建播放预览。');
    const local=await localOriginal(source);
    let asset,verifiedSource=source;
    if(!local){
    if(!materialCenter?.configured||!source?.materialCenterAssetId)throw fail('切片原文件缺失，且没有可核验的云管家来源。',404);
    try{asset=await materialCenter.getAsset(source.materialCenterAssetId);}
    catch(error){
      if(error.statusCode!==404||!source.originalName||!materialCenter.listAssets)throw error;
      // Recovery changed numeric IDs in some historical records. A name only
      // narrows the existing authorized library; exact original object key and
      // byte size are mandatory. Never alter the persisted link or category.
      const page=await materialCenter.listAssets({query:source.originalName,libraryType:'all',page:1,pageSize:100});
      if(page.total>100)throw fail('原视频同名结果过多，需核对原对象。');
      const matches=page.items.filter(a=>!a.isDeleted&&a.objectKey===source.materialCenterObjectKey&&a.size===source.size);
      if(matches.length!==1)throw fail('未找到唯一且一致的原视频对象。',404);
      asset=await materialCenter.getAsset(matches[0].id);
      verifiedSource={...source,materialCenterAssetId:matches[0].id};
    }
    verifyOriginalAsset(verifiedSource,asset,identity,maxFileBytes);
    }
    const originalIdentity=local?['local-original-v1',source.storedName,local.size,local.sha256]:[asset.id,asset.objectKey,asset.size,source.contentSha256||''];
    const key=digest([forRender?'clip-render-v1':'clip-preview-v1',clip.id,source.id,...originalIdentity,start,end,...(forRender?[renderConfig]:[])]);
    return cache(key,forRender?'reconstructed-render-input':'reconstructed-clip-preview',async temp=>{
      // A separate serialized queue avoids nesting a cache operation on its own
      // pending promise. Each source downloads once across its different cuts.
      const originalKey=digest(['verified-source-original-v1',source.id,...originalIdentity]);
      const original=await sourceCache(originalKey,'verified-source-original',async file=>{
        if(local)await fs.copyFile(local.path,file,fs.constants.COPYFILE_EXCL);
        else await materialCenter.downloadAsset(asset,file,maxFileBytes);
        if((await fs.stat(file)).size!==source.size)throw fail('原视频下载大小不一致。');
        const originalSha256=await hashFile(file);
        if(source.contentSha256&&source.contentSha256!==originalSha256)throw fail('原视频校验失败。');
        if(local&&local.sha256!==originalSha256)throw fail('复制期间本地原视频发生变化。');
        return {sourceId:source.id,assetId:local?null:asset.id,originalSha256,identityBasis:local?'local-original-size-and-sha256':source.contentSha256?'sha256':'object-key-and-size',historicalHashAvailable:Boolean(source.contentSha256||source.sha256)};
      });
        const originalSha256=await hashFile(original.path);
        const media=await inspectMedia(original.path);
        if(local&&(!Number.isFinite(source.durationSeconds)||Math.abs(media.duration-source.durationSeconds)>0.15))throw fail('本地原视频时长与来源记录不一致。');
        if(!(media.duration>0)||end>media.duration+0.1)throw fail('切片时间超出原视频，未重建。');
        if(forRender) {
          await makeSegment({inputPath:original.path,outputPath:temp,startSeconds:start,durationSeconds:end-start,
            hasAudio:media.hasAudio,fadeInSeconds:0,fadeOutSeconds:0,config:renderConfig});
        } else {
          await runProcess(ffmpegPath,['-nostdin','-hide_banner','-loglevel','error','-i',original.path,'-ss',String(start),'-t',String(end-start),'-map','0:v:0','-map','0:a:0?','-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart','-threads','2',temp],{timeoutMs:120000});
        }
        const result=await inspectMedia(temp);
        if(Math.abs(result.duration-(end-start))>0.15)throw fail('重建预览时长与原切点不一致。');
        if(forRender&&(result.width!==renderConfig.width||result.height!==renderConfig.height||!result.hasAudio||Math.abs(result.frameRate-renderConfig.fps)>0.01))
          throw fail('恢复切片未通过混剪画幅、帧率或音轨校验。');
        return {clipId:clip.id,sourceId:source.id,previousAssetId:source.materialCenterAssetId,assetId:local?null:asset.id,originalSha256,startSeconds:start,endSeconds:end,originalClipRestored:false,sourceBasis:local?'verified-local-original':'verified-cloud-original',...(forRender?{renderConfig}: {})};
    });
  };
  // Caller must have already checked render ownership and review/download rules.
  const output=async({render,variant})=>{
    const returned=variant.materialCenterReturn;
    if(!materialCenter?.configured||returned?.status!=='completed'||!returned.idempotencyKey||!Number.isSafeInteger(returned.assetId))
      throw fail('成片原文件缺失，尚无可核验的原版回传记录。',404);
    const readback=await materialCenter.getReturn(returned.idempotencyKey);
    if(!readback.assetAvailable||readback.assetId!==returned.assetId)throw fail('原成片回传记录已不可用，未替换为其他视频。');
    const expectedSha=originalOutputSha(render,variant,readback);
    const asset=await materialCenter.getAsset(returned.assetId);
    if(asset.id!==returned.assetId||asset.isDeleted||!Number.isSafeInteger(asset.size)||asset.size<=0||asset.size>maxFileBytes)throw fail('原成片云管家文件不可用。');
    const url=new URL(asset.downloadUrl);
    if(url.protocol!=='https:'||url.username||url.password)throw fail('原成片地址无效。');
    return cache(digest(['returned-output-v1',render.id,variant.id,asset.id,asset.objectKey,expectedSha]),'verified-returned-output',async temp=>{
      await materialCenter.downloadAsset(asset,temp,maxFileBytes);
      if((await fs.stat(temp)).size!==asset.size||await hashFile(temp)!==expectedSha)throw fail('回传成片与原版哈希不同，未恢复。');
      return {renderId:render.id,variantId:variant.id,assetId:asset.id,originalOutputRestored:true,hashBasis:variant.contentSha256?'original-render-record':'original-return-receipt'};
    });
  };
  return {clip,output};
}
