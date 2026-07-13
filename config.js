// Loads and validates the agent configuration from environment variables.
// The .env file lives next to this file and is git-ignored (it holds the OBS
// password and the device key). See .env.example for the expected shape.
require('dotenv').config();

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

const config = {
  // OBS WebSocket (local machine). Password may be empty if OBS auth is off.
  obs: {
    host: process.env.OBS_HOST || '127.0.0.1',
    port: Number(process.env.OBS_PORT || 4455),
    password: process.env.OBS_PASSWORD || ''
  },

  // NICESTSB server the agent relays through. Empty SERVER_URL = local-only
  // mode (OBS control via CLI, no cloud link) — handy for first tests.
  server: {
    url: (process.env.SERVER_URL || '').trim(),
    deviceKey: (process.env.DEVICE_KEY || '').trim(),
    // Optional: handle is only used as a fallback identifier in logs.
    user: (process.env.USER_HANDLE || '').trim()
  },

  // Reconnect tuning (milliseconds).
  reconnect: {
    obsBaseDelay: Number(process.env.OBS_RECONNECT_MS || 3000),
    obsMaxDelay: Number(process.env.OBS_RECONNECT_MAX_MS || 30000)
  },

  verbose: bool(process.env.VERBOSE, false)
};

config.obs.url = `ws://${config.obs.host}:${config.obs.port}`;
config.server.enabled = Boolean(config.server.url && config.server.deviceKey);

module.exports = config;
