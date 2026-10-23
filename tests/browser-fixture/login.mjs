import {createElement as h,useEffect,useState} from 'react';
export function Login(){
  const [password,setPassword]=useState(''),[show,setShow]=useState(false),[now,setNow]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[ready,setReady]=useState(false);
  useEffect(()=>{setNow(true);window.fixtureReactReady=true;},[]);
  async function submit(event){
    event.preventDefault();if(busy||!password)return;setBusy(true);
    try{
      const response=await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password})});
      const result=await response.json();
      if(response.ok&&result.sessionId){
        window.fixtureSession=result.sessionId;
        const validation=await fetch('/api/auth/session',{headers:{'X-Desktop-Session':result.sessionId}});
        if(validation.ok){document.body.dataset.ready='true';setReady(true);}
      }else{setError(result.error||'失败');setPassword('');}
    }finally{setBusy(false);}
  }
  if(ready)return h('h1',null,'已自动登录测试桌面');
  return h('main',null,h('div',{id:'clock'},now?'22:29':'--:--'),h('form',{onSubmit:submit},
    h('h1',null,'WebDesktop'),h('input',{type:show?'text':'password',autoComplete:'current-password',value:password,onChange:event=>setPassword(event.target.value)}),
    h('button',{type:'button',onClick:()=>setShow(value=>!value)},'显示密码'),
    h('button',{type:'submit',disabled:busy||!password},'解锁并接管桌面'),h('p',{id:'error'},error)));
}
