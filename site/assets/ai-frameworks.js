function showFw(id, tab) {
  document.querySelectorAll('.fw-pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.fw-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('fw-' + id).classList.add('active');
  tab.classList.add('active');
}
// Tabs are wired here instead of inline onclick attributes so the CSP can drop 'unsafe-inline'.
document.querySelectorAll('.fw-tab[data-fw]').forEach(function (tab) {
  var activate = function () { showFw(tab.dataset.fw, tab); };
  tab.addEventListener('click', activate);
  tab.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } });
});
