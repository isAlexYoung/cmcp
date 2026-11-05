// Page and card motion. State, focus and clicks never wait for it: the real controls are
// already final when an animation starts, and it only plays over them. Timing lives in
// style.css, whose prefers-reduced-motion rule turns all of it off.
export const REVEAL_MS=170;
export const MENU_MS=130;
const order={home:0,settings:1,about:2,editor:3};
export function pageDirection(from,to){return Math.sign(order[to]-order[from])||0;}
export function turn(node,direction){node.classList.remove('turn-forward','turn-back');if(!direction)return;void node.offsetWidth;node.classList.add(direction>0?'turn-forward':'turn-back');}
export function markChosen(group,value){for(const option of group.querySelectorAll('button')){const chosen=option.dataset.value===value;option.classList.toggle('chosen',chosen);option.setAttribute('aria-pressed',String(chosen));}}
// A background refresh rebuilds the card list, which would cut a card's slide short.
export function revealGuard(now=Date.now){let until=0;return {start(){until=now()+REVEAL_MS;},active(){return now()<until;}};}
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
