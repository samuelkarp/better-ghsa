// Paste once per page, then capture with:
//
//   copy(cap('div.js-socket-channel.js-updatable-content'))
//
// The console's `copy` helper is available only in the console evaluation.
// Call it with the markup returned by `cap`. Use `capSave` to download markup
// too large for the clipboard.
//
// The optional second argument is a selector, or list of selectors, whose
// matches are removed from the copy before it leaves the page.
//
// Blank session token values before saving fixtures. Preserve field names
// and attributes for the tests. CSRF inputs can be identified by data-csrf;
// data-channel contains a signed websocket subscription token.
(() => {
  const BLANK = ['authenticity_token', 'timestamp_secret', 'timestamp'];

  const build = (sel, drop) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`no match for ${sel}`);
    const clone = el.cloneNode(true);
    let dropped = 0;
    for (const d of [].concat(drop || [])) {
      for (const node of clone.querySelectorAll(d)) { node.remove(); dropped++; }
    }
    let blanked = 0;
    for (const input of clone.querySelectorAll('input,textarea')) {
      const name = input.getAttribute('name') || '';
      if (BLANK.includes(name) || name.startsWith('required_field_')
          || input.getAttribute('data-csrf') === 'true') {
        input.setAttribute('value', '');
        blanked++;
      }
    }
    for (const el of clone.querySelectorAll('[data-channel]')) {
      el.setAttribute('data-channel', '');
      blanked++;
    }
    const html = clone.outerHTML;
    console.log(`${sel}: ${html.length} bytes, ${blanked} token values blanked, ${dropped} nodes dropped`);
    return html;
  };

  window.cap = build;

  window.capSave = (sel, filename, drop) => {
    const url = URL.createObjectURL(new Blob([build(sel, drop)], { type: 'text/html' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return `(downloading ${filename})`;
  };

  window.capCount = (sel) => document.querySelectorAll(sel).length;

  console.log("ready: copy(cap('<sel>', '<drop>')), capSave('<sel>', '<file>', '<drop>'), capCount('<sel>')");
  return '(ready)';
})()
