import http from 'node:http';

const port = Number(process.env.PORT || 8080);
const artifactDir = process.env.ARTIFACT_DIR || '/app/artifacts';

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { ok: true, service: 'career-ops-worker', artifactDir });
  }

  if (req.method === 'POST' && ['/scan', '/verify', '/evaluate', '/generate'].includes(req.url)) {
    return sendJson(res, 501, {
      ok: false,
      error: 'Not implemented',
      route: req.url,
      next: 'Add a provider-specific worker handler before enabling this route in n8n.'
    });
  }

  sendJson(res, 404, { ok: false, error: 'Not found' });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`career-ops-worker listening on ${port}`);
});

