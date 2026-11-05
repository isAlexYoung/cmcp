// What the interface shows for an update, derived from the state the backend reports.
export const FIRST_CHECK_MS=15000,CHECK_EVERY_MS=6*60*60*1000;
export function updateView(updates,checking=false){
  const state=updates?.state,version=updates?.version||null;
  const offered=state==='available'||(!!version&&['updating','failed'].includes(state));
  return {offered,version,busy:checking||state==='updating',button:offered?'立即更新':'检查更新',status:checking?'正在检查…':state==='latest'?'已是最新版':state==='error'?'检查失败，请重试':''};
}
// The Mac fetches checksums before the download. Ranges estimate overall work;
// received/total remain the measured progress of the current stage.
export function updateRing(updates,previous={}){
  const visible=['updating','failed'].includes(updates?.state),failed=updates?.state==='failed',phase=updates?.phase||'release';
  if(!visible)return {visible:false,failed:false,phase:null,percent:0};
  const ranges={installed:[0,5],release:[0,8],checksum:[8,10],download:[10,85],extract:[85,95],verify:[85,99],restart:[100,100]};
  const [start,end]=ranges[phase]||[0,0],valid=Number.isFinite(updates.received)&&Number.isFinite(updates.total)&&updates.total>0&&updates.received>=0&&updates.received<=updates.total;
  const measured=start+Math.floor((end-start)*(valid?updates.received/updates.total:0)),before=previous.visible&&!(previous.failed&&!failed)?previous.percent:0;
  return {visible,failed,phase,percent:failed?before:Math.max(before,measured)};
}
// Goes by the clock rather than one long timer, because a hidden window's timers stall and a sleeping Mac's stop.
export function updateSchedule(check,{now=Date.now,repeat=setInterval}={}){
  let due=now()+FIRST_CHECK_MS;
  const tick=()=>{if(now()<due)return;due=now()+CHECK_EVERY_MS;check();};
  repeat(tick,5000);
  return tick;
}
