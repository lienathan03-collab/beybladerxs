// Client helper used by Pages Functions to consult the rate-limiter Durable
// Object. FAILS OPEN: if BEY_STATE_DO is not bound or the DO errors, the request
// is allowed — rate limiting must never take down login when the DO is down.
//
// key      — unique bucket, e.g. `login:<ip>` (becomes the DO instance name)
// limit    — max requests per window
// windowMs — window length in ms
export async function checkRateLimit(env, key, limit, windowMs) {
  const pass = { allowed: true, remaining: limit, retryAfterMs: 0 };
  if (!env || !env.BEY_STATE_DO) return pass;
  try {
    const id = env.BEY_STATE_DO.idFromName('ratelimit:' + key);
    const stub = env.BEY_STATE_DO.get(id);
    const res = await stub.fetch('https://bey-state-do/ratelimit/hit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit, windowMs })
    });
    const data = await res.json().catch(() => ({}));
    return {
      allowed: data.allowed !== false,
      remaining: typeof data.remaining === 'number' ? data.remaining : 0,
      retryAfterMs: typeof data.retryAfterMs === 'number' ? data.retryAfterMs : 0
    };
  } catch (e) {
    return pass; // fail open
  }
}

// Extract the best-effort client IP from a Cloudflare request.
export function clientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim() ||
    'unknown'
  );
}
