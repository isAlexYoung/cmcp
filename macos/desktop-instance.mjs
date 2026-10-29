// Reopening the native app may find a healthy backend left by its previous UI.
// Read its authenticated state; never reset cloud switches or call /api/restart.
export async function reuseDesktopManager(previous,{pid,version,request=fetch}={}){
  if(previous?.pid!==pid||!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(previous.origin)||!/^[a-f0-9]{64}$/.test(previous.token))throw Error('Existing manager identity could not be verified');
  try{
    const response=await request(previous.origin+'/api/state',{headers:{'x-cmcp-token':previous.token},redirect:'error',signal:AbortSignal.timeout(3000)});
    if(!response.ok)return false;
    const state=await response.json();
    return state.version===version&&/^macos-(arm64|x64)$/.test(state.platform);
  }catch{return false;}
}
