// Block public access to Durable Object worker source. Scoped to /workers/* only.
export const onRequest = () =>
  new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
