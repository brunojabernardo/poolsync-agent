// OBS connection manager.
//
// Wraps obs-websocket-js (protocol v5 / OBS 28+): keeps a live connection with
// automatic reconnect, mirrors the relevant OBS state into a plain snapshot,
// and executes the commands the app sends down. It is an EventEmitter:
//   - 'state'  (snapshot)  → emitted whenever the mirrored state changes
//   - 'log'    (level,msg) → human-readable progress for the console
const EventEmitter = require('events');
const OBSWebSocket = require('obs-websocket-js').default;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// Physical camera focus is NOT exposed by OBS (win-dshow keeps focus behind the
// driver's own property page). We control it directly at the Windows level with
// a tiny bundled DirectShow helper (IAMCameraControl). It's extracted from the
// packaged binary to a temp path once, then invoked per focus change.
let _camFocusExe = null;
function ensureCamFocusExe() {
  if (_camFocusExe && fs.existsSync(_camFocusExe)) return _camFocusExe;
  const bundled = path.join(__dirname, 'native', 'CamFocus.exe');
  if (process.pkg) {
    const tmp = path.join(os.tmpdir(), 'poolsync-camfocus.exe');
    try {
      if (!fs.existsSync(tmp) || fs.statSync(tmp).size !== fs.statSync(bundled).size) {
        fs.writeFileSync(tmp, fs.readFileSync(bundled));
      }
      _camFocusExe = tmp;
    } catch (e) { throw new Error('CamFocus.exe indisponível: ' + e.message); }
  } else {
    _camFocusExe = bundled;
  }
  return _camFocusExe;
}
function runCamFocus(args) {
  return new Promise((resolve, reject) => {
    let exe;
    try { exe = ensureCamFocusExe(); } catch (e) { return reject(e); }
    execFile(exe, args, { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      const out = String(stdout || '').trim();
      if (err) return reject(new Error(String(stderr || out || err.message).trim()));
      resolve(out);
    });
  });
}
// Target display box (px) per scene → camera, derived from the shipped scene
// collection. Locking cameras to these boxes with bounds makes the layout
// resolution-independent (any camera fills its box, no deformation).
let CAMERA_BOXES = {};
try { CAMERA_BOXES = require('./camera-boxes.json'); } catch (_) { CAMERA_BOXES = {}; }

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
  'getCameras', 'setCameraDevice', 'getCameraThumbnails',
  // Layout detection + control (which camera sits in which quadrant)
  'getLayout', 'setLayout',
  // Lock cameras to fixed boxes (resolution-independent layout)
  'lockCameraBoxes',
  // Streaming destination (RTMP service + key)
  'getStreamSettings', 'setStreamSettings',
  // Live program preview (screenshot of what's on air)
  'getProgramPreview',
  // Per-camera framing (zoom + pan) via a crop filter on the input
  'setCameraFraming',
  // Per-camera physical focus (auto on/off + 0..100) via the DirectShow helper
  'setCameraFocus', 'getCameraFocus'
]);

// Named OBS services + the EXACT ingest server OBS expects for each (read from
// a real OBS "Facebook Live" setup via GetStreamServiceSettings). The server
// must match OBS's service list or OBS discards the key.
const PLATFORMS = {
  facebook: { service: 'Facebook Live', server: 'rtmps://rtmp-api.facebook.com:443/rtmp/', protocol: 'RTMPS' },
  youtube: { service: 'YouTube - RTMPS', server: 'rtmps://a.rtmps.youtube.com:443/live2', protocol: 'RTMPS' }
};

// Canvas quadrant → top-left corner factor.
const QUADRANT_CORNER = {
  TOP_LEFT: { fx: 0, fy: 0 },
  TOP_RIGHT: { fx: 0.5, fy: 0 },
  BOTTOM_LEFT: { fx: 0, fy: 0.5 },
  BOTTOM_RIGHT: { fx: 0.5, fy: 0.5 }
};

// Friendly label for a camera input, e.g. "Camera Mesa 1" → "Mesa 1".
function cameraLabel(name) {
  const m = /mesa\s*(\d+)/i.exec(String(name || ''));
  return m ? `Mesa ${m[1]}` : String(name || '');
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// Name of the crop/pad filter the app manages on each camera for zoom + pan.
const ZOOM_FILTER = 'PoolSync Zoom';

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
      let framing = { zoom: 0, panX: 0, panY: 0 };
      try { framing = await this._getCameraFraming(name); } catch (_) {}
      out.push({ inputName: name, label: cameraLabel(name), devices, currentDeviceId, framing });
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

  // ── Layout detection ──
  // Read where each camera sits inside a grid scene (default "LIVE - All
  // Tables") and classify it into a quadrant, so the app can show/label the
  // physical arrangement without the operator measuring anything.
  async _getLayout(sceneName) {
    const scene = sceneName || 'LIVE - All Tables';
    const video = await this.obs.call('GetVideoSettings').catch(() => ({}));
    const baseW = Number(video.baseWidth) || 1920;
    const baseH = Number(video.baseHeight) || 1080;

    let items = [];
    try {
      const res = await this.obs.call('GetSceneItemList', { sceneName: scene });
      items = res.sceneItems || [];
    } catch (err) {
      return { scene, baseWidth: baseW, baseHeight: baseH, cameras: [], error: err?.message || String(err) };
    }

    const cameras = [];
    for (const it of items) {
      const name = it.sourceName || '';
      const isCamera = it.inputKind === 'dshow_input' || /mesa\s*\d+/i.test(name) || /camera/i.test(name);
      if (!isCamera) continue;

      const t = it.sceneItemTransform || {};
      const a = Number(t.alignment) || 0; // OBS align bitflags: L=1 R=2 T=4 B=8
      const w = Number(t.width) || 0;
      const h = Number(t.height) || 0;
      const px = Number(t.positionX) || 0;
      const py = Number(t.positionY) || 0;
      const centerX = (a & 1) ? px + w / 2 : (a & 2) ? px - w / 2 : px;
      const centerY = (a & 4) ? py + h / 2 : (a & 8) ? py - h / 2 : py;
      const vert = centerY < baseH / 2 ? 'TOP' : 'BOTTOM';
      const horiz = centerX < baseW / 2 ? 'LEFT' : 'RIGHT';

      cameras.push({
        inputName: name,
        label: cameraLabel(name),
        quadrant: `${vert}_${horiz}`,
        centerX: Math.round(centerX),
        centerY: Math.round(centerY)
      });
    }
    cameras.sort((x, y) => x.label.localeCompare(y.label, undefined, { numeric: true }));
    return { scene, baseWidth: baseW, baseHeight: baseH, cameras };
  }

  // Position each camera into its quadrant in a grid scene (2x2, equal tiles).
  // assignments: [{ inputName, quadrant }]. Bounds keep aspect (SCALE_INNER);
  // since cameras and quadrants are both 16:9 they fill exactly.
  async _setLayout(params) {
    const scene = (params && params.scene) || 'LIVE - All Tables';
    const assignments = (params && Array.isArray(params.assignments)) ? params.assignments : [];
    if (!assignments.length) throw new Error('sem disposição para aplicar');

    const video = await this.obs.call('GetVideoSettings').catch(() => ({}));
    const W = Number(video.baseWidth) || 1920;
    const H = Number(video.baseHeight) || 1080;
    const tileW = Math.round(W / 2);
    const tileH = Math.round(H / 2);

    const { sceneItems } = await this.obs.call('GetSceneItemList', { sceneName: scene });
    const idByName = {};
    (sceneItems || []).forEach((it) => { idByName[it.sourceName] = it.sceneItemId; });

    for (const a of assignments) {
      const id = idByName[a.inputName];
      const corner = QUADRANT_CORNER[a.quadrant];
      if (id == null || !corner) continue;
      await this.obs.call('SetSceneItemTransform', {
        sceneName: scene,
        sceneItemId: id,
        sceneItemTransform: {
          positionX: Math.round(W * corner.fx),
          positionY: Math.round(H * corner.fy),
          alignment: 5, // top-left
          boundsType: 'OBS_BOUNDS_SCALE_INNER',
          boundsAlignment: 0, // centre inside the tile
          boundsWidth: tileW,
          boundsHeight: tileH,
          cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0
        }
      });
    }
    return this._getLayout(scene); // confirm the new arrangement
  }

  // Lock every camera to its designed box using bounds, so any camera fills its
  // box regardless of native resolution (no more deformation). Boxes come from
  // CAMERA_BOXES (derived from the scene collection). Idempotent-ish: re-running
  // just re-applies the same bounds.
  async _lockCameraBoxes() {
    const results = [];
    for (const [sceneName, cams] of Object.entries(CAMERA_BOXES)) {
      let items = [];
      try {
        items = (await this.obs.call('GetSceneItemList', { sceneName })).sceneItems || [];
      } catch (_) {
        continue; // scene may not exist in this collection
      }
      const itemByName = {};
      items.forEach((it) => { itemByName[it.sourceName] = it; });

      for (const [cam, box] of Object.entries(cams)) {
        const it = itemByName[cam];
        if (!it) continue;
        const t = it.sceneItemTransform || {};
        try {
          await this.obs.call('SetSceneItemTransform', {
            sceneName,
            sceneItemId: it.sceneItemId,
            sceneItemTransform: {
              positionX: t.positionX,
              positionY: t.positionY,
              alignment: t.alignment,
              boundsType: 'OBS_BOUNDS_SCALE_INNER',
              boundsAlignment: 0,
              boundsWidth: box[0],
              boundsHeight: box[1]
            }
          });
          results.push({ scene: sceneName, camera: cameraLabel(cam), box: `${box[0]}x${box[1]}` });
        } catch (_) {}
      }
    }
    return { locked: results.length, items: results };
  }

  // ── Streaming destination ──
  // Never echoes the stream key back (only whether one is set).
  async _getStreamSettings() {
    const r = await this.obs.call('GetStreamServiceSettings');
    const s = r.streamServiceSettings || {};
    const service = String(s.service || '');
    const server = String(s.server || '');
    const hay = `${service} ${server}`.toLowerCase();
    let platform = 'custom';
    if (hay.includes('facebook')) platform = 'facebook';
    else if (hay.includes('youtube')) platform = 'youtube';
    return { type: r.streamServiceType || null, platform, service: service || null, server, keySet: !!s.key };
  }

  async _setStreamSettings(params) {
    const platform = (params && params.platform) || 'custom';
    const key = String((params && params.key) || '');
    if (!key) throw new Error('chave de stream em falta');

    if (platform === 'custom') {
      const server = String((params && params.server) || '');
      if (!server) throw new Error('servidor RTMP em falta');
      await this.obs.call('SetStreamServiceSettings', {
        streamServiceType: 'rtmp_custom',
        streamServiceSettings: { server, key, use_auth: false, bwtest: false }
      });
      return this._getStreamSettings();
    }

    const p = PLATFORMS[platform];
    if (!p) throw new Error('plataforma desconhecida');
    // Named service with the exact server OBS expects → OBS shows "Facebook
    // Live" and the key populates the Stream Key field.
    const settings = { service: p.service, server: p.server, key, bwtest: false };
    if (p.protocol) settings.protocol = p.protocol;
    await this.obs.call('SetStreamServiceSettings', {
      streamServiceType: 'rtmp_common',
      streamServiceSettings: settings
    });
    return this._getStreamSettings();
  }

  // Screenshot of the current program scene (the composited output on air),
  // for a live monitoring preview in the admin.
  async _getProgramPreview() {
    const scene = this.state.currentProgramScene;
    if (!scene) return { image: null, scene: null };
    try {
      const shot = await this.obs.call('GetSourceScreenshot', {
        sourceName: scene, imageFormat: 'jpg', imageWidth: 960, imageCompressionQuality: 75
      });
      return { image: shot.imageData || null, scene };
    } catch (_) {
      return { image: null, scene };
    }
  }

  // ── Per-camera framing (zoom + pan), global via a crop filter on the input ──
  // Reads the current crop + the post-filter source size, then recovers the
  // native resolution by adding the crop back (so zoom doesn't compound).
  async _cameraCropAndDims(inputName) {
    let crop = { left: 0, top: 0, right: 0, bottom: 0 };
    try {
      const f = await this.obs.call('GetSourceFilter', { sourceName: inputName, filterName: ZOOM_FILTER });
      const s = f.filterSettings || {};
      crop = { left: +s.left || 0, top: +s.top || 0, right: +s.right || 0, bottom: +s.bottom || 0 };
    } catch (_) {}
    let w = 1920, h = 1080;
    for (const scene of ['LIVE - All Tables', 'LIVE - Table 1', 'LIVE - Table 2']) {
      try {
        const { sceneItems } = await this.obs.call('GetSceneItemList', { sceneName: scene });
        const it = (sceneItems || []).find((x) => x.sourceName === inputName);
        const t = it && it.sceneItemTransform;
        if (t && t.sourceWidth) { w = t.sourceWidth; h = t.sourceHeight; break; }
      } catch (_) {}
    }
    // sceneItem sourceWidth/Height stay at the camera's native resolution even
    // with the crop filter applied, so use them directly (adding the crop back
    // would inflate the size and make zoom read/apply wrong).
    return { crop, nativeW: w, nativeH: h };
  }

  async _getCameraFraming(inputName) {
    const { crop, nativeW, nativeH } = await this._cameraCropAndDims(inputName);
    const zoom = nativeW ? (crop.left + crop.right) / nativeW : 0;
    const panX = (crop.left + crop.right) ? (crop.left - crop.right) / (crop.left + crop.right) : 0;
    const panY = (crop.top + crop.bottom) ? (crop.top - crop.bottom) / (crop.top + crop.bottom) : 0;
    const r2 = (n) => Math.round(n * 100) / 100;
    return { zoom: r2(zoom), panX: r2(panX), panY: r2(panY) };
  }

  async _setCameraFraming(params) {
    const inputName = params && params.inputName;
    if (!inputName) throw new Error('inputName em falta');
    const zoom = clamp(Number(params.zoom) || 0, 0, 0.8);
    const panX = clamp(Number(params.panX) || 0, -1, 1);
    const panY = clamp(Number(params.panY) || 0, -1, 1);

    const { nativeW, nativeH } = await this._cameraCropAndDims(inputName);
    const halfX = Math.round((zoom * nativeW) / 2);
    const halfY = Math.round((zoom * nativeH) / 2);
    const settings = {
      relative: true,
      left: Math.max(0, Math.round(halfX + panX * halfX)),
      right: Math.max(0, Math.round(halfX - panX * halfX)),
      top: Math.max(0, Math.round(halfY + panY * halfY)),
      bottom: Math.max(0, Math.round(halfY - panY * halfY))
    };
    // Update the filter, creating it the first time.
    try {
      await this.obs.call('SetSourceFilterSettings', { sourceName: inputName, filterName: ZOOM_FILTER, filterSettings: settings });
    } catch (_) {
      await this.obs.call('CreateSourceFilter', {
        sourceName: inputName, filterName: ZOOM_FILTER, filterKind: 'crop_filter', filterSettings: settings
      });
    }
    return { inputName, framing: await this._getCameraFraming(inputName) };
  }

  // ── Per-camera physical focus (auto on/off + 0..100) ──
  // Resolve the OBS input's device to a friendly name, then drive its UVC focus
  // via the DirectShow helper (percent → device range mapping happens there).
  async _cameraDeviceName(inputName) {
    const s = await this.obs.call('GetInputSettings', { inputName });
    const vid = (s.inputSettings && (s.inputSettings.video_device_id || s.inputSettings.last_video_device_id)) || '';
    // OBS stores "<FriendlyName>:<device path>"; the name is the unique-enough match.
    const name = String(vid).split(':')[0].trim();
    if (!name) throw new Error('câmara sem dispositivo atribuído');
    return name;
  }

  async _setCameraFocus(params) {
    const inputName = params && params.inputName;
    if (!inputName) throw new Error('inputName em falta');
    const auto = !!(params && params.auto);
    const value = Math.max(0, Math.min(100, Math.round(Number(params && params.value) || 0)));
    const device = await this._cameraDeviceName(inputName);
    const out = await runCamFocus(['set', device, auto ? 'auto' : String(value)]);
    return { inputName, device, focus: { auto, value }, helper: out };
  }

  // Diagnostic: read the camera's real focus range/current value via the helper.
  async _getCameraFocus(inputName) {
    if (!inputName) throw new Error('inputName em falta');
    const device = await this._cameraDeviceName(inputName);
    const out = await runCamFocus(['get', device]);
    return { inputName, device, helper: out };
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
        case 'getLayout':
          return { ok: true, data: await this._getLayout(params && params.scene) };
        case 'setLayout':
          return { ok: true, data: await this._setLayout(params) };
        case 'lockCameraBoxes':
          return { ok: true, data: await this._lockCameraBoxes() };
        case 'getStreamSettings':
          return { ok: true, data: await this._getStreamSettings() };
        case 'setStreamSettings':
          return { ok: true, data: await this._setStreamSettings(params) };
        case 'getProgramPreview':
          return { ok: true, data: await this._getProgramPreview() };
        case 'setCameraFraming':
          return { ok: true, data: await this._setCameraFraming(params) };
        case 'setCameraFocus':
          return { ok: true, data: await this._setCameraFocus(params) };
        case 'getCameraFocus':
          return { ok: true, data: await this._getCameraFocus(params && params.inputName) };

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
