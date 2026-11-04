// What the interface shows for an update, derived from the state the backend reports.
export const FIRST_CHECK_MS=15000,CHECK_EVERY_MS=6*60*60*1000;
export function updateView(updates,checking=false){
  const state=updates?.state,version=updates?.version||null;
  const offered=state==='available'||(!!version&&['updating','failed'].includes(state));
  return {offered,version,busy:checking||state==='updating',button:offered?'立即更新':'检查更新',status:checking?'正在检查…':state==='latest'?'已是最新版':state==='error'?'检查失败，请重试':''};
}
// Goes by the clock rather than one long timer, because a hidden window's timers stall and a sleeping Mac's stop.
export function updateSchedule(check,{now=Date.now,repeat=setInterval}={}){
  let due=now()+FIRST_CHECK_MS;
  const tick=()=>{if(now()<due)return;due=now()+CHECK_EVERY_MS;check();};
  repeat(tick,5000);
  return tick;
}
