import {randomUUID} from 'node:crypto';
import {stat,lstat,link,rm} from 'node:fs/promises';
import path from 'node:path';
import {verifyOriginalAsset,recordedSourceCategory} from './source-media-fallback.mjs';

const fail=message=>Object.assign(new Error(message),{statusCode:409});

export async function ensureLinkedSourceOnDisk({source,asset,identity,sourcesDir,maxFileBytes,downloadAsset,inspectMedia,hashFile}) {
  verifyOriginalAsset(source,asset,identity,maxFileBytes);
  if(!recordedSourceCategory(source) || recordedSourceCategory(source)==='待分类' || !asset.category || asset.category==='待分类')
    throw fail('原素材产品分类尚未确认，不能自动恢复用于混剪。');
  const name=String(source.storedName||'');
  if(!name || name!==path.basename(name) || !/^[a-z0-9][a-z0-9._-]*\.(?:mp4|mov|m4v|webm)$/i.test(name))
    throw fail('原素材本地文件名无效，需人工核对。');
  const destination=path.join(sourcesDir,name);
  const checkExisting=async()=>{
    let info;
    try{info=await lstat(destination);}catch(error){if(error?.code==='ENOENT')return false;throw error;}
    if(!info.isFile() || info.size!==source.size)throw fail('本地原素材与云管家版本不一致，未覆盖现有文件。');
    if(source.contentSha256 && await hashFile(destination)!==source.contentSha256)
      throw fail('本地原素材校验值不一致，未覆盖现有文件。');
    return true;
  };
  if(await checkExisting())return {restored:false,path:destination};
  const temporary=path.join(sourcesDir,`.restore-${randomUUID()}.part`);
  try{
    await downloadAsset(asset,temporary,maxFileBytes);
    const info=await stat(temporary);
    if(!info.isFile() || info.size!==source.size)throw fail('云管家原素材下载不完整，未恢复。');
    if(source.contentSha256 && await hashFile(temporary)!==source.contentSha256)
      throw fail('云管家原素材校验值不一致，未恢复。');
    const media=await inspectMedia(temporary);
    if(!(Number(media?.duration)>0))throw fail('云管家原素材视频无法识别，未恢复。');
    try{await link(temporary,destination);}
    catch(error){if(error?.code!=='EEXIST')throw error;if(await checkExisting())return {restored:false,path:destination};throw error;}
    return {restored:true,path:destination};
  }finally{await rm(temporary,{force:true});}
}
