// Only safe document GETs reach this page. A login POST is never replayed.
export function recoveryPage(){return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>正在恢复连接</title>
<style>:root{color-scheme:dark light}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101827;color:#e5edf7;font:16px/1.7 system-ui,sans-serif}main{padding:32px;max-width:460px}h1{font-size:22px}p{color:#b6c4d8}button{font:inherit;background:#3182ef;color:white;border:0;border-radius:8px;padding:8px 20px;cursor:pointer}</style>
<main><h1>正在恢复云电脑连接</h1><p id="message">网络暂时不稳定，正在自动重试。已有登录会保留。</p><button id="retry">立即重试</button></main>
<script>(()=>{
 const key='cmcp-page-recovery:'+location.pathname,limit=6;let count=0,timer,busy=false;
 try{const old=JSON.parse(sessionStorage.getItem(key));if(Date.now()-old.at<600000)count=old.count||0;}catch{}
 const message=document.getElementById('message');
 function save(){try{sessionStorage.setItem(key,JSON.stringify({count,at:Date.now()}));}catch{}}
 function schedule(){if(count>=limit){message.textContent='暂时还未恢复。网络恢复后点击重试即可，无需重新添加云电脑。';return;}timer=setTimeout(probe,Math.min(3000*2**count,30000));}
 async function probe(){if(busy||count>=limit)return;clearTimeout(timer);busy=true;count++;save();message.textContent='正在自动恢复连接（'+count+'/'+limit+'）…';
  try{const response=await fetch(location.pathname+location.search,{cache:'no-store',credentials:'same-origin',headers:{accept:'text/html'},signal:AbortSignal.timeout(20000)});
   const ready=response.ok&&!response.headers.has('x-cmcp-recovery')&&new RegExp('text/html','i').test(response.headers.get('content-type')||'');await response.body?.cancel();if(ready){location.reload();return;}
  }catch{}finally{busy=false;}schedule();
 }
 document.getElementById('retry').onclick=()=>{if(busy)return;count=0;save();probe();};
 addEventListener('online',()=>{if(count<limit)probe();});schedule();
})()</script></html>`;}
