// Page and card motion. State, focus and clicks never wait for it: the real controls are
// already final when an animation starts, and it only plays over them. Timing lives in
// style.css, whose prefers-reduced-motion rule turns all of it off.
export const REVEAL_MS=170;
export const MENU_MS=130;
const order={home:0,settings:1,connect:2,tools:3,market:4,about:5,editor:6};
export function pageDirection(from,to){return Math.sign(order[to]-order[from])||0;}
export function turn(node,direction){node.classList.remove('turn-forward','turn-back');if(!direction)return;void node.offsetWidth;node.classList.add(direction>0?'turn-forward':'turn-back');}
export function markChosen(group,value){for(const option of group.querySelectorAll('button')){const chosen=option.dataset.value===value;option.classList.toggle('chosen',chosen);option.setAttribute('aria-pressed',String(chosen));}}
// A background refresh rebuilds the card list, which would cut a card's slide short.
export function revealGuard(now=Date.now){let until=0;return {start(){until=now()+REVEAL_MS;},active(){return now()<until;}};}
// Smooth discrete wheel steps without replacing a trackpad's native momentum.
export function wheelScroll({read, write, limit, requestFrame, cancelFrame, now}) {
  const duration=170, frameLead=16;
  let target=0, from=0, started=0, applied=0, frame=null;
  const clamp=value=>Math.max(0,Math.min(limit(),value));
  const cancel=()=>{if(frame!==null)cancelFrame(frame);frame=null;};
  function step(time) {
    frame=null;
    if(Math.abs(read()-applied)>1)return; // Keyboard, focus, or native momentum took over.
    target=clamp(target);
    const progress=Math.max(0,Math.min(1,(time-started+frameLead)/duration));
    const next=Math.round(from+(target-from)*(1-(1-progress)**3));
    if(next!==applied){write(clamp(next));applied=read();}
    if(progress<1&&applied!==target)frame=requestFrame(step);
  }
  function wheel(event,pageHeight) {
    const amount=Math.abs(event.deltaY);
    const discrete=event.deltaMode!==0||amount>=40&&(amount%40===0||amount%100===0);
    if(!discrete||!amount||event.ctrlKey||event.metaKey||event.shiftKey||Math.abs(event.deltaX)>amount){
      cancel();
      return false;
    }
    const current=read();
    const delta=event.deltaY*(event.deltaMode===1?40:event.deltaMode===2?pageHeight:1);
    const pending=frame!==null&&Math.abs(current-applied)<=1;
    target=clamp((pending?target:current)+delta);
    if(target===current){cancel();return limit()>0;}
    from=applied=current;
    started=now();
    if(frame===null)frame=requestFrame(step);
    return true;
  }
  return {wheel,cancel,active:()=>frame!==null};
}
// A dropdown list opens under its field, or above it when only that fits in the window.
export function menuPlace(field,height,viewHeight,gap=2,margin=4){const below=viewHeight-margin-field.bottom-gap,room=field.top-margin-gap,above=height>below&&room>below;return {left:field.left,width:field.width,above,top:above?Math.max(margin,field.top-gap-height):field.bottom+gap};}
// What a key does to a dropdown. Moving stops at the ends of the list, as a Mac menu does.
export function menuKey(key,open,cursor,count){
  if(!open)return ['Enter',' ','ArrowDown','ArrowUp'].includes(key)?{action:'open'}:null;
  if(key==='Escape')return {action:'close'};
  if(key==='Tab')return {action:'leave'};
  if(key==='Enter'||key===' ')return {action:'pick'};
  const to={ArrowDown:Math.min(count-1,cursor+1),ArrowUp:Math.max(0,cursor-1),Home:0,End:count-1}[key];
  return to===undefined?null:{action:'move',cursor:to};
}
