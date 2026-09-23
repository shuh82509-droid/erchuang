export async function verifyManualApprovalFile({filePath,expectedSha256,inspectMedia,hashFile}) {
  const media=await inspectMedia(filePath);
  if(!media?.hasAudio || !Number.isFinite(media.duration) || media.duration<=0 || !media.width || !media.height)
    throw new Error('此成片无法完整播放，请先修复视频和音轨后再审核。');
  const sha256=await hashFile(filePath);
  if(!/^[a-f0-9]{64}$/.test(sha256))throw new Error('未取得此成片的文件校验值，请稍后重试原审核。');
  if(expectedSha256 && expectedSha256!==sha256)
    throw new Error('成片文件与原记录不一致，请保留原版本并重新生成后审核。');
  return sha256;
}
