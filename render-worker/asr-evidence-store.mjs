import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const hash=x=>createHash('sha256').update(x).digest('hex');
const requireValue=(ok,why)=>{if(!ok)throw Error(why);};
const fileNames=['source.json','transcript.srt','receipts.json','frames.json'];
async function regularBytes(file,maxBytes){
 const before=await fs.lstat(file);requireValue(before.isFile()&&!before.isSymbolicLink()&&before.size<=maxBytes,'invalid_asr_evidence_file');
 const data=await fs.readFile(file),after=await fs.lstat(file);
 requireValue(after.isFile()&&before.dev===after.dev&&before.ino===after.ino&&before.size===after.size&&before.mtimeMs===after.mtimeMs,'asr_evidence_changed_during_read');return data;
}
// Only the server-owned private evidence directory is read. No HTTP request can
// supply an evidence path, trusted flag, SKU proof or provider receipt.
export function createAsrEvidenceResolver(directory){
 return async ({sourceId,productCategory})=>{
  let info;try{info=await fs.lstat(directory);}catch(e){if(e.code==='ENOENT')return null;throw e;}
  requireValue(info.isDirectory()&&!info.isSymbolicLink(),'invalid_asr_evidence_directory');
  const manifestBytes=await regularBytes(path.join(directory,'manifest.json'),1024*1024),manifest=JSON.parse(manifestBytes);
  requireValue(manifest.schema==='wis-authorized-asr-v1'&&Array.isArray(manifest.sources)&&manifest.sources.length<=1000,'invalid_asr_evidence_manifest');
  const ids=new Set();for(const entry of manifest.sources){requireValue(/^[a-f0-9-]{36}$/i.test(entry.sourceId||'')&&!ids.has(entry.sourceId),'invalid_asr_source_identity');ids.add(entry.sourceId);}
  const item=manifest.sources.find(entry=>entry.sourceId===sourceId);if(!item)return null;
  requireValue(item.productCategory===productCategory,'asr_store_product_mismatch');
  requireValue(/^[a-f0-9]{64}$/.test(item.bundleSha256||''),'invalid_asr_bundle_hash');
  const folder=path.join(directory,item.sourceId,item.bundleSha256);
  for(const p of [path.join(directory,item.sourceId),folder]){const st=await fs.lstat(p);requireValue(st.isDirectory()&&!st.isSymbolicLink(),'invalid_asr_bundle_directory');}
  requireValue(Object.keys(item.files||{}).sort().join('|')===[...fileNames].sort().join('|'),'invalid_asr_bundle_files');
  const bytes={};for(const name of fileNames){requireValue(/^[a-f0-9]{64}$/.test(item.files[name]||''),'invalid_asr_file_sha');bytes[name]=await regularBytes(path.join(folder,name),name==='frames.json'?8*1024*1024:2*1024*1024);requireValue(hash(bytes[name])===item.files[name],'asr_store_sha_mismatch');}
  requireValue(hash(JSON.stringify(fileNames.map(name=>[name,item.files[name]])))===item.bundleSha256,'asr_store_bundle_mismatch');
  requireValue(hash(await regularBytes(path.join(directory,'manifest.json'),1024*1024))===hash(manifestBytes),'asr_manifest_changed_during_read');
  const source=JSON.parse(bytes['source.json']);requireValue(source.id===sourceId&&source.productCategory===productCategory,'asr_source_record_mismatch');
  return {source,srtBytes:bytes['transcript.srt'],receipts:JSON.parse(bytes['receipts.json']),frameMap:JSON.parse(bytes['frames.json'])};
 };
}
