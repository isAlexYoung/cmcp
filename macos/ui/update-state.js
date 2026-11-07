// What the interface shows for an update, derived from the state the backend reports.
export const FIRST_CHECK_MS=15000,CHECK_EVERY_MS=6*60*60*1000;
export function updateView(updates,checking=false,active=false){
  const state=updates?.state,version=updates?.version||null;
  const offered=state==='available'||(!!version&&['updating','failed','ready'].includes(state));
  const prepared=state==='ready';
  return {offered,version,prepared,busy:checking||active||state==='updating',button:prepared?'安装更新':'下载更新',status:checking?'正在检查…':updates?.checkError||state==='error'?'检查失败，请重试':state==='latest'?'已是最新版':''};
}
// The Mac fetches checksums before the download. Ranges estimate overall work;
// received/total remain the measured progress of the current stage.
export function updateRing(updates,previous={}){
  const visible=['updating','failed','ready'].includes(updates?.state),failed=updates?.state==='failed',phase=updates?.phase||'release';
  if(!visible)return {visible:false,failed:false,phase:null,percent:0};
  const ranges={installed:[0,5],release:[0,8],checksum:[8,10],download:[10,85],extract:[85,95],verify:[85,99],ready:[100,100],restart:[100,100]};
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
