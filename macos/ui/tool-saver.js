// Collects quick switch clicks on the Tools page and saves only the last state of each switch,
// one save at a time, so a burst of clicks becomes one change for every connected Claude.
export function createSwitchSaver({save,delay=350,onSaved=()=>{},onError=()=>{},timers={setTimeout:(f,ms)=>setTimeout(f,ms),clearTimeout:id=>clearTimeout(id)}}){
  let pending={groups:{},tools:{}},sending=null,timer=null,running=null;
  const count=()=>Object.keys(pending.groups).length+Object.keys(pending.tools).length;
  async function flush(){
    if(timer!==null){timers.clearTimeout(timer);timer=null;}
    if(running||!count())return running;
    sending=pending;pending={groups:{},tools:{}};
    running=(async()=>{
      let failed=false;
      try{await save(sending);}catch(error){failed=true;onError(error);}
      finally{sending=null;running=null;}
      if(count())return flush();
      if(!failed)onSaved();
    })();
    return running;
  }
  return {
    want(kind,id,on){pending[kind][id]=on;if(timer!==null)timers.clearTimeout(timer);timer=timers.setTimeout(flush,delay);},
    pending(kind,id){return Object.hasOwn(pending[kind],id)||(sending!==null&&Object.hasOwn(sending[kind],id));},
    get busy(){return running!==null||timer!==null;},
    flush,
  };
}
