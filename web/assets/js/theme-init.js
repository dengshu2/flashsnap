// Runs before first paint (classic, blocking script) so a saved theme never
// flashes the wrong colors. Kept tiny; everything else is an ES module.
try {
    var t = localStorage.getItem('flashsnap-theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch (e) { /* storage unavailable: follow the system theme */ }
