import {createHash} from 'node:crypto';

export const ASR_FRAME_RULE='verified-asr-native-frame-v1';
export const ASR_GROUP_RULE='verified-asr-contiguous-cues-v1';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const requireValue=(ok,reason)=>{if(!ok)throw Error(reason);};
const finite=Number.isFinite;
const timestamp=value=>{
 const match=/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/.exec(value);
 requireValue(match&&+match[2]<60&&+match[3]<60,'invalid_srt_timestamp');
 return +match[1]*3600+ +match[2]*60+ +match[3]+ +match[4]/1000;
};
export function parseSrt(bytes,duration){
 requireValue(bytes.length>0&&bytes.length<=2*1024*1024&&finite(duration)&&duration>0,'invalid_srt_input');
 const blocks=bytes.toString('utf8').replace(/^\uFEFF/,'').trim().split(/\r?\n\s*\r?\n/);
 requireValue(blocks.length<=5000,'too_many_cues');let previousEnd=0;
 return blocks.map((block,index)=>{
  const lines=block.split(/\r?\n/),match=/^(\S+) --> (\S+)$/.exec(lines[1]);
  requireValue(+lines[0]===index+1&&match,'invalid_srt_sequence');
  const start=timestamp(match[1]),end=timestamp(match[2]);
  requireValue(start>=previousEnd-.000001&&end>start&&end<=duration+.001,'invalid_srt_bounds');previousEnd=end;
  const text=lines.slice(2).join(' ').replace(/^说话人\s*\d+:\s*/u,'').trim();
  requireValue(text.length>0,'missing_transcript');
  return {cueId:index+1,start,end,text};
 });
}

// Explicit server-owned grouping only. A short continuation can complete the
// preceding sentence; its original interval is retained, never filled/padded.
// Do not accept new text, arbitrary cuts, omitted intervening cues or approval.
function verifiedCueGroups(input,cues){
 const groups=input===undefined?[]:input;
 requireValue(Array.isArray(groups)&&groups.length<=128,'invalid_asr_cue_groups');
 const used=new Set();let previousLast=0;
 return groups.map(ids=>{
  requireValue(Array.isArray(ids)&&ids.length>=2&&ids.length<=8&&ids.every((id,i)=>Number.isInteger(id)&&id>=1&&id<=cues.length&&(i===0||id===ids[i-1]+1)),'asr_group_not_contiguous');
  requireValue(ids[0]>previousLast&&!ids.some(id=>used.has(id)),'asr_group_overlap_or_order');
  previousLast=ids.at(-1);ids.forEach(id=>used.add(id));
  const selected=ids.map(id=>cues[id-1]);
  requireValue(selected.at(-1).end-selected[0].start<=20,'asr_group_too_long');
  requireValue(selected.every((cue,i)=>i===0||cue.start-selected[i-1].end<=1.5),'asr_group_gap_too_long');
  return [...ids];
 });
}

// The caller passes the bytes returned by the authorized read, not a caller's
// boolean saying ASR succeeded. Original source membership / business approval
// remains a separate server-side decision and is never inferred from a title.
export function verifyAsrBundle({source,sourceBytes,srtBytes,receipts,frameMap}){
 requireValue(source?.id&&source?.productCategory,'source_identity_missing');
 requireValue(/^[a-f0-9]{64}$/.test(source.sha256||'')&&sha(sourceBytes)===source.sha256,'source_sha_mismatch');
 requireValue(/^[a-f0-9]{64}$/.test(source.srtSha256||'')&&sha(srtBytes)===source.srtSha256,'srt_sha_mismatch');
 for(const name of ['drive','minute','detail'])requireValue(receipts?.[name]?.ok===true&&receipts[name].identity==='user','authorized_read_receipt_missing');
 const drive=receipts.drive.data,minute=receipts.minute.data,detail=receipts.detail.data.minutes?.[0];
 requireValue(drive.size===sourceBytes.length&&drive.file_token&&drive.version,'upload_receipt_mismatch');
 requireValue(minute.minute_token===source.minuteToken&&detail?.minute_token===source.minuteToken,'minute_identity_mismatch');
 requireValue(receipts.export?.size_bytes===srtBytes.length,'srt_export_mismatch');
 requireValue(frameMap?.sourceSha256===source.sha256&&Array.isArray(frameMap.starts)&&frameMap.starts.length>=2,'frame_map_source_mismatch');
 const starts=frameMap.starts,end=frameMap.end;
 requireValue(finite(end)&&end>0&&starts.every((v,i)=>finite(v)&&v>=0&&v<end&&(i===0||v>starts[i-1])),'invalid_frame_map');
 requireValue(starts[0]<.1&&end<=source.durationSeconds+.1,'media_duration_mismatch');
 const cues=parseSrt(srtBytes,source.durationSeconds);
 const sentenceCueGroups=verifiedCueGroups(source.sentenceCueGroups,cues);
 return {source:{id:source.id,sha256:source.sha256,productCategory:source.productCategory,skuVersion:source.skuVersion||null,durationSeconds:source.durationSeconds},srtSha256:source.srtSha256,minuteToken:source.minuteToken,frameMapSha256:sha(JSON.stringify(frameMap)),frameMap,cues,sentenceCueGroups,cueGroupsSha256:sha(JSON.stringify(sentenceCueGroups)),rule:ASR_FRAME_RULE};
}

const lowerBound=(values,x)=>{let lo=0,hi=values.length;while(lo<hi){const mid=(lo+hi)>>1;if(values[mid]<x-1e-9)lo=mid+1;else hi=mid;}return lo;};

export function alignAsrCuesToFrames(bundle,{minSeconds=.8,maxSeconds=20,maxPaddingSeconds=.1}={}){
 requireValue(bundle?.rule===ASR_FRAME_RULE,'unverified_asr_bundle');
 const {starts,end}=bundle.frameMap,limits=[...starts,end];
 const groups=verifiedCueGroups(bundle.sentenceCueGroups,bundle.cues),members=new Set(groups.flat()),firsts=new Map(groups.map(ids=>[ids[0],ids]));
 const selected=bundle.cues.flatMap(cue=>{
  const ids=firsts.get(cue.cueId);
  if(ids){const originals=ids.map(id=>bundle.cues[id-1]);return [{cueId:cue.cueId,start:cue.start,end:originals.at(-1).end,text:originals.map(c=>c.text).join(' '),originals}];}
  return members.has(cue.cueId)?[]:[cue];
 });
 return selected.map(cue=>{
  const first=lowerBound(limits,cue.start),startFrame=first<limits.length&&Math.abs(limits[first]-cue.start)<1e-8?first:Math.max(0,first-1);
  const endFrame=lowerBound(limits,cue.end),startSeconds=limits[startFrame],endSeconds=limits[endFrame];
  const reasons=[];
  if(!finite(startSeconds)||!finite(endSeconds)||endFrame>=limits.length||endSeconds<cue.end-1e-8)reasons.push('原音轨语句超过可用视频边界');
  const duration=endSeconds-startSeconds;
  if(duration<minSeconds-1e-8)reasons.push('完整语句不足最小片段时长，不拉长填充');
  if(duration>maxSeconds+1e-8)reasons.push('完整语句超过最大片段时长，需要真实停顿或词级依据再拆分');
  if(cue.start-startSeconds>maxPaddingSeconds+1e-8||endSeconds-cue.end>maxPaddingSeconds+1e-8)reasons.push('边界附近存在过长帧间隔，不自动延展');
  // Only sub-frame outward padding is permitted. Cue text and sentence range
  // are retained exactly; a split word in ASR still needs semantic review.
  const boundaryTrusted=reasons.length===0;
  const groupEvidence=cue.originals?{groupRule:ASR_GROUP_RULE,sourceCues:cue.originals.map(c=>({...c})),sourceCuesSha256:sha(JSON.stringify(cue.originals)),cueGroupsSha256:bundle.cueGroupsSha256}:{};
  return {index:cue.cueId,label:cue.text,rawStartSeconds:cue.start,rawEndSeconds:cue.end,startSeconds,endSeconds,durationSeconds:duration,startFrame,endFrame,nativeFrameAligned:boundaryTrusted,semanticBoundaryTrusted:boundaryTrusted,integerSecondAligned:Number.isInteger(startSeconds)&&Number.isInteger(endSeconds),boundaryRule:ASR_FRAME_RULE,boundaryType:cue.originals?'asr_sentence_group':'asr_sentence',transcriptSource:'feishu_minutes_srt',boundaryConfidence:boundaryTrusted?'high':'low',boundaryEvidence:{sourceId:bundle.source.id,sourceSha256:bundle.source.sha256,productCategory:bundle.source.productCategory,skuVersion:bundle.source.skuVersion,srtSha256:bundle.srtSha256,minuteToken:bundle.minuteToken,frameMapSha256:bundle.frameMapSha256,cueIds:cue.originals?cue.originals.map(c=>c.cueId):[cue.cueId],textSha256:sha(cue.text),alignedStartSeconds:startSeconds,alignedEndSeconds:endSeconds,startFrame,endFrame,...groupEvidence},requiresReview:true,reviewReasons:[...reasons,'须完成原音轨、同SKU事实、画面及上下文核验；句界技术通过不等于内容批准'],technicalBoundaryReasons:reasons};
 });
}

function trustedGroupShape(segment){
 const e=segment.boundaryEvidence;
 if(segment.boundaryType!=='asr_sentence_group')return !e?.groupRule&&Array.isArray(e?.cueIds)&&e.cueIds.length===1;
 const cues=e?.sourceCues;
 return Boolean(e?.groupRule===ASR_GROUP_RULE&&Array.isArray(cues)&&cues.length>=2&&cues.length<=8&&Array.isArray(e.cueIds)&&e.cueIds.length===cues.length&&/^[a-f0-9]{64}$/.test(e.cueGroupsSha256||'')&&e.sourceCuesSha256===sha(JSON.stringify(cues))&&cues.every((c,i)=>Number.isInteger(c.cueId)&&c.cueId>0&&c.cueId===e.cueIds[i]&&finite(c.start)&&finite(c.end)&&c.end>c.start&&typeof c.text==='string'&&c.text.length>0&&(i===0||c.cueId===cues[i-1].cueId+1&&c.start>=cues[i-1].end&&c.start-cues[i-1].end<=1.5))&&cues[0].start===segment.rawStartSeconds&&cues.at(-1).end===segment.rawEndSeconds&&cues.map(c=>c.text).join(' ')===segment.label);
}

export function hasTrustedAsrFrameBoundary(segment,source){
 const e=segment?.boundaryEvidence;
 return Boolean(segment?.boundaryRule===ASR_FRAME_RULE&&segment.nativeFrameAligned&&segment.semanticBoundaryTrusted&&e&&trustedGroupShape(segment)&&e.sourceId===source.id&&e.sourceSha256===source.contentSha256&&e.productCategory===source.productCategory&&e.skuVersion&&e.skuVersion===source.skuVersion&&/^[a-f0-9]{64}$/.test(e.srtSha256||'')&&/^[a-f0-9]{64}$/.test(e.frameMapSha256||'')&&e.textSha256===sha(segment.label)&&finite(segment.startSeconds)&&finite(segment.endSeconds)&&Math.abs(e.alignedStartSeconds-segment.startSeconds)<1e-6&&Math.abs(e.alignedEndSeconds-segment.endSeconds)<1e-6&&e.startFrame===segment.startFrame&&e.endFrame===segment.endFrame&&segment.startSeconds<=segment.rawStartSeconds+1e-8&&segment.endSeconds>=segment.rawEndSeconds-1e-8&&segment.endSeconds<=source.durationSeconds+.001&&segment.durationSeconds>=.8&&segment.durationSeconds<=20&&Number.isInteger(segment.startFrame)&&Number.isInteger(segment.endFrame)&&segment.endFrame>segment.startFrame);
}

export const preciseBoundarySeconds=value=>Number(Number(value).toFixed(6));
