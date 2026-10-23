// A one-use placeholder reaches the existing login form, never the password.
// Its normal submit handler receives the normal response and owns the session.
export function autoFillSource(marker) {
  return `(${fillLogin.toString()})(${JSON.stringify(marker)});`;
}
function fillLogin(marker) {
  let filled = false, finished = false, field, form, observer, timer;
  const deadline = performance.now() + 15000;
  const stop = () => { finished = true; observer?.disconnect(); clearInterval(timer); document.removeEventListener('input', manual, true); document.removeEventListener('click', manual, true); };
  const manual = event => { if (event.isTrusted && (event.type === 'input' || event.target.closest?.('button[type="submit"]'))) stop(); };
  const tick = () => {
    if (finished) return;
    if (performance.now() > deadline) return stop();
    if (!filled) {
      // Only the desktop unlock form, never account/password-change forms.
      const candidates = [...document.querySelectorAll('form')].filter(f =>
        f.querySelectorAll('input[type="password"]').length === 1 &&
        !f.querySelector('input[autocomplete="new-password"]') &&
        /解锁|登录|进入桌面/.test(f.textContent));
      if (candidates.length !== 1) return;
      form = candidates[0]; field = form.querySelector('input[type="password"]');
      if (field.disabled || !form.querySelector('button[type="submit"]')) return;
      if (field.value) return stop(); // Do not replace user/password-manager input.
      filled = true;
      field.autocomplete = 'off'; // This random placeholder is not a saved password.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, marker);
      field.dispatchEvent(new Event('input', {bubbles:true}));
      field.dispatchEvent(new Event('change', {bubbles:true}));
      return; // Give controlled forms a render turn before submitting.
    }
    const button = form?.querySelector('button[type="submit"]');
    if (!field?.isConnected || !form?.isConnected) return stop();
    if (field.value !== marker) return stop();
    if (!button || button.disabled) return;
    stop(); form.requestSubmit(button);
  };
  document.addEventListener('input', manual, true); document.addEventListener('click', manual, true);
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
