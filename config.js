'use strict';

function loadConfig(env = process.env) {
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  let redisUrl;
  try { redisUrl = new URL(env.REDIS_URL); } catch { throw new Error('REDIS_URL is required (redis:// or rediss://).'); }
  if (!['redis:', 'rediss:'].includes(redisUrl.protocol)) throw new Error('REDIS_URL must use redis:// or rediss://.');
  const defaults = `https://ufa-test-v2.onrender.com,https://niladripan23.github.io,http://localhost:${port},http://127.0.0.1:${port}`;
  const allowedOrigins = (env.ALLOWED_ORIGINS || defaults).split(',').map(s => s.trim()).filter(Boolean);
  if (!allowedOrigins.length || allowedOrigins.some(origin => {
    try { const url = new URL(origin); return !['http:', 'https:'].includes(url.protocol) || url.origin !== origin; } catch { return true; }
  })) throw new Error('ALLOWED_ORIGINS must contain exact http(s) origins without paths or wildcards.');
  const ttlSeconds = Number(env.ROOM_TTL_SECONDS || 14400);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 7200 || ttlSeconds > 21600) throw new Error('ROOM_TTL_SECONDS must be between 7200 and 21600.');
  return { port, redisUrl: redisUrl.href, allowedOrigins, ttlSeconds, graceMs: 45000,
    commit: env.RENDER_GIT_COMMIT || 'local' };
}

module.exports = { loadConfig };
