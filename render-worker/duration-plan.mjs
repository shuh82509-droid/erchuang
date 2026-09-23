// Select one whole, already approved clip per required role before encoding.
// The opening remains fixed so a batch never reuses an approved opening.
export function chooseDurationBase({slots,target,openingSlotId,preferred,weights={}}){
  const tolerance=Math.max(3,target*.08),cap=Math.round((target+tolerance)*10);
  let states=[{items:[],units:0,seconds:0,score:0}];
  for(const slot of slots){
    const candidates=slot.id===openingSlotId?slot.clips.filter(c=>c.id===preferred[slot.id]):slot.clips;
    const next=new Map();
    for(const state of states)for(const clip of candidates){
      const seconds=Number(clip.durationSeconds),units=state.units+Math.round(seconds*10);
      if(!Number.isFinite(seconds)||seconds<=0||units>cap||state.items.some(x=>x.clip.id===clip.id))continue;
      const score=state.score+(clip.id===preferred[slot.id]?1:0)+Math.log1p(Math.max(0,Number(weights[clip.id])||1))*.05;
      const row={items:[...state.items,{slotId:slot.id,clip}],units,seconds:state.seconds+seconds,score};
      const bucket=next.get(units)||[];bucket.push(row);bucket.sort((a,b)=>b.score-a.score);next.set(units,bucket.slice(0,2));
    }
    states=[...next.values()].flat();if(!states.length)return null;
  }
  states.sort((a,b)=>Math.abs(a.seconds-target)-Math.abs(b.seconds-target)||b.score-a.score);
  return Object.fromEntries(states[0].items.map(x=>[x.slotId,x.clip.id]));
}
