const { app, BrowserWindow, Menu, shell, net, ipcMain } = require('electron');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// ---------- HTML 热更新（ed25519 验签）----------
// 公钥用于校验从 GitHub 拉取的 onecast.html，私钥仅在构建机上用于签名。
// 若签名不匹配，本次更新会被丢弃，继续使用本地缓存或打包内置版本。
const UPDATE_PUB_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEANfoSbw+hjmRHfHzBlhLYiAtKH1yQ4oi5109vmIcIuBI=
-----END PUBLIC KEY-----`;

const HTML_SOURCES = [
  'https://raw.githubusercontent.com/lssqian777-source/132465/main/onecast-desktop/src/onecast.html',
  'https://cdn.jsdelivr.net/gh/lssqian777-source/132465@main/onecast-desktop/src/onecast.html'
];
const SIG_SOURCES = [
  'https://raw.githubusercontent.com/lssqian777-source/132465/main/onecast-desktop/src/onecast.html.sig',
  'https://cdn.jsdelivr.net/gh/lssqian777-source/132465@main/onecast-desktop/src/onecast.html.sig'
];

const CACHE_DIR = () => path.join(app.getPath('userData'), 'render');
const CACHE_HTML = () => path.join(CACHE_DIR(), 'onecast.html');
const BUNDLE_HTML = () => path.join(__dirname, 'src', 'onecast.html');

function resolveHtml() {
  // 优先使用经过验签的本地缓存；缓存不存在或损坏则回退到打包内置版本。
  try {
    const p = CACHE_HTML();
    if (fs.existsSync(p)) {
      const head = fs.readFileSync(p, 'utf8').slice(0, 64);
      if (head.trimStart().startsWith('<!DOCTYPE')) return p;
    }
  } catch (e) {
    /* cache unreadable: fall through to bundle */
  }
  return BUNDLE_HTML();
}

// 依次尝试多个更新源（raw.githubusercontent.com 在部分网络不可达，jsDelivr 作为备用）
async function fetchFirstOk(urls) {
  for (const u of urls) {
    try {
      const r = await net.fetch(u, { signal: AbortSignal.timeout(15000) });
      if (r.ok) return r;
    } catch (e) {
      /* try next source */
    }
  }
  return null;
}

async function checkHtmlUpdate() {
  try {
    const [htmlRes, sigRes] = await Promise.all([
      fetchFirstOk(HTML_SOURCES),
      fetchFirstOk(SIG_SOURCES)
    ]);
    if (!htmlRes || !sigRes) return false;

    const html = await htmlRes.text();
    const sigBase64 = (await sigRes.text()).trim();
    const sig = Buffer.from(sigBase64, 'base64');

    const ok = crypto.verify(
      null,
      Buffer.from(html),
      { key: UPDATE_PUB_KEY, format: 'pem', type: 'spki' },
      sig
    );
    if (!ok) return false;

    let current = '';
    try {
      current = fs.readFileSync(CACHE_HTML(), 'utf8');
    } catch (e) {
      /* no cache yet */
    }
    if (current === html) return false; // 内容未变

    fs.mkdirSync(CACHE_DIR(), { recursive: true });
    fs.writeFileSync(CACHE_HTML(), html);
    return true; // 已更新
  } catch (e) {
    return false;
  }
}

// ---------- 窗口 ----------
const STATE_FILE = () => path.join(app.getPath('userData'), 'window-state.json');
const DEFAULT_BOUNDS = { width: 1440, height: 900 };

function loadBounds() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'));
    if (s && Number.isFinite(s.width) && Number.isFinite(s.height)) return s;
  } catch (e) {
    /* first run, or state file unreadable: fall back to defaults */
  }
  return Object.assign({}, DEFAULT_BOUNDS);
}

function saveBounds(win) {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
  try {
    fs.writeFileSync(STATE_FILE(), JSON.stringify(win.getNormalBounds()));
  } catch (e) {
    /* ignore: losing window geometry is not worth interrupting the user */
  }
}

function isExternal(url) {
  return /^https?:\/\//i.test(url) || /^mailto:/i.test(url);
}

function createWindow() {
  const bounds = loadBounds();

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 1120,
    minHeight: 680,
    show: false,
    backgroundColor: '#0b0f17',
    title: 'OneCast',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false
    }
  });

  Menu.setApplicationMenu(null);
  win.setMenuBarVisibility(false);

  // Deny every web permission by default; a local publishing console needs none of them.
  // Only clipboard writes are allowed, because the copy button relies on it.
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write');
  });
  win.webContents.session.setPermissionCheckHandler((_wc, permission) => {
    return permission === 'clipboard-sanitized-write';
  });

  win.once('ready-to-show', () => win.show());

  // Platform authoring centers must open in the real browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternal(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (isExternal(url)) shell.openExternal(url);
    }
  });

  win.on('close', () => saveBounds(win));

  win.loadFile(resolveHtml());
  return win;
}

// ---------- 自动发布（实验性）----------
// 渲染进程只负责把「文案 + 素材」交过来；真正的浏览器操作全部在主进程里完成，
// 渲染进程始终处于 sandbox 且没有任何 Node 权限。
const { AutoRunner, ADAPTERS, findBrowser } = require('./automation');
let autoRunner = null;

function getRunner() {
  if (!autoRunner) autoRunner = new AutoRunner(app.getPath('userData'));
  return autoRunner;
}

/** 把 data URL 素材落成临时文件，交给浏览器上传控件 */
function writeTempMedia(files) {
  const dir = path.join(os.tmpdir(), 'onecast-auto', String(Date.now()));
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  (files || []).forEach((f, i) => {
    const m = /^data:([^;]+);base64,(.*)$/.exec(f.dataUrl || '');
    if (!m) return;
    const buf = Buffer.from(m[2], 'base64');
    const sub = (m[1].split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '');
    const base = String(f.name || '').replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').slice(0, 80);
    const p = path.join(dir, (base || 'media-' + i) + (/\.[a-z0-9]{2,4}$/i.test(base) ? '' : '.' + sub));
    fs.writeFileSync(p, buf);
    out.push({ path: p, name: f.name || path.basename(p), size: buf.length });
  });
  return out;
}

function registerAutoHandlers() {
  ipcMain.handle('auto:status', () => ({
    browser: findBrowser() || '',
    adapters: Object.keys(ADAPTERS).map(k => ({
      pid: k,
      name: ADAPTERS[k].name,
      note: ADAPTERS[k].note,
      supported: k !== 'wechat'
    }))
  }));

  ipcMain.handle('auto:workbench', async () => {
    try {
      return { ok: true, message: await getRunner().openWorkbench() };
    } catch (e) {
      return { ok: false, message: String(e.message || e) };
    }
  });

  ipcMain.handle('auto:cancel', () => {
    if (autoRunner) autoRunner.cancelled = true;
    return { ok: true };
  });

  ipcMain.handle('auto:run', async (event, payload) => {
    const sender = event.sender;
    const jobs = (payload.jobs || []).map(j => ({
      pid: j.pid,
      content: j.content || {},
      files: writeTempMedia(j.files)
    }));
    const emit = data => {
      if (!sender.isDestroyed()) sender.send('auto:progress', data);
    };
    try {
      const results = await getRunner().run(jobs, { submit: !!payload.submit }, emit);
      return { ok: true, results };
    } catch (e) {
      return { ok: false, results: [], error: String(e.message || e) };
    }
  });
}


const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  // Sandbox every renderer, and never let a <webview> be attached.
  app.enableSandbox();
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    registerAutoHandlers();
    // 启动时静默拉取最新界面（ed25519 验签），拉到就直接加载新版本；
    // 拉不到（如未开代理）就继续用本地缓存/内置版本，全程不弹窗。
    // ONECAST_NO_UPDATE=1 可跳过（调试/离线场景）。
    if (process.env.ONECAST_NO_UPDATE !== '1') await checkHtmlUpdate();
    createWindow();

    // 运行期间每 6 小时静默刷新一次缓存，下次打开自动生效（不打扰用户）。
    setInterval(() => { checkHtmlUpdate(); }, 6 * 60 * 60 * 1000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
