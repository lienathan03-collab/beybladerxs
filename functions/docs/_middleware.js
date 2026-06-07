// Block public access to internal design docs / specs / plans. These ship in
// the repo (pages_build_output_dir = ".") but must not be world-readable.
// Scoped to /docs/* only, so it has zero effect on the rest of the site
// (including the _headers CSP on the main app).
export const onRequest = () =>
  new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
