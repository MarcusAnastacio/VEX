// Electron main process.
//
// Startup order matters and is deliberate:
//   1. import the backend (ESM) via dynamic import  <- must finish before IPC exists
//   2. register the IPC handlers
//   3. create the window
//   4. kick off the scan and stream progress to the renderer
//
// This file is CommonJS (the folder has no "type": "module"), which is why the
// backend is loaded with `await import(...)` rather than `require(...)`. The
// backend folder has its own package.json marking it ESM; Electron's bundled Node
// does not reliably support require()-of-ESM, so dynamic import is the safe path.

const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, shell, protocol, net } = require('electron');

/**
 * Load a .env into process.env at startup.
 *
 * Kept from the frontend branch. lib/gemini.js reads a .env itself, so this is not
 * required for generation — but it means `hasApiKey()` is accurate as soon as the window
 * opens, which is what the settings UI needs to decide whether to ask for a key.
 * Existing environment variables always win.
 */
function loadLocalEnv() {
  for (const file of [path.join(__dirname, '.env'), path.join(__dirname, '..', '.env')]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  }
}

const FIXTURES = process.env.COMPAT_FIXTURES === '1';

const FRONTEND_DIR = path.join(__dirname, 'frontend');

// The frontend is served from a custom `app://` scheme instead of `file://`.
//
// Why this is necessary rather than cosmetic: a `file://` page has a null origin,
// so the CSP directive `script-src 'self'` matches nothing and Chromium refuses
// every ES module import — silently. The module never runs and no error appears
// in the UI, which is a genuinely hard failure to debug. Serving from a real
// origin makes `'self'` meaningful, so `type="module"` works while the CSP stays
// strict. It also gives components a stable base for relative imports.
//
// `registerSchemesAsPrivileged` must run before the app is ready.
const APP_SCHEME = 'app';
const APP_ORIGIN = `${APP_SCHEME}://bundle`;

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,   // gives it an origin, which is the whole point
      secure: true,     // treated as a secure context
      supportFetchAPI: true,
    },
  },
]);

/** @type {import('./backend/index.js').CompatibilityLayer | null} */
let layer = null;
let mainWindow = null;

function loadLocalEnv() {
  for (const file of [path.join(__dirname, '.env'), path.join(__dirname, '..', '.env')]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  }
}

async function bootstrap() {
  loadLocalEnv();
  // 1. backend
  const { CompatibilityLayer } = await import('./backend/index.js');
  const { registerCompatibilityIpc } = await import('./backend/ipc.js');

  layer = new CompatibilityLayer();

  // 2. IPC — registered before any window exists, so the renderer can never
  //    invoke a channel that is not wired yet.
  registerCompatibilityIpc({
    ipcMain,
    layer,
    getWindows: () => BrowserWindow.getAllWindows(),
  });

  // Serve frontend/ over app://. Anything outside the directory is refused so a
  // malformed URL cannot walk up into the rest of the app or the user's disk.
  protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url);
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const target = path.normalize(path.join(FRONTEND_DIR, relative));

    if (!target.startsWith(FRONTEND_DIR + path.sep) && target !== FRONTEND_DIR) {
      return new Response('Forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(target).toString());
  });

  // 3. window
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#12141a',
    title: 'Agent Quiz',
    // Created hidden, then shown with showInactive() below, so launching the app does not
    // pull focus away from whatever the user is actually typing in.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  await mainWindow.loadURL(`${APP_ORIGIN}/index.html`);

  // Shown but not activated: the window appears where it would have anyway, without
  // stealing focus. Deliberately after loadURL so it never flashes an empty frame.
  //
  // This matters most for the screenshot harness below, which is run constantly by
  // agents: without it, every verification capture would yank the window to the front
  // and interrupt whoever is working in another app.
  mainWindow.showInactive();

  if (process.env.COMPAT_DEVTOOLS === '1') mainWindow.webContents.openDevTools();

  // Headless verification: COMPAT_SCREENSHOT=/tmp/out.png renders the window to a
  // PNG and exits. Used to check the UI in CI or from a terminal without a display.
  //
  // COMPAT_DRIVE=/path/to/drive.js additionally drives the UI before capturing, so the
  // quiz and results screens are reachable without a human clicking. The drive file runs
  // IN THE RENDERER and must evaluate to an array of stages:
  //
  //     [{ name: '02-quiz', code: "document.querySelector('#generate').click()" }]
  //
  // Each stage's `code` runs, then the window is captured to `<shot>-<name>.png`. Stage
  // code may return a promise, which is awaited. A stage with `code: null` just captures
  // the current state.
  //
  // Why this exists: an agent asked to make a screen look better cannot judge its own work
  // without seeing the screen. Before this, only the initial empty state was reachable, so
  // visual work had to be reviewed by hand. This is the feedback loop that makes the
  // visual layer delegable.
  const shotPath = process.env.COMPAT_SCREENSHOT;
  if (shotPath) {
    const drivePath = process.env.COMPAT_DRIVE;
    const waitMs = Number(process.env.COMPAT_SCREENSHOT_DELAY || 4000);

    // A hard deadline, always. A drive script that throws must still exit the process,
    // otherwise the run looks like a hang rather than a failed assertion.
    const hardExit = setTimeout(() => {
      console.error('[screenshot] hard timeout, exiting');
      app.exit(1);
    }, waitMs + 60_000);

    setTimeout(async () => {
      try {
        let stages = [{ name: '', code: null }];
        if (drivePath) {
          const source = fs.readFileSync(drivePath, 'utf8');
          stages = await mainWindow.webContents.executeJavaScript(source, true);
          if (!Array.isArray(stages)) throw new Error(`drive file ${drivePath} did not return an array of stages`);
          console.log(`[screenshot] ${stages.length} stage(s) from ${drivePath}`);
        }

        for (const stage of stages) {
          if (stage.code) await mainWindow.webContents.executeJavaScript(stage.code, true);
          const image = await mainWindow.webContents.capturePage();
          const out = stage.name ? shotPath.replace(/\.png$/, `-${stage.name}.png`) : shotPath;
          fs.writeFileSync(out, image.toPNG());
          console.log(`[screenshot] wrote ${out}`);
        }
      } catch (err) {
        console.error('[screenshot] failed:', err?.message || err);
      }
      clearTimeout(hardExit);
      app.exit(0);
    }, waitMs);
  }

  // 4. scan, streaming progress. The renderer also calls refresh() on mount; the
  //    layer de-duplicates concurrent scans, so this is safe either way.
  mainWindow.webContents.once('did-finish-load', () => {
    layer.refresh({ fixtures: FIXTURES }).catch((err) => {
      console.error('[compat] scan failed:', err);
    });
  });
}

app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) bootstrap();
});

// External links open in the real browser, never inside the app.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
});
