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

// Native UVC camera control (Pan/Tilt/Zoom/Focus) is NOT reachable through OBS —
// it lives behind the driver's "Configure Video -> Camera Control" page. We drive
// it directly at the Windows level with a tiny bundled DirectShow helper
// (IAMCameraControl). Because the camera moves internally, the output frame
// geometry is unchanged, so overlay masks stay aligned (unlike a digital crop).
// The helper is extracted from the packaged binary to a temp path once.
let _camCtlExe = null;
function ensureCamCtlExe() {
  if (_camCtlExe && fs.existsSync(_camCtlExe)) return _camCtlExe;
  const bundled = path.join(__dirname, 'native', 'CamCtl.exe');
  if (process.pkg) {
    const tmp = path.join(os.tmpdir(), 'poolsync-camctl.exe');
    try {
      if (!fs.existsSync(tmp) || fs.statSync(tmp).size !== fs.statSync(bundled).size) {
        fs.writeFileSync(tmp, fs.readFileSync(bundled));
      }
      _camCtlExe = tmp;
    } catch (e) { throw new Error('CamCtl.exe indisponível: ' + e.message); }
  } else {
    _camCtlExe = bundled;
  }
  return _camCtlExe;
}
function runCamCtl(args) {
  return new Promise((resolve, reject) => {
    let exe;
    try { exe = ensureCamCtlExe(); } catch (e) { return reject(e); }
    execFile(exe, args, { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      const out = String(stdout || '').trim();
      if (err) return reject(new Error(String(stderr || out || err.message).trim()));
      resolve(out);
    });
  });
}
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
  // Endereço/qualidade das câmaras IP (RTSP)
  'setCameraSource',
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
  // Native UVC camera control (Pan/Tilt/Zoom/Focus) via DirectShow helper
  'getCameraControls', 'setCameraControl'
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

// Friendly label for a camera input: "Camera Mesa 1" ou "Camera 1" → "Mesa 1".
function cameraLabel(name) {
  const s = String(name || '');
  const m = /mesa\s*(\d+)/i.exec(s) || /^c[âa]m[ae]ra\s*(\d+)\b/i.exec(s.trim());
  return m ? `Mesa ${m[1]}` : s;
}

// Uma "câmara" é uma captura USB (dshow) ou uma câmara IP, que entra no OBS como
// media source (ffmpeg). Nas IP só contam as fontes chamadas "Camera …", senão um
// vídeo de intro qualquer passava por câmara.
function isCameraInput(kind, name) {
  if (kind === 'dshow_input') return true;
  return kind === 'ffmpeg_source' && /^c[âa]m[ae]ra\b/i.test(String(name || '').trim());
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function r2(n) { return Math.round(n * 100) / 100; }

// Name of the crop/pad filter the app used to manage on each camera for zoom.
// Substituído pelo recorte por cena (ver _setCameraFraming); só o removemos.
const ZOOM_FILTER = 'PoolSync Zoom';

// ── Enquadramento (zoom + pan) em píxeis da fonte ──
// A região visível mantém sempre a proporção da caixa onde a câmara é desenhada,
// por isso a imagem enche a caixa exatamente: sem barras, sem deformação e sem
// mexer no retângulo que está no ar (a máscara dos cantos fica alinhada).
const MAX_ZOOM = 0.85;

// Resolucao que se pede a uma camara USB quando ela a suporta.
const CAM_RESOLUCAO_ALVO = '1920x1080';

function fitInside(srcW, srcH, aspect) {
  let w = srcW, h = srcW / aspect;
  if (h > srcH) { h = srcH; w = srcH * aspect; }
  return { w, h };
}

function framingCrop(srcW, srcH, aspect, zoom, panX, panY) {
  const full = fitInside(srcW, srcH, aspect);
  const w = Math.round(full.w * (1 - zoom));
  const h = Math.round(full.h * (1 - zoom));
  const left = clamp(Math.round(srcW / 2 + (panX * (srcW - w)) / 2 - w / 2), 0, Math.max(0, srcW - w));
  const top = clamp(Math.round(srcH / 2 + (panY * (srcH - h)) / 2 - h / 2), 0, Math.max(0, srcH - h));
  return { left, top, right: Math.max(0, srcW - left - w), bottom: Math.max(0, srcH - top - h) };
}

// Inverso do anterior. Recortes feitos à mão no OBS que não sigam esta convenção
// dão zoom 0 (é o mínimo) — assim que se mexe num controlo, normalizam-se.
function framingFromCrop(srcW, srcH, aspect, crop) {
  const full = fitInside(srcW, srcH, aspect);
  const w = srcW - crop.left - crop.right;
  const h = srcH - crop.top - crop.bottom;
  if (!(w > 0 && h > 0 && full.w > 0 && full.h > 0)) return { zoom: 0, panX: 0, panY: 0 };
  return {
    zoom: clamp(1 - w / full.w, 0, MAX_ZOOM),
    panX: srcW - w > 1 ? clamp((crop.left + w / 2 - srcW / 2) / ((srcW - w) / 2), -1, 1) : 0,
    panY: srcH - h > 1 ? clamp((crop.top + h / 2 - srcH / 2) / ((srcH - h) / 2), -1, 1) : 0
  };
}

// Caixa onde o item é desenhado: os bounds quando existem, senão o tamanho já
// renderizado (é esse que vamos fixar em bounds).
function itemBox(t) {
  const hasBounds = t.boundsType && t.boundsType !== 'OBS_BOUNDS_NONE' && t.boundsWidth > 1 && t.boundsHeight > 1;
  const w = hasBounds ? t.boundsWidth : t.width;
  const h = hasBounds ? t.boundsHeight : t.height;
  return w > 1 && h > 1 ? { w, h } : null;
}

// Qualidade do stream RTSP: quase todas as câmaras servem um stream principal e
// um secundário no mesmo endereço, com o nome trocado (Reolink `_main`/`_sub`,
// Dahua `subtype=`, Hikvision `/Channels/101`). Sem padrão conhecido → só o
// endereço à mão.
function rtspQuality(url) {
  const s = String(url || '');
  if (/_sub\b/i.test(s) || /subtype=1\b/i.test(s) || /\/Channels\/\d02\b/i.test(s)) return 'sub';
  if (/_main\b/i.test(s) || /subtype=0\b/i.test(s) || /\/Channels\/\d01\b/i.test(s)) return 'main';
  return null;
}

function rtspWithQuality(url, quality) {
  const s = String(url || '');
  const want = quality === 'sub' ? 'sub' : 'main';
  if (/_(main|sub)\b/i.test(s)) return s.replace(/_(main|sub)\b/i, '_' + want);
  if (/subtype=[01]\b/i.test(s)) return s.replace(/subtype=[01]\b/i, 'subtype=' + (want === 'sub' ? 1 : 0));
  if (/\/Channels\/(\d)0[12]\b/i.test(s)) return s.replace(/\/Channels\/(\d)0[12]\b/i, (m, ch) => `/Channels/${ch}0${want === 'sub' ? 2 : 1}`);
  return s;
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
    return (inputs || []).filter((i) => isCameraInput(i.inputKind, i.inputName));
  }

  async _getCameras() {
    const cams = await this._getCameraInputs();
    const idx = await this._sceneItemIndex();
    const out = [];
    for (const cam of cams) {
      const name = cam.inputName;
      const kind = cam.inputKind;
      const entry = { inputName: name, label: cameraLabel(name), kind, devices: [], currentDeviceId: null, url: null, quality: null };

      if (kind === 'dshow_input') {
        try {
          const items = await this.obs.call('GetInputPropertiesListPropertyItems', {
            inputName: name, propertyName: 'video_device_id'
          });
          entry.devices = (items.propertyItems || [])
            .filter((p) => p.itemEnabled !== false && p.itemValue)
            .map((p) => ({ name: p.itemName, value: String(p.itemValue) }));
        } catch (_) {}
        try {
          const s = await this.obs.call('GetInputSettings', { inputName: name });
          const cfg = s.inputSettings || {};
          const v = cfg.video_device_id || cfg.last_video_device_id;
          entry.currentDeviceId = v ? String(v) : null;
          entry.resolucao = Number(cfg.res_type) === 1 ? String(cfg.resolution || '') : '';
        } catch (_) {}
      } else {
        // Câmara IP: o "dispositivo" é o endereço RTSP.
        try {
          const s = await this.obs.call('GetInputSettings', { inputName: name });
          entry.url = String((s.inputSettings && s.inputSettings.input) || '');
          entry.quality = rtspQuality(entry.url);
        } catch (_) {}
      }

      // O endereço de exemplo que vem na coleção não conta como câmara pronta.
      entry.ready = kind === 'dshow_input'
        ? !!entry.currentDeviceId
        : !!entry.url && !/IP_DA_CAMARA|UTILIZADOR|PALAVRA_PASSE/i.test(entry.url);
      try { entry.framing = this._framingFromIndex(name, idx); } catch (_) { entry.framing = null; }
      out.push(entry);
    }
    out.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    return { cameras: out };
  }

  // Endereço RTSP de uma câmara IP. Aceita um `url` novo ou só a `quality`
  // (principal/secundário), reescrevendo o endereço que já lá está.
  async _setCameraSource(params) {
    const inputName = params && params.inputName;
    if (!inputName) throw new Error('inputName em falta');
    const s = await this.obs.call('GetInputSettings', { inputName });
    const current = String((s.inputSettings && s.inputSettings.input) || '');
    let url = params && typeof params.url === 'string' && params.url.trim() ? params.url.trim() : current;
    if (params && params.quality) url = rtspWithQuality(url, params.quality);
    if (!url) throw new Error('endereço em falta');
    await this.obs.call('SetInputSettings', { inputName, inputSettings: { input: url }, overlay: true });
    return this._getCameras();
  }

  // Muitas webcams arrancam na resolução por omissão do dispositivo, que é
  // 640x480 — quadrada ao lado de um placar 16:9, e obriga a andar a acertar
  // tamanhos à mão. Ao escolher a câmara, põe-se 1920x1080 se ela a tiver;
  // senão a maior 16:9 que ofereça; senão fica como estava, que é melhor do
  // que pedir-lhe uma resolução que ela não sabe dar.
  async _melhorResolucao(inputName) {
    let itens = [];
    try {
      const r = await this.obs.call('GetInputPropertiesListPropertyItems', {
        inputName, propertyName: 'resolution'
      });
      itens = (r.propertyItems || [])
        .filter((p) => p.itemEnabled !== false)
        .map((p) => String(p.itemValue || p.itemName || '').trim())
        .filter(Boolean);
    } catch (_) {
      return null; // dispositivo sem lista de resoluções (ou sem dispositivo)
    }
    if (itens.includes(CAM_RESOLUCAO_ALVO)) return CAM_RESOLUCAO_ALVO;
    const dezasseisPorNove = itens
      .map((v) => { const m = /^(\d+)\s*x\s*(\d+)$/.exec(v); return m ? { v, w: Number(m[1]), h: Number(m[2]) } : null; })
      .filter((x) => x && x.h > 0 && Math.abs(x.w / x.h - 16 / 9) < 0.02)
      .sort((a, b) => b.w - a.w);
    return dezasseisPorNove.length ? dezasseisPorNove[0].v : null;
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

    const resolucao = await this._melhorResolucao(inputName);
    if (resolucao) {
      // res_type 1 = "personalizada"; sem isto o OBS ignora a resolução.
      await this.obs.call('SetInputSettings', {
        inputName,
        inputSettings: { res_type: 1, resolution: resolucao },
        overlay: true
      });
    }
    return resolucao;
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

  // ── Índice de cenas → itens ──
  // Quase tudo o que mexe em câmaras precisa de percorrer todas as cenas, e cada
  // percurso são ~20 pedidos ao OBS. Guarda-se por instantes para que abrir a tab
  // não dispare a mesma volta quatro vezes seguidas.
  async _sceneItemIndex(force) {
    const now = Date.now();
    if (!force && this._sceneIdx && now - (this._sceneIdxAt || 0) < 3000) return this._sceneIdx;
    const { scenes } = await this.obs.call('GetSceneList');
    const idx = [];
    for (const sc of scenes || []) {
      try {
        const { sceneItems } = await this.obs.call('GetSceneItemList', { sceneName: sc.sceneName });
        idx.push({ scene: sc.sceneName, items: sceneItems || [] });
      } catch (_) {}
    }
    this._sceneIdx = idx;
    this._sceneIdxAt = now;
    return idx;
  }

  _invalidateSceneIndex() { this._sceneIdxAt = 0; }

  // Cena de grelha onde a disposição das câmaras é editável ("Pool - 4 Mesas" na
  // coleção atual, "LIVE - All Tables" na antiga).
  _gridScene() {
    const scenes = this.state.scenes || [];
    return scenes.find((n) => /(^|-\s*)(\d+\s*mesas|all tables|todas as mesas)/i.test(n)) || 'Pool - 4 Mesas';
  }

  // ── Layout detection ──
  // Read where each camera sits inside the grid scene and classify it into a
  // quadrant, so the app can show/label the physical arrangement without the
  // operator measuring anything.
  async _getLayout(sceneName) {
    const scene = sceneName || this._gridScene();
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
    const scene = (params && params.scene) || this._gridScene();
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
    this._invalidateSceneIndex();
    return this._getLayout(scene); // confirm the new arrangement
  }

  // Fixa cada câmara na caixa que já ocupa, usando bounds. A partir daí a caixa
  // no ar é imune ao que a fonte fizer — trocar de câmara, de resolução ou
  // recortar para dar zoom deixa de mexer no retângulo, e as máscaras dos cantos
  // ficam onde estão. As caixas são lidas da própria coleção, por isso funciona
  // com qualquer conjunto de cenas. Repetir é inofensivo.
  async _lockCameraBoxes() {
    const camNames = new Set((await this._getCameraInputs()).map((i) => i.inputName));
    if (!camNames.size) return { locked: 0, items: [] };
    const idx = await this._sceneItemIndex(true);
    const results = [];
    for (const sc of idx) {
      for (const it of sc.items) {
        if (!camNames.has(it.sourceName)) continue;
        const t = it.sceneItemTransform || {};
        // Só se re-afirma o que JÁ tem bounds. Um item posicionado por escala
        // foi afinado à resolução das câmaras de quem montou a coleção: com uma
        // câmara diferente ele já está a desenhar do tamanho errado, e fixá-lo
        // assim cimentava o erro em vez de o corrigir. Esses ficam como estão,
        // à espera de que a coleção lhes dê bounds.
        const temBounds = t.boundsType && t.boundsType !== 'OBS_BOUNDS_NONE' && t.boundsWidth > 1 && t.boundsHeight > 1;
        if (!temBounds) continue;
        const box = itemBox(t);
        if (!box) continue; // fonte ainda sem imagem (RTSP a ligar) — fica para a próxima
        const w = Math.round(box.w), h = Math.round(box.h);
        try {
          await this.obs.call('SetSceneItemTransform', {
            sceneName: sc.scene,
            sceneItemId: it.sceneItemId,
            sceneItemTransform: {
              boundsType: 'OBS_BOUNDS_SCALE_INNER',
              boundsAlignment: 0,
              boundsWidth: w,
              boundsHeight: h
            }
          });
          results.push({ scene: sc.scene, camera: cameraLabel(it.sourceName), box: `${w}x${h}` });
        } catch (_) {}
      }
    }
    this._invalidateSceneIndex();
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

  // ── Enquadramento por câmara (zoom + pan) ──
  // O recorte é feito em cada item de cena, não num filtro do input. Assim a
  // fonte nunca muda de tamanho (o zoom não se acumula sozinho), e como cada
  // item está fixo em bounds, a caixa no ar não se mexe — só muda o pedaço da
  // imagem que a preenche. Um único zoom/pan por câmara vale para todas as
  // cenas: o recorte é recalculado com a proporção da caixa de cada uma.
  _cameraSceneItems(inputName, idx) {
    const out = [];
    for (const sc of idx) {
      for (const it of sc.items) {
        if (it.sourceName !== inputName) continue;
        const t = it.sceneItemTransform || {};
        const box = itemBox(t);
        const srcW = Number(t.sourceWidth) || 0;
        const srcH = Number(t.sourceHeight) || 0;
        if (!box || !srcW || !srcH) continue;
        out.push({ scene: sc.scene, id: it.sceneItemId, t, box, srcW, srcH });
      }
    }
    return out;
  }

  _framingFromIndex(inputName, idx) {
    const items = this._cameraSceneItems(inputName, idx);
    if (!items.length) return null;
    // Lê da cena de ecrã inteiro quando existe: é a que dá a leitura mais fina.
    const it = items.slice().sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)[0];
    const t = it.t;
    const f = framingFromCrop(it.srcW, it.srcH, it.box.w / it.box.h, {
      left: +t.cropLeft || 0, right: +t.cropRight || 0, top: +t.cropTop || 0, bottom: +t.cropBottom || 0
    });
    return { zoom: r2(f.zoom), panX: r2(f.panX), panY: r2(f.panY), sourceWidth: it.srcW, sourceHeight: it.srcH, scenes: items.length };
  }

  async _getCameraFraming(inputName) {
    return this._framingFromIndex(inputName, await this._sceneItemIndex()) ||
      { zoom: 0, panX: 0, panY: 0, sourceWidth: 0, sourceHeight: 0, scenes: 0 };
  }

  async _setCameraFraming(params) {
    const inputName = params && params.inputName;
    if (!inputName) throw new Error('inputName em falta');
    const zoom = clamp(Number(params.zoom) || 0, 0, MAX_ZOOM);
    const panX = clamp(Number(params.panX) || 0, -1, 1);
    const panY = clamp(Number(params.panY) || 0, -1, 1);

    // O zoom antigo era um filtro no input; com ele lá, os dois recortes
    // somavam-se. Sai à primeira vez que se toca no enquadramento.
    try { await this.obs.call('RemoveSourceFilter', { sourceName: inputName, filterName: ZOOM_FILTER }); } catch (_) {}

    const idx = await this._sceneItemIndex(true);
    const items = this._cameraSceneItems(inputName, idx);
    if (!items.length) throw new Error('câmara sem imagem em nenhuma cena');

    let applied = 0;
    for (const it of items) {
      const crop = framingCrop(it.srcW, it.srcH, it.box.w / it.box.h, zoom, panX, panY);
      try {
        await this.obs.call('SetSceneItemTransform', {
          sceneName: it.scene,
          sceneItemId: it.id,
          sceneItemTransform: {
            boundsType: 'OBS_BOUNDS_SCALE_INNER',
            boundsAlignment: 0,
            boundsWidth: Math.round(it.box.w),
            boundsHeight: Math.round(it.box.h),
            cropLeft: crop.left, cropRight: crop.right, cropTop: crop.top, cropBottom: crop.bottom
          }
        });
        applied++;
      } catch (_) {}
    }
    this._invalidateSceneIndex();
    const first = items[0];
    return {
      inputName,
      applied,
      framing: { zoom: r2(zoom), panX: r2(panX), panY: r2(panY), sourceWidth: first.srcW, sourceHeight: first.srcH, scenes: items.length }
    };
  }

  // ── Native UVC camera control (Pan/Tilt/Zoom/Focus) via the DirectShow helper ──
  // Resolve the OBS input's device to a friendly name, then read/drive the real
  // camera controls. The mask is unaffected (the camera moves internally).
  async _cameraDeviceName(inputName) {
    const s = await this.obs.call('GetInputSettings', { inputName });
    const vid = (s.inputSettings && (s.inputSettings.video_device_id || s.inputSettings.last_video_device_id)) || '';
    const id = String(vid);
    // Prefer the unique USB instance serial (e.g. "354e9445") so identical camera
    // models don't all resolve to the first one. The helper matches it against the
    // device path. Fall back to the friendly name (before ':') when there's no
    // serial (e.g. virtual cameras, which have no camera control anyway).
    const m = /&([0-9a-f]{5,})&\d+&\d+/i.exec(id);
    if (m) return m[1];
    const name = id.split(':')[0].trim();
    if (!name) throw new Error('câmara sem dispositivo atribuído');
    return name;
  }

  async _getCameraControls(inputName) {
    if (!inputName) throw new Error('inputName em falta');
    const device = await this._cameraDeviceName(inputName);
    const out = await runCamCtl(['get', device]);
    let parsed = {};
    try { parsed = JSON.parse(out); } catch (_) { throw new Error('resposta inválida do helper: ' + out); }
    return { inputName, device, controls: (parsed && parsed.controls) || {} };
  }

  async _setCameraControl(params) {
    const inputName = params && params.inputName;
    const prop = params && String(params.prop || '').toLowerCase();
    if (!inputName) throw new Error('inputName em falta');
    if (!['pan', 'tilt', 'zoom', 'focus'].includes(prop)) throw new Error('prop inválida: ' + prop);
    const device = await this._cameraDeviceName(inputName);
    const auto = !!(params && params.auto);
    const arg = auto ? 'auto' : String(Math.round(Number(params && params.value) || 0));
    const out = await runCamCtl(['set', device, prop, arg]);
    let parsed = {};
    try { parsed = JSON.parse(out); } catch (_) {}
    return { inputName, device, prop, result: parsed };
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
        case 'setCameraDevice': {
          const resolucao = await this._setCameraDevice(params);
          return { ok: true, data: Object.assign({ resolucao }, await this._getCameras()) };
        }
        case 'setCameraSource':
          return { ok: true, data: await this._setCameraSource(params) };
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
        case 'getCameraControls':
          return { ok: true, data: await this._getCameraControls(params && params.inputName) };
        case 'setCameraControl':
          return { ok: true, data: await this._setCameraControl(params) };

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

module.exports = { ObsManager, ACTIONS, cameraLabel, framingCrop, framingFromCrop, rtspQuality, rtspWithQuality };
