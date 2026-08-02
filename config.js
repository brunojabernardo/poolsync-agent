// Loads and validates the agent configuration.
//
// Sources (highest priority first):
//   1. poolsync.config.json next to the executable  ← used by the packaged .exe
//   2. environment variables / .env next to the executable  ← used in dev
//
// Both files sit next to the running program (the .exe when packaged, this
// folder in dev), so a client just drops the site-generated config file beside
// the .exe. They are git-ignored (they hold the OBS password and device key).
const path = require('path');
const fs = require('fs');

// Where to look for config files: next to the .exe when packaged (pkg), else
// this folder in dev.
const baseDir = process.pkg ? path.dirname(process.execPath) : __dirname;

require('dotenv').config({ path: path.join(baseDir, '.env') });

let fileCfg = {};
try {
  const p = path.join(baseDir, 'poolsync.config.json');
  if (fs.existsSync(p)) fileCfg = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
} catch (_) {
  fileCfg = {};
}

// JSON config wins over env; then env; then fallback.
function val(key, fallback) {
  if (fileCfg[key] !== undefined && fileCfg[key] !== null && fileCfg[key] !== '') return fileCfg[key];
  if (process.env[key] !== undefined && process.env[key] !== '') return process.env[key];
  return fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

const config = {
  baseDir,

  // OBS WebSocket (local machine). Password may be empty if OBS auth is off.
  obs: {
    host: String(val('OBS_HOST', '127.0.0.1')),
    port: Number(val('OBS_PORT', 4455)),
    password: String(val('OBS_PASSWORD', ''))
  },

  // PoolSync server the agent relays through. Empty SERVER_URL = local-only
  // mode (OBS control via CLI, no cloud link) — handy for first tests.
  server: {
    url: String(val('SERVER_URL', '')).trim(),
    deviceKey: String(val('DEVICE_KEY', '')).trim(),
    user: String(val('USER_HANDLE', '')).trim()
  },

  // Local high-fps preview server (browser on the same machine connects to
  // ws://localhost:<port>, bypassing the cloud).
  localPreviewPort: Number(val('LOCAL_PREVIEW_PORT', 4456)),

  // Reconnect tuning (milliseconds).
  reconnect: {
    obsBaseDelay: Number(val('OBS_RECONNECT_MS', 3000)),
    obsMaxDelay: Number(val('OBS_RECONNECT_MAX_MS', 30000))
  },

  verbose: bool(val('VERBOSE', ''), false)
};

config.obs.url = `ws://${config.obs.host}:${config.obs.port}`;
config.server.enabled = Boolean(config.server.url && config.server.deviceKey);

module.exports = config;
