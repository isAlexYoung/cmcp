// Page and card motion. State, focus and clicks never wait for it: the real controls are
// already final when an animation starts, and it only plays over them. Timing lives in
// style.css, whose prefers-reduced-motion rule turns all of it off.
export const REVEAL_MS=170;
const order={home:0,settings:1,about:2,editor:3};
export function pageDirection(from,to){return Math.sign(order[to]-order[from])||0;}
export function turn(node,direction){node.classList.remove('turn-forward','turn-back');if(!direction)return;void node.offsetWidth;node.classList.add(direction>0?'turn-forward':'turn-back');}
export function markChosen(group,value){for(const option of group.querySelectorAll('button')){const chosen=option.dataset.value===value;option.classList.toggle('chosen',chosen);option.setAttribute('aria-pressed',String(chosen));}}
// A background refresh rebuilds the card list, which would cut a card's slide short.
export function revealGuard(now=Date.now){let until=0;return {start(){until=now()+REVEAL_MS;},active(){return now()<until;}};}
