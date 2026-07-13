// OBS connection manager.
//
// Wraps obs-websocket-js (protocol v5 / OBS 28+): keeps a live connection with
// automatic reconnect, mirrors the relevant OBS state into a plain snapshot,
// and executes the commands the app sends down. It is an EventEmitter:
//   - 'state'  (snapshot)  → emitted whenever the mirrored state changes
//   - 'log'    (level,msg) → human-readable progress for the console
const EventEmitter = require('events');
const OBSWebSocket = require('obs-websocket-js').default;

// The set of high-level actions the app is allowed to trigger. Each maps to one
// or more OBS requests. Scene names are validated by OBS itself (a bad name
// returns a request error we surface back to the caller).
const ACTIONS = new Set([
  'getState',
  'setScene',
  'setPreviewScene',
  'triggerTransition',
  'setStudioMode',
  'startStream', 'stopStream', 'toggleStream',
  'startRecord', 'stopRecord', 'toggleRecord',
  // Camera identification
  'getCameras', 'setCameraDevice', 'getCameraThumbnails'
]);

// Friendly label for a camera input, e.g. "Camera Mesa 1" → "Mesa 1".
function cameraLabel(name) {
  const m = /mesa\s*(\d+)/i.exec(String(name || ''));
  return m ? `Mesa ${m[1]}` : String(name || '');
}

class ObsManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.obs = new OBSWebSocket();
    this.connected = false;
    this.closing = false;
    this.reconnectTimer = null;
    this.reconnectDelay = config.reconnect.obsBaseDelay;

    // Mirrored OBS state. `null`/`false` until we identify with OBS.
    this.state = {
      obsConnected: false,
      obsVersion: null,
      studioMode: false,
      currentProgramScene: null,
      currentPreviewScene: null,
      scenes: [],
      streaming: false,
      recording: false
    };

    this._wireEvents();
  }

  log(level, msg) {
    this.emit('log', level, msg);
  }

  // Shallow-merge into state and notify listeners.
  _setState(patch) {
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (JSON.stringify(this.state[k]) !== JSON.stringify(v)) {
        this.state[k] = v;
        changed = true;
      }
    }
    if (changed) this.emit('state', this.snapshot());
  }

  snapshot() {
    return { ...this.state, scenes: [...this.state.scenes] };
  }

  _wireEvents() {
    const obs = this.obs;

    obs.on('ConnectionClosed', () => {
      const wasConnected = this.connected;
      this.connected = false;
      this._setState({ obsConnected: false });
      // Only a genuinely dropped link is a warning; an intentional disconnect
      // (CLI exit / shutdown) sets `closing` first and stays quiet.
      if (wasConnected && !this.closing) {
        this.log('warn', 'Ligação ao OBS perdida.');
        this._scheduleReconnect();
      }
    });

    obs.on('ConnectionError', (err) => {
      this.log('error', `Erro OBS: ${err?.message || err}`);
    });

    // Live OBS events → keep the mirror in sync without polling.
    obs.on('CurrentProgramSceneChanged', (d) =>
      this._setState({ currentProgramScene: d.sceneName }));
    obs.on('CurrentPreviewSceneChanged', (d) =>
      this._setState({ currentPreviewScene: d.sceneName }));
    obs.on('StudioModeStateChanged', (d) =>
      this._setState({ studioMode: !!d.studioModeEnabled }));
    obs.on('StreamStateChanged', (d) =>
      this._setState({ streaming: !!d.outputActive }));
    obs.on('RecordStateChanged', (d) =>
      this._setState({ recording: !!d.outputActive }));
    // Any structural scene change → re-read the list.
    const refreshScenes = () => this._refreshScenes().catch(() => {});
    obs.on('SceneListChanged', refreshScenes);
    obs.on('SceneCreated', refreshScenes);
    obs.on('SceneRemoved', refreshScenes);
    obs.on('SceneNameChanged', refreshScenes);
  }

  async connect() {
    this.closing = false;
    try {
      const { obsWebSocketVersion } = await this.obs.connect(
        this.config.obs.url,
        this.config.obs.password || undefined
      );
      this.connected = true;
      this.reconnectDelay = this.config.reconnect.obsBaseDelay;
      this.log('info', `Ligado ao OBS (websocket ${obsWebSocketVersion}) em ${this.config.obs.url}`);
      await this._readFullState();
    } catch (err) {
      this.log('error', `Não consegui ligar ao OBS em ${this.config.obs.url}: ${err?.message || err}`);
      if (!this.closing) this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.log('info', `A tentar reconectar ao OBS em ${Math.round(delay / 1000)}s...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(
        this.reconnectDelay * 2,
        this.config.reconnect.obsMaxDelay
      );
      this.connect();
    }, delay);
  }

  async disconnect() {
    this.closing = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try { await this.obs.disconnect(); } catch (_) {}
    this.connected = false;
    this._setState({ obsConnected: false });
  }

  // Read everything we mirror in one pass (used on connect).
  async _readFullState() {
    const [version, sceneList, studio, stream, record] = await Promise.all([
      this.obs.call('GetVersion').catch(() => ({})),
      this.obs.call('GetSceneList').catch(() => ({ scenes: [] })),
      this.obs.call('GetStudioModeEnabled').catch(() => ({ studioModeEnabled: false })),
      this.obs.call('GetStreamStatus').catch(() => ({ outputActive: false })),
      this.obs.call('GetRecordStatus').catch(() => ({ outputActive: false }))
    ]);

    this._setState({
      obsConnected: true,
      obsVersion: version.obsVersion || null,
      scenes: this._normalizeScenes(sceneList.scenes),
      currentProgramScene: sceneList.currentProgramSceneName || null,
      currentPreviewScene: sceneList.currentPreviewSceneName || null,
      studioMode: !!studio.studioModeEnabled,
      streaming: !!stream.outputActive,
      recording: !!record.outputActive
    });
  }

  async _refreshScenes() {
    const sceneList = await this.obs.call('GetSceneList');
    this._setState({
      scenes: this._normalizeScenes(sceneList.scenes),
      currentProgramScene: sceneList.currentProgramSceneName || this.state.currentProgramScene,
      currentPreviewScene: sceneList.currentPreviewSceneName || this.state.currentPreviewScene
    });
  }

  // OBS returns scenes newest-first; present them top-to-bottom as shown in OBS.
  _normalizeScenes(scenes) {
    if (!Array.isArray(scenes)) return [];
    return scenes
      .slice()
      .sort((a, b) => (b.sceneIndex ?? 0) - (a.sceneIndex ?? 0))
      .map((s) => s.sceneName)
      .filter(Boolean);
  }

  // ── Camera identification ──
  // The scene collection ships 4 fixed capture sources ("Camera Mesa 1..4").
  // Identifying a camera = pointing one of these sources at the right physical
  // device. We expose the device options + live thumbnails so the app can do
  // this visually.
  async _getCameraInputs() {
    const { inputs } = await this.obs.call('GetInputList');
    return (inputs || []).filter((i) => i.inputKind === 'dshow_input');
  }

  async _getCameras() {
    const cams = await this._getCameraInputs();
    const out = [];
    for (const cam of cams) {
      const name = cam.inputName;
      let devices = [];
      let currentDeviceId = null;
      try {
        const items = await this.obs.call('GetInputPropertiesListPropertyItems', {
          inputName: name, propertyName: 'video_device_id'
        });
        devices = (items.propertyItems || [])
          .filter((p) => p.itemEnabled !== false && p.itemValue)
          .map((p) => ({ name: p.itemName, value: String(p.itemValue) }));
      } catch (_) {}
      try {
        const s = await this.obs.call('GetInputSettings', { inputName: name });
        const v = s.inputSettings && (s.inputSettings.video_device_id || s.inputSettings.last_video_device_id);
        currentDeviceId = v ? String(v) : null;
      } catch (_) {}
      out.push({ inputName: name, label: cameraLabel(name), devices, currentDeviceId });
    }
    out.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    return { cameras: out };
  }

  async _setCameraDevice(params) {
    const inputName = params && params.inputName;
    const deviceId = params && params.deviceId;
    if (!inputName || !deviceId) throw new Error('inputName/deviceId em falta');
    await this.obs.call('SetInputSettings', {
      inputName,
      inputSettings: { video_device_id: deviceId, last_video_device_id: deviceId },
      overlay: true
    });
  }

  async _getCameraThumbnails(names) {
    const list = Array.isArray(names) && names.length
      ? names
      : (await this._getCameraInputs()).map((c) => c.inputName);
    const thumbnails = {};
    for (const name of list) {
      try {
        const shot = await this.obs.call('GetSourceScreenshot', {
          sourceName: name, imageFormat: 'jpg', imageWidth: 320
        });
        thumbnails[name] = shot.imageData || null; // full data: URL
      } catch (_) {
        thumbnails[name] = null;
      }
    }
    return { thumbnails };
  }

  // Execute a high-level command. Returns { ok, data } or { ok:false, error }.
  async execute(action, params = {}) {
    if (!ACTIONS.has(action)) {
      return { ok: false, error: `Ação desconhecida: ${action}` };
    }
    if (action === 'getState') {
      return { ok: true, data: this.snapshot() };
    }
    if (!this.connected) {
      return { ok: false, error: 'OBS não está ligado.' };
    }

    try {
      switch (action) {
        // Data-returning actions bypass the snapshot return below.
        case 'getCameras':
          return { ok: true, data: await this._getCameras() };
        case 'setCameraDevice':
          await this._setCameraDevice(params);
          return { ok: true, data: await this._getCameras() };
        case 'getCameraThumbnails':
          return { ok: true, data: await this._getCameraThumbnails(params && params.names) };

        case 'setScene':
          await this.obs.call('SetCurrentProgramScene', { sceneName: params.scene });
          break;
        case 'setPreviewScene':
          await this.obs.call('SetCurrentPreviewScene', { sceneName: params.scene });
          break;
        case 'triggerTransition':
          await this.obs.call('TriggerStudioModeTransition');
          break;
        case 'setStudioMode':
          await this.obs.call('SetStudioModeEnabled', { studioModeEnabled: !!params.enabled });
          break;
        case 'startStream': await this.obs.call('StartStream'); break;
        case 'stopStream': await this.obs.call('StopStream'); break;
        case 'toggleStream': await this.obs.call('ToggleStream'); break;
        case 'startRecord': await this.obs.call('StartRecord'); break;
        case 'stopRecord': await this.obs.call('StopRecord'); break;
        case 'toggleRecord': await this.obs.call('ToggleRecord'); break;
      }
      return { ok: true, data: this.snapshot() };
    } catch (err) {
      const msg = err?.message || String(err);
      this.log('warn', `Comando "${action}" falhou: ${msg}`);
      return { ok: false, error: msg };
    }
  }
}

module.exports = { ObsManager, ACTIONS };
