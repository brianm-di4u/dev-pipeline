// A starting point: a small web service with no framework. Replace it with your app.
import { createServer } from 'node:http';
import { greet } from './greet.ts';

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(greet(url.searchParams.get('name')));
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, '127.0.0.1', () => {
  console.log(`Listening on http://127.0.0.1:${port}`);
});
