// Scoped middleware: runs for every /api/* request.
//
// The individual API functions set `Access-Control-Allow-Origin: *`. That
// wildcard lets ANY website read their responses (e.g. the public account
// list) and probe the endpoints from a victim's browser. This middleware
// rewrites that header to a safe value AFTER the function runs:
//
//   • If the request's Origin is in the allowlist (the site's own origin, plus
//     any origins configured via the ALLOWED_ORIGINS env var, comma-separated),
//     echo it back — so the first-party app keeps working.
//   • Otherwise fall back to the site's own origin, which will NOT match a
//     cross-origin attacker's page, so the browser blocks them from reading the
//     response.
//
// It is intentionally defensive: any unexpected error returns the original
// response untouched, so a bug here can never take the API down.
export async function onRequest(context) {
  const { request, env, next } = context;
  const response = await next();
  try {
    const selfOrigin = new URL(request.url).origin;
    const reqOrigin = request.headers.get('Origin');
    const configured = (env && env.ALLOWED_ORIGINS ? String(env.ALLOWED_ORIGINS) : '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const allowlist = new Set([selfOrigin, ...configured]);
    const allow = reqOrigin && allowlist.has(reqOrigin) ? reqOrigin : selfOrigin;

    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', allow);
    headers.append('Vary', 'Origin');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  } catch (_) {
    return response;
  }
}
