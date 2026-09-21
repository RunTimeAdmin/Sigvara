/* Check an agent — paste an address, get the score and a badge to copy.
 *
 * Deliberately does no chain reads. The badge image IS the answer, served by the
 * oracle, so this page has one dependency instead of two and shows the visitor exactly
 * what everyone else will see rather than a second opinion rendered locally.
 *
 * Runs under the site CSP: no inline script, no inline style, no external library. */
(function () {
  'use strict';

  var ORACLE = 'https://oracle.sigvara.xyz';
  var EXPLORER = 'https://explorer.testnet.arc.io';

  /* No address is prefilled, deliberately.
   *
   * The obvious convenience is to seed the field with a known agent so a first-time
   * visitor can press the button and see something. The only registered agent on this
   * deployment is the slash drill's target, which is suspended now and will read
   * "slashed" permanently from 27 September. Prefilling it would make the first thing
   * every visitor sees a punished agent, and prefilling any single address bakes that
   * address's fate into the page. An empty field with a clear placeholder asks for what
   * the visitor already has. */

  var BANDS = [
    { min: 75, color: '#15803d', label: '75 – 100', reading: 'Long track record of settled payments. Little left to prove.' },
    { min: 50, color: '#a16207', label: '50 – 74', reading: 'Real history behind it. Worth checking the evidence for what you care about.' },
    { min: 25, color: '#c2410c', label: '25 – 49', reading: 'Some activity, not much of it. Treat as unproven rather than bad.' },
    { min: 0, color: '#b91c1c', label: '0 – 24', reading: 'Almost nothing settled through this agent. Nothing has been staked on its behaviour.' }
  ];

  var $ = function (id) { return document.getElementById(id); };
  var form = $('checkForm'), addr = $('addr'), note = $('formNote');
  var resultCard = $('resultCard'), embedCard = $('embedCard');
  var badgeImg = $('badgeImg'), badgeFallback = $('badgeFallback');

  function isAddress(s) { return /^0x[0-9a-fA-F]{40}$/.test(s); }

  function badgeUrl(a) { return ORACLE + '/badge/' + a + '.svg'; }

  function show(el, on) { el.hidden = !on; }

  function renderLegend() {
    var ul = $('legend');
    BANDS.forEach(function (b) {
      var li = document.createElement('li');
      var sw = document.createElement('span');
      sw.className = 'legend-dot';
      /* Set as a custom property rather than a style attribute so the stylesheet owns
       * the presentation; style-src is 'self' and this keeps one source of truth. */
      sw.style.setProperty('--dot', b.color);
      var strong = document.createElement('strong');
      strong.textContent = b.label;
      var span = document.createElement('span');
      span.textContent = b.reading;
      li.appendChild(sw); li.appendChild(strong); li.appendChild(span);
      ul.appendChild(li);
    });
  }

  function check(a) {
    var url = badgeUrl(a);

    show(resultCard, true);
    show(embedCard, true);
    show(badgeFallback, false);
    show(badgeImg, true);
    $('resultTitle').textContent = a.slice(0, 6) + '…' + a.slice(-4);
    $('resultState').textContent = 'Reading the chain';
    $('reading').textContent = '';

    /* Cache-bust per check so a visitor who just registered is not shown the browser's
     * copy of "not registered" from five minutes ago. The oracle's own cache still
     * protects the chain from the traffic. */
    badgeImg.src = url + '?t=' + Date.now();
    badgeImg.alt = 'Sigvara score badge for ' + a;

    $('evidenceLink').href = ORACLE + '/evidence/';
    $('explorerLink').href = EXPLORER + '/address/' + a;

    $('snipMd').textContent = '[![Sigvara score](' + url + ')](https://sigvara.xyz/check?a=' + a + ')';
    $('snipHtml').textContent = '<a href="https://sigvara.xyz/check?a=' + a + '">'
      + '<img src="' + url + '" alt="Sigvara score"></a>';
    $('snipUrl').textContent = url;

    try {
      var u = new URL(window.location.href);
      u.searchParams.set('a', a);
      window.history.replaceState(null, '', u.toString());
    } catch (e) { /* a shareable URL is a nicety, never a reason to fail the check */ }
  }

  badgeImg.addEventListener('load', function () {
    $('resultState').textContent = 'Live';
    /* The badge carries the verdict; naming it again in prose would be a second source
     * of truth that can disagree with the picture beside it. This says where it came
     * from instead. */
    $('reading').textContent = 'Read from the finalized on-chain score, not from this oracle’s pending proposal.';
    show(badgeFallback, false);
  });

  badgeImg.addEventListener('error', function () {
    $('resultState').textContent = 'Unavailable';
    $('reading').textContent = '';
    show(badgeImg, false);
    show(badgeFallback, true);
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var a = addr.value.trim();
    if (!isAddress(a)) {
      note.textContent = 'That is not an address. It should be 0x followed by 40 hex characters.';
      note.classList.add('bad');
      addr.focus();
      return;
    }
    note.textContent = 'Arc testnet, chain 5042002.';
    note.classList.remove('bad');
    check(a);
  });

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.copy-btn');
    if (!btn) return;
    var text = $(btn.getAttribute('data-copy')).textContent;
    var done = function () {
      var was = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = was; }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { btn.textContent = 'Press Ctrl+C'; });
    } else {
      btn.textContent = 'Press Ctrl+C';
    }
  });

  renderLegend();

  /* ?a=<address> makes every badge a link back to a page that explains itself, which is
   * the whole reason the badge is clickable. */
  var fromUrl = new URLSearchParams(window.location.search).get('a');
  if (fromUrl && isAddress(fromUrl)) {
    addr.value = fromUrl;
    check(fromUrl);
  }
})();
