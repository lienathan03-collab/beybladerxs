// Pure fixed-window rate-limit decision, evaluated inside a Durable Object
// (one DO instance per rate-limit key, so the read-modify-write is atomic).
//
// prev: { count, windowStart } | undefined  — previous stored state
// now:  ms epoch
// limit: max requests allowed per window
// windowMs: window length in ms
//
// Returns { next, allowed, remaining, retryAfterMs }.
export function rateLimitDecision(prev, now, limit, windowMs) {
  let count, windowStart;
  if (!prev || typeof prev !== 'object' ||
      typeof prev.windowStart !== 'number' || (now - prev.windowStart) >= windowMs) {
    // New window.
    windowStart = now;
    count = 1;
  } else {
    windowStart = prev.windowStart;
    count = (prev.count || 0) + 1;
  }
  const allowed = count <= limit;
  const remaining = Math.max(0, limit - count);
  const retryAfterMs = allowed ? 0 : Math.max(0, windowStart + windowMs - now);
  return { next: { count, windowStart }, allowed, remaining, retryAfterMs };
}
