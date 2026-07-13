// Cloud link: connects the agent to the NICESTSB server over Socket.IO and
// bridges it to the local OBS manager.
//
//   server ──'obs:command' {action,params} + ack──▶ agent ──▶ OBS
//   agent  ──'obs:state'   (snapshot)────────────▶ server ──▶ admin UI
//
// The agent authenticates with a device key (handshake auth). The server side
// (Phase 2) recognises `role: 'agent'` and routes commands to it.
const { io } = require('socket.io-client');

class ServerLink {
  constructor(config, obsManager) {
    this.config = config;
    this.obs = obsManager;
    this.socket = null;
  }

  log(level, msg) {
    if (this.obs) this.obs.emit('log', level, `[server] ${msg}`);
  }

  start() {
    const { url, deviceKey, user } = this.config.server;

    this.socket = io(url, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 30000,
      auth: {
        role: 'agent',
        deviceKey,
        user: user || undefined
      }
    });

    this.socket.on('connect', () => {
      this.log('info', `Ligado ao servidor ${url} (id ${this.socket.id}).`);
      // Push current OBS state immediately so the admin reflects reality.
      this.pushState(this.obs.snapshot());
    });

    this.socket.on('disconnect', (reason) => {
      this.log('warn', `Desligado do servidor (${reason}).`);
    });

    this.socket.on('connect_error', (err) => {
      this.log('error', `Falha a ligar ao servidor: ${err?.message || err}`);
    });

    // Commands from the app. `ack` (if provided) receives the result.
    this.socket.on('obs:command', async (payload, ack) => {
      const action = payload?.action;
      const params = payload?.params || {};
      this.log('info', `Comando recebido: ${action} ${params.scene ? `→ "${params.scene}"` : ''}`.trim());
      const result = await this.obs.execute(action, params);
      if (typeof ack === 'function') ack(result);
      // State also flows up via the 'state' listener, but push proactively so
      // a command that changed nothing observable still confirms current state.
      this.pushState(this.obs.snapshot());
    });

    // Keep the server's mirror fresh whenever OBS state changes.
    this.obs.on('state', (snapshot) => this.pushState(snapshot));
  }

  pushState(snapshot) {
    if (this.socket && this.socket.connected) {
      this.socket.emit('obs:state', snapshot);
    }
  }

  stop() {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }
}

module.exports = { ServerLink };
