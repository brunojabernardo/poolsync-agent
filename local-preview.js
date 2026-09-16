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

  let looping = false;

  // Só se mostra o que está no ar ('__program__').
  wss.on('connection', (ws) => {
    ws._sources = ['__program__'];
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(String(raw));
        if (m && m.type === 'subscribe' && Array.isArray(m.sources)) {
          ws._sources = m.sources.filter((s) => s === '__program__').slice(0, 1);
        }
      } catch (_) {}
    });
    if (!looping) loop();
    ws.on('error', () => {});
  });

  function activeClients() {
    let n = 0;
    wss.clients.forEach((c) => { if (c.readyState === 1) n++; });
    return n;
  }
  function unionSources() {
    const set = new Set();
    wss.clients.forEach((c) => { if (c.readyState === 1 && Array.isArray(c._sources)) c._sources.forEach((s) => set.add(s)); });
    if (set.size === 0) set.add('__program__');
    return [...set];
  }
  function broadcast(source, image) {
    const data = JSON.stringify({ source, image });
    wss.clients.forEach((c) => {
      if (c.readyState === 1 && (!Array.isArray(c._sources) || c._sources.includes(source))) {
        try { c.send(data); } catch (_) {}
      }
    });
  }

  async function loop() {
    looping = true;
    let idx = 0;
    // Round-robin over the subscribed sources so none starves (throughput is
    // shared: 1 source ≈ full rate; 5 sources ≈ a fifth each).
    while (activeClients() > 0) {
      const sources = unionSources();
      const source = sources[idx % sources.length];
      idx++;
      let image = null;
      try {
        if (source === '__program__') {
          const res = await obs.execute('getProgramPreview');
          if (res && res.ok && res.data) image = res.data.image;
        }
      } catch (_) {}
      if (image) broadcast(source, image);
      await new Promise((r) => setTimeout(r, 40));
    }
    looping = false;
  }

  // UM ERRO AQUI NAO PODE MATAR O AGENTE.
  //
  // O tratador estava so' no servidor HTTP, mas o `ws` REEMITE o erro na sua
  // propria instancia — e um 'error' sem ouvinte derruba o processo. Bastava
  // abrir o agente uma segunda vez (coisa que num clube acontece) para a
  // segunda janela cuspir um despejo do Node e fechar. A previa e' um extra: o
  // que interessa e' a ponte para o OBS, e essa continua.
  // Os dois emitem o MESMO erro; avisa-se uma vez.
  var jaAvisou = false;
  function falhaDaPrevia(e) {
    if (jaAvisou) return;
    jaAvisou = true;
    if (e && e.code === 'EADDRINUSE') {
      log('warn', `Prévia local indisponível: a porta ${port} já está ocupada — o mais provável é já teres o PoolSync Agent aberto. O resto continua a funcionar.`);
      return;
    }
    log('warn', `Prévia local indisponível (porta ${port}): ${e && e.message}`);
  }
  server.on('error', falhaDaPrevia);
  wss.on('error', falhaDaPrevia);
  server.listen(port, '127.0.0.1', () => log('info', `Prévia local pronta em ws://localhost:${port}/preview`));

  return { close() { try { wss.close(); server.close(); } catch (_) {} } };
}

module.exports = { startLocalPreview };
