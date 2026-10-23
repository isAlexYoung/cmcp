// A one-use placeholder reaches the existing login form, never the password.
// Its normal submit handler receives the normal response and owns the session.
export function autoFillSource(marker) {
  return `(${fillLogin.toString()})(${JSON.stringify(marker)});`;
}
function fillLogin(marker) {
  let filled = false, finished = false, field, form, observer, timer, nextDelivery = 0;
  const deadline = performance.now() + 15000;
  const stop = (clear = true) => {
    finished = true; observer?.disconnect(); clearInterval(timer);
    for (const type of ['input','click','keydown']) document.removeEventListener(type, manual, true);
    if (clear && field?.isConnected && field.value === marker) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, '');
      field.dispatchEvent(new Event('input', {bubbles:true}));
      field.dispatchEvent(new Event('change', {bubbles:true}));
    }
  };
  const manual = event => { if (event.isTrusted && (event.type === 'input' || event.target.closest?.('form') === form)) stop(); };
  const tick = () => {
    if (finished) return;
    if (performance.now() > deadline) return stop();
    // Only the desktop unlock form, never account/password-change forms.
    const candidates = [...document.querySelectorAll('form')].filter(f =>
      f.querySelectorAll('input[type="password"]').length === 1 &&
      !f.querySelector('input[autocomplete="new-password"]') &&
      /解锁|登录|进入桌面/.test(f.textContent));
    if (candidates.length !== 1) return;
    const currentForm = candidates[0], currentField = currentForm.querySelector('input[type="password"]');
    if (field !== currentField || form !== currentForm) { filled = false; nextDelivery = 0; }
    form = currentForm; field = currentField;
    if (field.value && field.value !== marker) return stop(); // Never replace real user/password-manager input.
    // SSR markup can be editable before React has installed its controlled
    // input accessor and handlers. Filling then is lost during hydration.
    // Use the public DOM descriptor, not React's private property names.
    if (field.disabled || !Object.getOwnPropertyDescriptor(field, 'value')?.set) return;
    const button = form?.querySelector('button[type="submit"]');
    if (!button) return;
    if (filled && field.value === marker && !button.disabled) { stop(false); form.requestSubmit(button); return; }
    if (!button.disabled || performance.now() < nextDelivery) return;
    nextDelivery = performance.now() + 150;
    if (field.autocomplete !== 'off') field.autocomplete = 'off';
    // A hydration/render replacement may clear the placeholder or initialize
    // the tracker from it. Re-deliver only this placeholder until acknowledged.
    // This is not an HTTP retry: stop before the single requestSubmit call.
    field.value = '';
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, marker);
    filled = true;
    field.dispatchEvent(new Event('input', {bubbles:true}));
    field.dispatchEvent(new Event('change', {bubbles:true}));
  };
  for (const type of ['input','click','keydown']) document.addEventListener(type, manual, true);
  window.addEventListener('pagehide', stop, {once:true});
  observer = new MutationObserver(tick); observer.observe(document.documentElement, {childList:true,subtree:true,attributes:true});
  timer = setInterval(tick, 100); tick();
}
export function injectAutoFill(html) {
  const nonce = html.match(/<script\b[^>]*\bnonce=["']([A-Za-z0-9+/_=-]{8,256})["']/i)?.[1];
  const script = `<script defer src="/__mcp/autofill.js"${nonce ? ` nonce="${nonce}"` : ''}></script>`;
  // Keep the upstream CSP intact; unsupported policies keep manual login.
  return /<\/head\s*>/i.test(html) ? html.replace(/<\/head\s*>/i, script+'$&') : html.replace(/<\/body\s*>/i, script+'$&');
}
