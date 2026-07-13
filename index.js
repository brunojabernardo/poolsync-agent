// PoolSync Agent — runs on the operator's machine, controls the local OBS on
// behalf of the NICESTSB app.
//
// Usage:
//   node index.js            Run the agent (connect to OBS + server, stay alive)
//   node index.js status     Connect, print the full OBS state, exit
//   node index.js scenes     Connect, list scenes, exit
//   node index.js scene "LIVE - Table 1"   Switch program scene once, exit
//   node index.js cameras    Connect, list camera inputs + available devices, exit
//   node index.js layout ["Scene"]   Show which camera sits in which quadrant
//   node index.js set-layout 3,4,1,2  Put mesas in corners [CIMA-ESQ,CIMA-DIR,BAIXO-ESQ,BAIXO-DIR]
//
// The one-shot commands let you verify OBS control WITHOUT the server configured.
const config = require('./config');
const { ObsManager } = require('./obs');
const { ServerLink } = require('./server-link');
const { startLocalPreview } = require('./local-preview');

function stamp() {
  return new Date().toLocaleTimeString('pt-PT');
}

const ICONS = { info: 'ℹ️ ', warn: '⚠️ ', error: '❌', debug: '· ' };

function logLine(level, msg) {
  if (level === 'debug' && !config.verbose) return;
  const fn = level === 'error' ? console.error : console.log;
  fn(`[${stamp()}] ${ICONS[level] || ''} ${msg}`);
}

function banner() {
  console.log('==================================');
  console.log(' PoolSync Agent — NICESTSB ↔ OBS');
  console.log('==================================');
  console.log(` OBS:      ${config.obs.url}`);
  console.log(` Servidor: ${config.server.enabled ? config.server.url : '(modo local — sem ligação ao servidor)'}`);
  console.log('----------------------------------');
}

// ── One-shot CLI commands (connect, do one thing, exit) ──────────────────────
async function runOneShot(command, arg) {
  const obs = new ObsManager(config);
  obs.on('log', logLine);

  // Wait until OBS is identified (or fail fast after a short window).
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout à espera do OBS')), 8000);
    obs.on('state', (s) => {
      if (s.obsConnected) { clearTimeout(timer); resolve(); }
    });
  });

  await obs.connect();
  try {
    await ready;
  } catch (err) {
    logLine('error', err.message);
    await obs.disconnect();
    process.exit(1);
  }

  const s = obs.snapshot();
  if (command === 'status') {
    console.log(JSON.stringify(s, null, 2));
  } else if (command === 'scenes') {
    console.log(`\nCenas (${s.scenes.length}) — atual: "${s.currentProgramScene}"`);
    for (const name of s.scenes) {
      console.log(`  ${name === s.currentProgramScene ? '▶' : ' '} ${name}`);
    }
  } else if (command === 'cameras') {
    const res = await obs.execute('getCameras');
    if (!res.ok) { logLine('error', res.error); }
    else {
      const cams = res.data.cameras || [];
      console.log(`\nCâmaras (${cams.length}):`);
      for (const cam of cams) {
        console.log(`\n  ${cam.label} [${cam.inputName}]`);
        console.log(`    atual: ${cam.currentDeviceId || '(nenhuma)'}`);
        (cam.devices || []).forEach((d) => {
          console.log(`      ${d.value === cam.currentDeviceId ? '▶' : '·'} ${d.name}`);
        });
      }
    }
  } else if (command === 'layout') {
    const res = await obs.execute('getLayout', { scene: arg || undefined });
    if (!res.ok) { logLine('error', res.error); }
    else {
      const d = res.data;
      console.log(`\nLayout de "${d.scene}" (${d.baseWidth}x${d.baseHeight}):`);
      if (d.error) { logLine('warn', d.error); }
      const q = { TOP_LEFT: 'CIMA-ESQ', TOP_RIGHT: 'CIMA-DIR', BOTTOM_LEFT: 'BAIXO-ESQ', BOTTOM_RIGHT: 'BAIXO-DIR' };
      if (!d.cameras.length) console.log('  (nenhuma câmara encontrada nesta cena)');
      for (const c of d.cameras) {
        console.log(`  ${(q[c.quadrant] || c.quadrant).padEnd(9)} → ${c.label}  [${c.inputName}]  (centro ${c.centerX},${c.centerY})`);
      }
    }
  } else if (command === 'stream-info') {
    const r = await obs.obs.call('GetStreamServiceSettings');
    const s = r.streamServiceSettings || {};
    const masked = { ...s };
    if (masked.key) masked.key = `(${String(masked.key).length} chars — oculta)`;
    console.log('\nDefinições de stream ATUAIS no OBS (configura o Facebook Live à mão primeiro):');
    console.log('  streamServiceType:', r.streamServiceType);
    console.log('  streamServiceSettings:', JSON.stringify(masked, null, 2));
  } else if (command === 'frame') {
    const parts = (arg || '').trim().split(/\s+/);
    const num = parts[0];
    const zoom = Number(parts[1] || 0), panX = Number(parts[2] || 0), panY = Number(parts[3] || 0);
    const inputs = await obs._getCameraInputs();
    const byNum = {};
    inputs.forEach((i) => { const mm = /mesa\s*(\d+)/i.exec(i.inputName); if (mm) byNum[mm[1]] = i.inputName; });
    const inputName = byNum[num] || num;
    logLine('info', `A aplicar enquadramento em "${inputName}": zoom=${zoom} panX=${panX} panY=${panY}`);
    const res = await obs.execute('setCameraFraming', { inputName, zoom, panX, panY });
    console.log(JSON.stringify(res, null, 2));
  } else if (command === 'lock-cameras') {
    const res = await obs.execute('lockCameraBoxes');
    if (!res.ok) { logLine('error', res.error); }
    else {
      logLine('info', `Câmaras fixadas em ${res.data.locked} posições (bounds).`);
      const byScene = {};
      res.data.items.forEach((i) => { (byScene[i.scene] = byScene[i.scene] || []).push(`${i.camera}=${i.box}`); });
      for (const [scn, list] of Object.entries(byScene)) console.log(`  ${scn}: ${list.join(', ')}`);
    }
  } else if (command === 'set-layout') {
    const order = (arg || '1,2,3,4').split(',').map((x) => x.trim());
    const quads = ['TOP_LEFT', 'TOP_RIGHT', 'BOTTOM_LEFT', 'BOTTOM_RIGHT'];
    const inputs = await obs._getCameraInputs();
    const byNum = {};
    inputs.forEach((i) => { const mm = /mesa\s*(\d+)/i.exec(i.inputName); if (mm) byNum[mm[1]] = i.inputName; });
    const assignments = order
      .map((num, idx) => ({ inputName: byNum[num], quadrant: quads[idx] }))
      .filter((a) => a.inputName && a.quadrant);
    const res = await obs.execute('setLayout', { assignments });
    if (!res.ok) { logLine('error', res.error); }
    else {
      logLine('info', 'Disposição aplicada.');
      const q = { TOP_LEFT: 'CIMA-ESQ', TOP_RIGHT: 'CIMA-DIR', BOTTOM_LEFT: 'BAIXO-ESQ', BOTTOM_RIGHT: 'BAIXO-DIR' };
      for (const c of res.data.cameras) {
        console.log(`  ${(q[c.quadrant] || c.quadrant).padEnd(9)} → ${c.label}`);
      }
    }
  } else if (command === 'scene') {
    if (!arg) { logLine('error', 'Falta o nome da cena: node index.js scene "Nome"'); }
    else {
      const res = await obs.execute('setScene', { scene: arg });
      if (res.ok) logLine('info', `Cena mudada para "${arg}".`);
      else logLine('error', res.error);
    }
  }

  await obs.disconnect();
  process.exit(0);
}

// ── Long-running agent ───────────────────────────────────────────────────────
async function runAgent() {
  const obs = new ObsManager(config);
  obs.on('log', logLine);

  // Lock cameras to their fixed boxes once, as soon as OBS is connected, so the
  // layout is resolution-independent without the operator doing anything. Only
  // in the long-running agent (not in one-shot CLI commands).
  let didAutoLock = false;
  obs.on('state', (s) => {
    logLine('debug', `estado: cena="${s.currentProgramScene}" stream=${s.streaming} rec=${s.recording} cenas=${s.scenes.length}`);
    if (s.obsConnected && !didAutoLock) {
      didAutoLock = true;
      obs.execute('lockCameraBoxes')
        .then((r) => { if (r && r.ok) logLine('info', `Câmaras fixadas (${r.data.locked} posições) — layout imune à resolução.`); })
        .catch(() => {});
    }
  });

  await obs.connect();

  let link = null;
  if (config.server.enabled) {
    link = new ServerLink(config, obs);
    link.start();
  } else {
    logLine('warn', 'SERVER_URL/DEVICE_KEY não definidos — a correr só com OBS (sem controlo remoto). Preenche o .env para ligar à app.');
  }

  // Smooth local preview (browser on this machine connects over localhost).
  let localPreview = null;
  try { localPreview = startLocalPreview(config, obs, logLine); } catch (err) { logLine('warn', `Prévia local não arrancou: ${err.message}`); }

  const shutdown = async () => {
    logLine('info', 'A encerrar...');
    if (link) link.stop();
    if (localPreview) localPreview.close();
    await obs.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ── Entry ────────────────────────────────────────────────────────────────────
const [, , cmd, ...rest] = process.argv;
banner();

if (['status', 'scenes', 'scene', 'cameras', 'layout', 'set-layout', 'lock-cameras', 'stream-info', 'frame'].includes(cmd)) {
  runOneShot(cmd, rest.join(' ').trim()).catch((err) => {
    logLine('error', err.message);
    process.exit(1);
  });
} else if (!cmd) {
  runAgent().catch((err) => {
    logLine('error', err.message);
    process.exit(1);
  });
} else {
  console.log(`Comando desconhecido: "${cmd}"\nUsa: node index.js [status|scenes|scene "Nome"|cameras|layout|set-layout 1,2,3,4]`);
  process.exit(1);
}
