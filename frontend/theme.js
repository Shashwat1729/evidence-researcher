// Applies the saved theme before first paint (classic script in <head>, so
// no flash of the wrong theme). No saved choice = follow the OS setting.
(function () {
  try {
    var t = localStorage.getItem('er_theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage blocked: follow the OS */ }
})();
