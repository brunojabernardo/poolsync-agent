// PoolSync Agent — runs on the operator's machine, controls the local OBS on
// behalf of the NICESTSB app.
//
// Usage:
//   node index.js            Run the agent (connect to OBS + server, stay alive)
//   node index.js status     Connect, print the full OBS state, exit
//   node index.js scenes     Connect, list scenes, exit
//   node index.js scene "LIVE - Table 1"   Switch program scene once, exit
//   node index.js cameras    Connect, list camera inputs + available devices, exit
//
// The one-shot commands let you verify OBS control WITHOUT the server configured.
const config = require('./config');
const { ObsManager } = require('./obs');
const { ServerLink } = require('./server-link');

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
  obs.on('state', (s) => {
    logLine('debug', `estado: cena="${s.currentProgramScene}" stream=${s.streaming} rec=${s.recording} cenas=${s.scenes.length}`);
  });

  await obs.connect();

  let link = null;
  if (config.server.enabled) {
    link = new ServerLink(config, obs);
    link.start();
  } else {
    logLine('warn', 'SERVER_URL/DEVICE_KEY não definidos — a correr só com OBS (sem controlo remoto). Preenche o .env para ligar à app.');
  }

  const shutdown = async () => {
    logLine('info', 'A encerrar...');
    if (link) link.stop();
    await obs.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ── Entry ────────────────────────────────────────────────────────────────────
const [, , cmd, ...rest] = process.argv;
banner();

if (cmd === 'status' || cmd === 'scenes' || cmd === 'scene' || cmd === 'cameras') {
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
  console.log(`Comando desconhecido: "${cmd}"\nUsa: node index.js [status|scenes|scene "Nome"|cameras]`);
  process.exit(1);
}
