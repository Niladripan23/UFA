// One public routing configuration for the auction client. Never put secrets here.
window.UFA_CONFIG = Object.freeze({
  backendUrl: window.location.hostname === 'niladripan23.github.io'
    ? 'https://ufa-test-v2.onrender.com'
    : window.location.origin
});
