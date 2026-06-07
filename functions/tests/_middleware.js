// Block public access to the test suite. Scoped to /tests/* only.
export const onRequest = () =>
  new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
