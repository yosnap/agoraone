// Runs inside the hidden YouTube window (never inside AgoraOne's own window). It answers AgoraOne's few orders on the
// page's video, says how it is going when asked, rejects the cookie consent (the private choice), skips the ads that
// offer a skip button, confirms «¿Sigues ahí?» and turns off YouTube's autoplay of a next video: AgoraOne chooses.
(() => {
  if (window.top !== window) return;
  const reject = () => {
    const buttons = [...document.querySelectorAll('button, input[type=submit]')];
    const no = buttons.find(b => /rechazar todo|reject all/i.test(b.textContent || b.value || b.getAttribute('aria-label') || ''));
    if (no) no.click();
  };
  if (location.hostname === 'consent.youtube.com') {
    const tries = setInterval(reject, 700);
    setTimeout(() => clearInterval(tries), 15000);
    window.__agora = { state: () => ({ id: '', state: 'consent', t: 0, d: 0, title: '', ad: false }) };
    return;
  }
  const video = () => document.querySelector('video.html5-main-video') || document.querySelector('video');
  const id = () => { try { return new URL(location.href).searchParams.get('v') || ''; } catch { return ''; } };
  const player = () => document.getElementById('movie_player');
  const tidy = () => {
    const skip = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern');
    if (skip) skip.click();
    const still = document.querySelector('yt-confirm-dialog-renderer #confirm-button button, yt-confirm-dialog-renderer #confirm-button');
    if (still && still.offsetParent !== null) still.click();
    const auto = document.querySelector('.ytp-autonav-toggle-button[aria-checked="true"]');
    if (auto) auto.click();
  };
  setInterval(tidy, 1000);
  window.__agora = {
    pause() { const p = player(); if (p && p.pauseVideo) p.pauseVideo(); else video()?.pause(); },
    resume() { const p = player(); if (p && p.playVideo) p.playVideo(); else video()?.play(); },
    // YouTube's own player keeps its volume (it would impose its own back on the <video>).
    volume(level) {
      const p = player(), wanted = Math.max(0, Math.min(100, level));
      if (p && p.setVolume) { if (p.unMute) p.unMute(); p.setVolume(wanted); return; }
      const v = video(); if (v) { v.muted = false; v.volume = wanted / 100; }
    },
    seek(seconds) { const v = video(); if (v) v.currentTime = seconds; },
    state() {
      const v = video();
      const p = player();
      const ad = !!p && p.classList.contains('ad-showing');
      const failure = document.querySelector('.ytp-error');
      const error = !!failure && failure.offsetParent !== null;
      const meta = navigator.mediaSession && navigator.mediaSession.metadata;
      const title = (meta && meta.title) || document.querySelector('meta[property="og:title"]')?.content || '';
      const now = id();
      // Worked out each time: the same <video> plays the ads, and an ad that ends is not the song ending.
      const ended = !!v && v.ended && !ad && isFinite(v.duration) && v.currentTime >= v.duration - 1;
      const level = p && p.getVolume ? p.getVolume() : v ? v.volume * 100 : 100;
      const state = error ? 'error' : ended ? 'ended' : !v || v.readyState < 2 ? 'loading' : v.paused ? 'paused' : 'playing';
      return { id: now, state, t: v && !ad ? Math.floor(v.currentTime || 0) : 0, d: v && !ad && isFinite(v.duration) ? Math.floor(v.duration) : 0,
        title, ad, volume: Math.round(level) };
    },
  };
})();
