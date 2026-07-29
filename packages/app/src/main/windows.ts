import { BrowserWindow, screen, shell } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { unionBounds } from './displays.js';

const isDev = !!process.env['ELECTRON_RENDERER_URL'];

/**
 * electron-vite emits the preload as `.mjs` for an ESM package and `.js`
 * otherwise. Resolve whichever exists rather than hard-coding one.
 *
 * This is worth being careful about: Electron does not fail loudly when a
 * preload path is wrong. The window simply loads without it, `window.eyeTracker`
 * is undefined, and the renderer dies with a confusing unrelated error.
 */
function preloadPath(): string {
  const base = join(__dirname, '../preload/index');
  for (const ext of ['.mjs', '.js', '.cjs']) {
    if (existsSync(base + ext)) return base + ext;
  }
  console.error(
    `[windows] no preload script found at ${base}.{mjs,js,cjs} — the renderer will have no API`,
  );
  return `${base}.mjs`;
}

function rendererEntry(page: 'index' | 'overlay'): { url?: string; file?: string } {
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) return { url: `${devUrl}/${page}.html` };
  return { file: join(__dirname, `../renderer/${page}.html`) };
}

function load(win: BrowserWindow, page: 'index' | 'overlay'): void {
  const entry = rendererEntry(page);
  if (entry.url) void win.loadURL(entry.url);
  else if (entry.file) void win.loadFile(entry.file);
}

export function createControlWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 860,
    minHeight: 620,
    title: 'Eye Tracker',
    backgroundColor: '#0d1117',
    show: false,
    webPreferences: {
      preload: preloadPath(),
      // The camera-facing renderer gets no Node and no direct access to the
      // native addon (ADR-0002).
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      // This window owns the camera loop, and the calibration overlay covers it
      // completely the moment a run starts. Chromium treats a fully-occluded
      // window as backgrounded and stops servicing its rendering steps — which
      // is what drives `requestVideoFrameCallback`. The result was a run that
      // collected exactly one frame and then nothing, with the overlay
      // advancing on its own timers as though all were well.
      backgroundThrottling: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // Never let the app navigate away or spawn windows — it loads only local
  // content and has a camera handle.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  load(win, 'index');
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  return win;
}

/**
 * Transparent, click-through, always-on-top crosshair layer (ADR-0002).
 *
 * The window flags here are the most platform-fragile part of the project:
 * they are what let the overlay float above full-screen apps and Spaces
 * without ever intercepting a click.
 */
export function createOverlayWindow(): BrowserWindow {
  const bounds = unionBounds();

  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Non-focusable so it never steals keyboard focus from the app underneath.
    focusable: false,
    show: false,
    // 'panel' is what allows floating above full-screen apps on macOS.
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The overlay draws the calibration dot and the crosshair; throttling it
      // would stutter the very thing the user is asked to fixate.
      backgroundThrottling: false,
    },
  });

  // The crucial flag: pointer events pass straight through to whatever is
  // underneath, so the app never eats the clicks it is synthesizing.
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.once('ready-to-show', () => {
    win.showInactive();
  });

  load(win, 'overlay');
  return win;
}

/** Keep the overlay covering the whole desktop when displays change. */
export function resizeOverlay(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  const b = unionBounds();
  win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
}

export function focusedDisplayScale(): number {
  return screen.getPrimaryDisplay().scaleFactor;
}
