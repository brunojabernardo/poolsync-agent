// Local high-fps preview server.
//
// Serves the OBS program screenshot over a localhost WebSocket. The admin page
// (on the same machine) connects to ws://localhost:<port>/preview directly —
// browsers allow HTTPS pages to reach localhost — so the preview is smooth
// (~10-15fps) without the cloud round-trip. When the operator manages from a
// different device, the browser can't reach localhost and falls back to the
// cloud preview.
const http = require('http');
const { WebSocketServer } = require('ws');

function startLocalPreview(config, obs, log) {
  const port = config.localPreviewPort || 4456;
  const allowedOrigin = (config.server.url || '').replace(/\/$/, '');

  function originOk(origin) {
    if (!origin) return true; // non-browser / same-process
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/i.test(origin)) return true;
    if (allowedOrigin && origin.replace(/\/$/, '') === allowedOrigin) return true;
    return !allowedOrigin; // dev (no server configured) → allow
  }

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('PoolSync local preview');
  });
  // Reject disallowed origins during the handshake (before the socket opens).
  const wss = new WebSocketServer({ server, path: '/preview', verifyClient: (info) => originOk(info.origin) });

  let clients = 0;
  let looping = false;

  wss.on('connection', (ws) => {
    clients++;
    if (!looping) loop();
    ws.on('close', () => { clients = Math.max(0, clients - 1); });
    ws.on('error', () => {});
  });

  async function loop() {
    looping = true;
    while (clients > 0) {
      let frame = null;
      try {
        const res = await obs.execute('getProgramPreview');
        if (res && res.ok && res.data) frame = res.data.image;
      } catch (_) {}
      if (frame) {
        wss.clients.forEach((c) => { if (c.readyState === 1) { try { c.send(frame); } catch (_) {} } });
      }
      await new Promise((r) => setTimeout(r, 70)); // ~14fps ceiling
    }
    looping = false;
  }

  server.on('error', (e) => log('warn', `Prévia local indisponível (porta ${port}): ${e.message}`));
  server.listen(port, '127.0.0.1', () => log('info', `Prévia local pronta em ws://localhost:${port}/preview`));

  return { close() { try { wss.close(); server.close(); } catch (_) {} } };
}

module.exports = { startLocalPreview };
