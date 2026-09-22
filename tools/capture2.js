(() => {
  const chain = el => { const a = []; let n = el;
    for (let i = 0; i < 7 && n && n.tagName; i++) {
      const c = (typeof n.className === 'string' && n.className.trim())
        ? '.' + n.className.trim().split(/\s+/).slice(0, 5).join('.') : '';
      a.push(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + c); n = n.parentElement;
    } return a; };

  // Capture element structure and attributes. Replace text with its length.
  const skel = (el, depth, out, budget) => {
    if (depth > 9) return out;
    for (const node of el.childNodes) {
      if (budget.n++ > 400) { out.push('  '.repeat(depth) + '...truncated'); return out; }
      if (node.nodeType === 3) {
        const t = node.textContent.trim();
        if (t) out.push('  '.repeat(depth) + `<text ${t.length}>`);
      } else if (node.nodeType === 1) {
        const cls = (typeof node.className === 'string' && node.className.trim())
          ? '.' + node.className.trim().split(/\s+/).join('.') : '';
        const at = [];
        for (const k of ['href', 'datetime', 'src', 'value', 'name', 'type', 'rel'])
          if (node.getAttribute(k)) at.push(`${k}=${node.getAttribute(k)}`);
        if (node.hasAttribute('title')) at.push('title=<redacted>');
        if (node.hasAttribute('aria-label')) at.push('aria-label=<redacted>');
        out.push('  '.repeat(depth) + `<${node.tagName.toLowerCase()}${node.id ? '#' + node.id : ''}${cls}${at.length ? ' ' + at.join(' ') : ''}>`);
        skel(node, depth + 1, out, budget);
      }
    } return out; };
  const sk = el => el ? skel(el, 0, [], { n: 0 }).join('\n') : null;

  const all = [...document.querySelectorAll('*')];
  const out = {
    path: location.pathname + location.search,
    me: document.querySelector('meta[name="user-login"]')?.content ?? null,
    customElements: [...new Set(all.map(e => e.tagName.toLowerCase()).filter(t => t.includes('-')))].sort(),
    // Revision history loads through these fragment endpoints.
    fragments: [...document.querySelectorAll('include-fragment,[data-url],[data-src],[data-fragment-url]')]
      .slice(0, 40).map(e => ({ tag: e.tagName.toLowerCase(),
        src: e.getAttribute('src') || e.getAttribute('data-url') || e.getAttribute('data-src') || e.getAttribute('data-fragment-url'),
        chain: chain(e) })),
  };

  if (/\/security\/advisories\/GHSA-/.test(location.pathname)) {
    out.kind = 'detail';
    out.editedMarkers = all.filter(e => e.children.length === 0 && /^\(?edited\)?$/i.test((e.textContent || '').trim()))
      .slice(0, 6).map(e => ({ tag: e.tagName.toLowerCase(), chain: chain(e),
        parentHTML: e.parentElement ? sk(e.parentElement) : null }));
    out.historyish = [...document.querySelectorAll('a,button,summary,[role="menuitem"]')]
      .filter(e => /history|revision|version|edited/i.test((e.textContent || '') + ' ' + (e.className || '')))
      .slice(0, 10).map(e => ({ text: (e.textContent || '').trim().slice(0, 30), tag: e.tagName.toLowerCase(),
        href: e.getAttribute('href'), chain: chain(e) }));
    const descBox = document.querySelector('.js-repository-advisory-details .Box, .js-repository-advisory-details');
    out.descriptionRegion = sk(descBox?.querySelector('.Box-header, .timeline-comment-header') ?? descBox);
    const fork = all.find(e => /private.?fork|delete_workspace|workspace/i.test(e.className || '') ) ?? null;
    out.forkRegion = fork ? { chain: chain(fork), html: sk(fork.parentElement ?? fork) } : null;
  } else {
    out.kind = 'list';
    const links = [...document.querySelectorAll('a[href*="/security/advisories/GHSA-"]')];
    out.advisoryLinkCount = links.length;
    let root = links[0] ?? null;
    while (root && root.parentElement && !links.every(l => root.contains(l))) root = root.parentElement;
    out.listRootChain = root ? chain(root) : null;
    const rows = root ? [...root.children].filter(c => c.querySelector('a[href*="GHSA-"]')) : [];
    out.rowCount = rows.length;
    out.firstRows = rows.slice(0, 3).map(sk);
    out.pagination = [...document.querySelectorAll('.paginate-container a, a[rel="next"], a[rel="prev"]')]
      .slice(0, 6).map(a => ({ rel: a.getAttribute('rel'), href: a.getAttribute('href'), text: (a.textContent || '').trim().slice(0, 20) }));
    out.filters = [...document.querySelectorAll('form')].slice(0, 10).map(f => ({
      action: f.getAttribute('action'), method: f.getAttribute('method'),
      fields: [...f.elements].map(e => e.name).filter(Boolean) }));
    out.stateTabs = all.filter(e => e.children.length === 0 && /^(Open|Closed|Draft|Triage|Published|Withdrawn|\d+ (Open|Closed))$/i.test((e.textContent || '').trim()))
      .slice(0, 8).map(e => ({ t: e.textContent.trim(), chain: chain(e) }));
  }

  const s = JSON.stringify(out, null, 1);
  console.log(s); try { copy(s); console.log(`\n[copied, ${s.length} bytes]`); } catch {}
  return '(done)';
})()
