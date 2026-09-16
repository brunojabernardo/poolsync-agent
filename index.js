// PoolSync Agent — runs on the operator's machine, controls the local OBS on
// behalf of the PoolSync app.
//
// Usage:
//   node index.js            Run the agent (connect to OBS + server, stay alive)
//   node index.js status     Connect, print the full OBS state, exit
//   node index.js scenes     Connect, list scenes, exit
//   node index.js scene "LIVE - Table 1"   Switch program scene once, exit
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
  console.log(' PoolSync Agent — App ↔ OBS');
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
  } else if (command === 'stream-info') {
    const r = await obs.obs.call('GetStreamServiceSettings');
    const s = r.streamServiceSettings || {};
    const masked = { ...s };
    if (masked.key) masked.key = `(${String(masked.key).length} chars — oculta)`;
    console.log('\nDefinições de stream ATUAIS no OBS (configura o Facebook Live à mão primeiro):');
    console.log('  streamServiceType:', r.streamServiceType);
    console.log('  streamServiceSettings:', JSON.stringify(masked, null, 2));
  } else if (command === 'preview') {
    const scene = obs.state.currentProgramScene;
    logLine('info', `currentProgramScene: ${JSON.stringify(scene)}`);
    if (!scene) { logLine('warn', 'Sem cena de programa definida — nada para capturar.'); }
    else {
      try {
        const shot = await obs.obs.call('GetSourceScreenshot', {
          sourceName: scene, imageFormat: 'jpg', imageWidth: 960, imageCompressionQuality: 75
        });
        logLine('info', `screenshot OK — ${shot.imageData ? (shot.imageData.length + ' chars') : 'SEM imageData'}`);
      } catch (err) {
        logLine('error', `GetSourceScreenshot falhou: ${err && err.message ? err.message : err}`);
      }
    }
  } else if (command === 'lock-cameras') {
    const res = await obs.execute('lockCameraBoxes');
    if (!res.ok) { logLine('error', res.error); }
    else {
      logLine('info', `Câmaras fixadas em ${res.data.locked} posições (bounds).`);
      const byScene = {};
      res.data.items.forEach((i) => { (byScene[i.scene] = byScene[i.scene] || []).push(`${i.camera}=${i.box}`); });
      for (const [scn, list] of Object.entries(byScene)) console.log(`  ${scn}: ${list.join(', ')}`);
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

  // Fixa as câmaras nas caixas que já ocupam assim que o OBS liga, para o
  // layout ficar imune à resolução da fonte sem ninguém fazer nada. Só no agente
  // a correr (não nos comandos de uma vez só).
  // Uma câmara IP pode levar uns segundos a dar imagem, e sem imagem não há
  // caixa para fixar — daí as tentativas espaçadas até apanhar alguma.
  let autoLockTries = 0;
  const autoLock = () => {
    autoLockTries++;
    obs.execute('lockCameraBoxes')
      .then((r) => {
        const locked = r && r.ok ? r.data.locked : 0;
        if (locked) logLine('info', `Câmaras fixadas (${locked} posições) — layout imune à resolução.`);
        else if (autoLockTries < 5 && obs.connected) setTimeout(autoLock, 6000);
      })
      .catch(() => {});
  };
  let didAutoLock = false;
  obs.on('state', (s) => {
    logLine('debug', `estado: cena="${s.currentProgramScene}" stream=${s.streaming} rec=${s.recording} cenas=${s.scenes.length}`);
    if (s.obsConnected && !didAutoLock) {
      didAutoLock = true;
      autoLock();
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

if (['status', 'scenes', 'scene', 'lock-cameras', 'stream-info', 'preview'].includes(cmd)) {
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
  console.log(`Comando desconhecido: "${cmd}"\nUsa: node index.js [status|scenes|scene "Nome"|lock-cameras|stream-info|preview]`);
  process.exit(1);
}
