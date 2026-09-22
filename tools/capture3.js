(() => {
  const chain = el => { const a = []; let n = el;
    for (let i = 0; i < 7 && n && n.tagName; i++) {
      const c = (typeof n.className === 'string' && n.className.trim())
        ? '.' + n.className.trim().split(/\s+/).slice(0, 5).join('.') : '';
      a.push(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + c); n = n.parentElement;
    } return a; };

  // Preserve text matching these branch, state, identifier, and number patterns.
  // Replace other text with its character count.
  const KEEP = [
    /^(main|master|release\/[\w.\-\/]+|v?\d+(\.\d+){1,3})$/,
    /^(Merged|Open|Closed|Draft|Triage|Published|Withdrawn|Approved|Reviewed|Changes requested|edited)$/i,
    /^CVE-\d{4}-\d{4,}$/,
    /^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/,
    /^#?\d+$/,
  ];
  const keep = t => KEEP.some(re => re.test(t));
  const red = t => keep(t) ? t : `<text ${t.length}>`;
  const text = el => red((el.textContent || '').replace(/\s+/g, ' ').trim());

  const skel = (el, depth, out, budget) => {
    if (depth > 10) return out;
    for (const node of el.childNodes) {
      if (budget.n++ > 700) { out.push('  '.repeat(depth) + '...truncated'); return out; }
      if (node.nodeType === 3) {
        const t = node.textContent.replace(/\s+/g, ' ').trim();
        if (t) out.push('  '.repeat(depth) + red(t));
      } else if (node.nodeType === 1) {
        const cls = (typeof node.className === 'string' && node.className.trim())
          ? '.' + node.className.trim().split(/\s+/).join('.') : '';
        const at = [];
        for (const k of ['href', 'datetime', 'src', 'value', 'name', 'type', 'rel', 'data-hovercard-type', 'data-hovercard-url'])
          if (node.getAttribute(k)) at.push(`${k}=${node.getAttribute(k)}`);
        if (node.hasAttribute('title')) at.push('title=<redacted>');
        if (node.hasAttribute('aria-label')) at.push('aria-label=<redacted>');
        out.push('  '.repeat(depth) + `<${node.tagName.toLowerCase()}${node.id ? '#' + node.id : ''}${cls}${at.length ? ' ' + at.join(' ') : ''}>`);
        skel(node, depth + 1, out, budget);
      }
    }
    return out;
  };
  const sk = el => el ? skel(el, 0, [], { n: 0 }).join('\n') : null;

  const all = [...document.querySelectorAll('*')];
  const out = { path: location.pathname, me: document.querySelector('meta[name="user-login"]')?.content ?? null };

  // The clone URL identifies the private fork repository.
  const fork = document.querySelector('private-forks-git-clone-help');
  out.forkElementPresent = !!fork;
  out.forkSkeleton = sk(fork);
  out.forkInputs = fork ? [...fork.querySelectorAll('input,textarea')].map(i => ({
    name: i.getAttribute('name'), type: i.getAttribute('type'), value: /clone|url|remote/i.test((i.getAttribute('name') || '') + (i.id || '')) ? (i.value ?? null) : `<len ${(i.value || '').length}>`,
    chain: chain(i) })) : [];
  out.forkLinks = fork ? [...fork.querySelectorAll('a[href]')].map(a => ({ href: a.getAttribute('href'), t: text(a) })) : [];

  out.prLinks = [...document.querySelectorAll('a[href*="/pull/"]')].map(a => ({
    href: a.getAttribute('href'), t: text(a),
    inMarkdownBody: !!a.closest('div.markdown-body'),
    chain: chain(a) }));

  out.branchish = all.filter(e => e.children.length === 0 &&
      /^(release\/|main$|master$|v?\d+\.\d+)/.test((e.textContent || '').trim()))
    .slice(0, 20).map(e => ({ t: red((e.textContent || '').trim()), chain: chain(e) }));

  out.prStateChips = all.filter(e => e.children.length === 0 &&
      /^(Merged|Open|Closed|Draft|Approved|Changes requested)$/i.test((e.textContent || '').trim()))
    .slice(0, 20).map(e => ({ t: red(e.textContent.trim()), chain: chain(e) }));

  // CVE notes and fork events appear in the timeline.
  const tl = [...document.querySelectorAll('div.TimelineItem, div.TimelineItem-body')];
  out.timelineCount = tl.length;
  out.timeline = tl.slice(0, 25).map(e => ({ t: text(e), chain: chain(e),
    when: e.querySelector('relative-time')?.getAttribute('datetime') ?? null,
    links: [...e.querySelectorAll('a[href]')].slice(0, 6).map(a => a.getAttribute('href')) }));

  const body = document.querySelector('div.js-socket-channel.js-updatable-content')
            || document.querySelector('#repo-content-turbo-frame');
  out.bodySkeleton = sk(body);

  // Open the description's "edited" dropdown before running this.
  // Opening it sets the include-fragment's src for revision history.
  out.editHistory = [...document.querySelectorAll('span.js-comment-edit-history')].map(s => ({
    chain: chain(s),
    fragments: [...s.querySelectorAll('include-fragment')].map(f => ({
      src: f.getAttribute('src'), loading: f.getAttribute('loading') })),
    open: !!s.querySelector('details[open]'),
    skeleton: sk(s) }));

  out.cveFields = [...document.querySelectorAll('[name^="repository_advisory["]')].map(e => ({
    name: e.getAttribute('name'), tag: e.tagName.toLowerCase(), type: e.getAttribute('type'),
    value: /\[(cve_id|cve_selection|severity|cvss_v3|state)\]$/.test(e.getAttribute('name') || '')
      ? (e.value ?? null) : `<len ${(e.value || '').length}>` }));

  const s = JSON.stringify(out, null, 1);
  console.log(s); try { copy(s); console.log(`\n[copied, ${s.length} bytes]`); } catch {}
  return '(done)';
})()
