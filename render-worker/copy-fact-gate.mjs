// Source approval alone does not establish that an old offer is current.
// These detected claims require a fresh business review; this gate does not
// declare claims unlawful or invent product/offer facts.
export function copyFactIssues(timeline) {
  const issues = [];
  for (const item of timeline) {
    const text = String(item.sourceText || '').normalize('NFKC').trim();
    const add = (kind, description) => issues.push({kind, at:item.start, clipId:item.clipId, description});
    if (!text || /^(?:口播片段|语音片段|静音检测片段)\s*\d*$/u.test(text)) {
      add('transcript_missing', '该片段没有可核对的口播文字，需补齐原文或确认纯展示片段后再复核。');
      continue;
    }
    if (/(?:\d+|[一二三四五六七八九十百]+)年.{0,8}皱纹.{0,15}(?:一盒|一片|一次|一瓶)/u.test(text)
        || /(?:一盒|一片|一次|一瓶).{0,10}(?:去除|消除|根除).{0,8}皱纹/u.test(text))
      add('efficacy_basis_missing', '片段含以单次或单件产品解决多年皱纹的功效承诺，尚无对应依据，需业务复核。');
    if (/(?:周年庆|限时|仅限今天|只限今天|最后一天|全网最低|历史最低|买[\d一二三四五六七八九十]+送|(?:直降|低至|打)[\d一二三四五六七八九十点\.]+折|到手[价仅只\s]*[\d一二三四五六七八九十百]+)/u.test(text))
      add('offer_basis_missing', '片段含活动、折扣或价格机制，本批尚无当前生效依据，需确认适用产品与活动有效期。');
  }
  return issues;
}
