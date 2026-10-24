const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

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

  win.loadFile(path.join(__dirname, 'src', 'onecast.html'));
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

  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
