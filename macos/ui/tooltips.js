// A single passive tooltip follows the selected application theme. Native title
// tooltips follow the OS appearance even when CMCP uses a different theme.
const bubble=document.createElement('div');
bubble.id='cmcp-tooltip';bubble.setAttribute('role','tooltip');bubble.hidden=true;
document.body.append(bubble);
let current=null,delay;
function hide(){clearTimeout(delay);if(current)current.removeAttribute('aria-describedby');current=null;bubble.hidden=true;}
function place(){
  if(!current?.isConnected||current.disabled){hide();return;}
  bubble.textContent=current.dataset.tooltip;bubble.hidden=false;
  const rect=current.getBoundingClientRect(),size=bubble.getBoundingClientRect(),gap=8;
  bubble.style.left=Math.max(gap,Math.min(rect.left+(rect.width-size.width)/2,innerWidth-size.width-gap))+'px';
  let top=rect.bottom+gap;if(top+size.height>innerHeight-gap)top=rect.top-size.height-gap;
  bubble.style.top=Math.max(gap,top)+'px';current.setAttribute('aria-describedby',bubble.id);
}
function enter(event){
  const control=event.target.closest?.('[data-tooltip]');
  if(!control||control===current||control.disabled||!control.dataset.tooltip)return;
  hide();current=control;delay=setTimeout(place,450);
}
function leave(event){if(current&&!current.contains(event.relatedTarget))hide();}
function convert(node){
  if(!(node instanceof Element))return;
  for(const control of [node,...node.querySelectorAll('[title]')]){
    if(!control.hasAttribute('title'))continue;
    control.dataset.tooltip=control.getAttribute('title');control.removeAttribute('title');
    if(control===current&&!bubble.hidden)place();
  }
}
convert(document.querySelector('#app'));
new MutationObserver(records=>{
  for(const record of records){if(record.type==='attributes')convert(record.target);else for(const node of record.addedNodes)convert(node);}
  if(current&&!current.isConnected)hide();
}).observe(document.querySelector('#app'),{subtree:true,childList:true,attributes:true,attributeFilter:['title']});
document.addEventListener('pointerover',enter);document.addEventListener('focusin',enter);
document.addEventListener('pointerout',leave);document.addEventListener('focusout',leave);
document.addEventListener('pointerdown',hide);document.addEventListener('keydown',hide);
document.addEventListener('scroll',hide,true);window.addEventListener('resize',hide);window.addEventListener('blur',hide);
document.addEventListener('visibilitychange',()=>{if(document.hidden)hide();});
