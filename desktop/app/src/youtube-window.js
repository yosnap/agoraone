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
  let ended = '';
  const tidy = () => {
    const skip = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern');
    if (skip) skip.click();
    const still = document.querySelector('yt-confirm-dialog-renderer #confirm-button button, yt-confirm-dialog-renderer #confirm-button');
    if (still && still.offsetParent !== null) still.click();
    const auto = document.querySelector('.ytp-autonav-toggle-button[aria-checked="true"]');
    if (auto) auto.click();
    const v = video();
    if (v && v.ended) ended = id();
  };
  setInterval(tidy, 1000);
  window.__agora = {
    pause() { video()?.pause(); },
    resume() { video()?.play(); },
    volume(level) { const v = video(); if (v) { v.muted = false; v.volume = Math.max(0, Math.min(1, level / 100)); } },
    seek(seconds) { const v = video(); if (v) v.currentTime = seconds; },
    state() {
      const v = video();
      const player = document.querySelector('#movie_player');
      const ad = !!player && player.classList.contains('ad-showing');
      const failure = document.querySelector('.ytp-error');
      const error = !!failure && failure.offsetParent !== null;
      const meta = navigator.mediaSession && navigator.mediaSession.metadata;
      const title = (meta && meta.title) || document.querySelector('meta[property="og:title"]')?.content || '';
      const now = id();
      const state = error ? 'error' : ended === now && now ? 'ended' : !v || v.readyState < 2 ? 'loading' : v.paused ? 'paused' : 'playing';
      return { id: now, state, t: v && !ad ? Math.floor(v.currentTime || 0) : 0, d: v && !ad && isFinite(v.duration) ? Math.floor(v.duration) : 0,
        title, ad, volume: v ? Math.round(v.volume * 100) : 100 };
    },
  };
})();
