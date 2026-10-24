const { app, BrowserWindow, Menu, shell, net, dialog } = require('electron');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

// ---------- HTML 热更新（ed25519 验签）----------
// 公钥用于校验从 GitHub 拉取的 onecast.html，私钥仅在构建机上用于签名。
// 若签名不匹配，本次更新会被丢弃，继续使用本地缓存或打包内置版本。
const UPDATE_PUB_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEADsRl+0lt+kVjE7HWE9YNjvC2sGnkLRD1EX/okXiJR5w=
-----END PUBLIC KEY-----`;

const HTML_REMOTE =
  'https://raw.githubusercontent.com/lssqian777-source/132465/main/onecast-desktop/src/onecast.html';
const SIG_REMOTE =
  'https://raw.githubusercontent.com/lssqian777-source/132465/main/onecast-desktop/src/onecast.html.sig';
const RELEASES_URL = 'https://github.com/lssqian777-source/132465/releases';

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

async function checkHtmlUpdate() {
  try {
    const [htmlRes, sigRes] = await Promise.all([
      net.fetch(HTML_REMOTE, { signal: AbortSignal.timeout(15000) }),
      net.fetch(SIG_REMOTE, { signal: AbortSignal.timeout(15000) })
    ]);
    if (!htmlRes.ok || !sigRes.ok) return false;

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

function promptRestart(reason) {
  const win = BrowserWindow.getAllWindows()[0];
  const msg =
    reason === 'shell'
      ? 'OneCast 主程序有新版本，请到 Releases 页面下载安装包。'
      : '已检测到界面更新，重启后生效。是否立即重启？';
  const opts = {
    type: 'info',
    title: 'OneCast 更新',
    message: msg,
    buttons: reason === 'shell' ? ['去下载', '稍后'] : ['立即重启', '稍后'],
    defaultId: 0
  };
  (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)).then(
    ({ response }) => {
      if (reason === 'shell') {
        if (response === 0) shell.openExternal(RELEASES_URL);
      } else if (response === 0) {
        app.relaunch();
        app.exit(0);
      }
    }
  );
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
    // 启动时拉取最新界面，更新成功则提示重启生效
    const updated = await checkHtmlUpdate();
    createWindow();
    if (updated) setTimeout(() => promptRestart('html'), 1500);

    // 运行期间每 6 小时检查一次
    setInterval(async () => {
      if (await checkHtmlUpdate()) promptRestart('html');
    }, 6 * 60 * 60 * 1000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
