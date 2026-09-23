import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {canReadSource} from './asset-access.mjs';

const fail=(message,statusCode=409)=>Object.assign(new Error(message),{statusCode});
// Older cloud imports persisted the verified category under materialCenterCategory.
// Do not infer a product from filenames or overwrite an explicit pending category.
export const recordedSourceCategory = source => String(source?.productCategory || source?.materialCenterCategory || '').trim();
export function verifyOriginalAsset(source,asset,identity,maxBytes) {
  if (!canReadSource(source,identity) || source.visibility==='private') throw fail('此素材不能通过团队素材源读取。',403);
  if (!Number.isSafeInteger(source.materialCenterAssetId) || source.materialCenterAssetId<=0 || asset?.id!==source.materialCenterAssetId || asset.isDeleted) throw fail('云管家原素材不可用。',404);
  if (!source.materialCenterObjectKey || source.materialCenterObjectKey!==asset.objectKey || source.size!==asset.size) throw fail('云管家原素材版本发生变化，需核对后恢复。');
  const category=v=>({'隐形水润面膜':'WIS隐形水润面膜','晶润眼膜':'晶润紧致眼膜','通用切片':'通用'}[v]||v||'');
  const originalCategory=category(recordedSourceCategory(source)),currentCategory=category(asset.category);
  if(originalCategory && currentCategory && currentCategory!=='待分类' && originalCategory!==currentCategory)throw fail('原素材产品分类存在冲突，需核对后恢复。');
  if (!Number.isSafeInteger(asset.size) || asset.size<=0 || asset.size>maxBytes) throw fail('素材大小超出读取限制。',413);
  let url;try{url=new URL(asset.downloadUrl);}catch{throw fail('原素材下载地址不可用。',502);}
  if (url.protocol!=='https:' || url.username || url.password) throw fail('原素材下载地址不符合要求。',502);
  return url;
}
export function validateMediaResponse(response,size,range) {
  if (![200,206].includes(response.status)) throw fail('云管家原文件暂时读取失败。',502);
  const length=Number(response.headers.get('content-length'));
  if (!Number.isSafeInteger(length) || length<=0 || length>size) throw fail('原文件响应大小不一致。',502);
  if (response.status===200 && length!==size) throw fail('原文件响应不完整。',502);
  if (response.status===206) {
    const match=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range')||'');
    if (!range || !match || Number(match[3])!==size || Number(match[2])-Number(match[1])+1!==length || Number(match[2])>=size) throw fail('原文件分段响应不一致。',502);
    const requested=/^bytes=(\d*)-(\d*)$/.exec(range);
    if(!requested)throw fail('分段请求无效。',416);
    const start=requested[1]?Number(requested[1]):Math.max(0,size-Number(requested[2]));
    const end=requested[1]&&requested[2]?Math.min(size-1,Number(requested[2])):size-1;
    if(Number(match[1])!==start || Number(match[2])!==end)throw fail('原文件返回了错误分段。',502);
  }
  return length;
}
export async function serveOriginalCloudMedia(req,res,{source,identity,materialCenter,maxBytes,fetchImpl=fetch}) {
  // This is a read-through of the already-linked original object. Never import,
  // reclassify, create a new source, or expose the workstation credential.
  if (!canReadSource(source,identity) || source.visibility==='private') throw fail('素材不存在或无权访问。',403);
  const asset=await materialCenter.getAsset(source.materialCenterAssetId);
  const url=verifyOriginalAsset(source,asset,identity,maxBytes);
  const range=req.headers.range;
  if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) throw fail('不支持此分段请求。',416);
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),120000);
  const close=()=>{if(!res.writableFinished)controller.abort();};res.once('close',close);
  try {
    const upstream=await fetchImpl(url,{method:req.method==='HEAD'?'HEAD':'GET',redirect:'error',headers:range?{Range:range}:{},signal:controller.signal});
    const expected=validateMediaResponse(upstream,asset.size,range);
    const headers={'Content-Type':'video/mp4','Content-Length':String(expected),'Accept-Ranges':'bytes','Cache-Control':'private, no-store','X-WIS-Media-Source':'verified-original-cloud-object','X-Content-Type-Options':'nosniff'};
    if(upstream.status===206)headers['Content-Range']=upstream.headers.get('content-range');
    if(req.method==='HEAD'){res.writeHead(upstream.status,headers);res.end();return;}
    if(!upstream.body)throw fail('原文件响应为空。',502);
    res.writeHead(upstream.status,headers);let bytes=0;
    await pipeline(Readable.fromWeb(upstream.body),async function*(stream){for await(const chunk of stream){bytes+=chunk.length;if(bytes>expected)throw fail('原文件响应超长。',502);yield chunk;}if(bytes!==expected)throw fail('原文件传输不完整。',502);},res);
  } catch(error) {
    if(res.headersSent){res.destroy();return;}
    throw fail(error?.statusCode?error.message:'原文件读取中断，请稍后重试。',error?.statusCode||502);
  } finally {clearTimeout(timer);res.removeListener('close',close);}
}
