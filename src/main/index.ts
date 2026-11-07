import { app, BrowserWindow, Menu, protocol, session } from "electron";
import { mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import { resolveReaderDataRoot } from "./data-root-location.js";
import { createServices } from "./bootstrap/services.js";
import { registerIpc } from "./ipc/register-ipc.js";
import { createPublicationResponse } from "./protocols/publication-protocol.js";
import { createBundleResponse } from "./protocols/bundle-protocol.js";
import { coverThumbnailer } from "./covers/cover-thumbnail.js";
import { backfillCoverThumbnails } from "../backend/library/cover-thumbnail-backfill.js";

protocol.registerSchemesAsPrivileged([
  { scheme: "reader-app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: "reader-resource", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: "reader-rendition", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

let services: ReturnType<typeof createServices> | undefined;
let shutdownStarted = false;
let shutdownComplete = false;
let mainWindow: BrowserWindow | undefined;

const dataRoot = resolveReaderDataRoot(app.getPath("userData"), process.env.READER_DATA_ROOT);
mkdirSync(dataRoot, { recursive: true });
app.setPath("userData", dataRoot);
process.env.READER_DATA_ROOT = dataRoot;

function createWindow() {
  const devUrl = getTrustedDevelopmentUrl();
  const applicationUrl = devUrl ?? "reader-app://bundle/index.html";
  const window = new BrowserWindow({
    title: "Aetherbound",
    icon: app.isPackaged ? process.execPath : join(app.getAppPath(), "build", "reader-icon-v2.ico"),
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#10213a",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#10213a", symbolColor: "#c7ecff", height: 34 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
    },
  });
  window.setMenu(null);
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F11") {
      event.preventDefault();
      window.setFullScreen(!window.isFullScreen());
    } else if (input.control && ["+", "=", "-", "0"].includes(input.key)) {
      event.preventDefault();
      const current = window.webContents.getZoomLevel();
      window.webContents.setZoomLevel(input.key === "0" ? 0 : Math.max(-3, Math.min(3, current + (input.key === "-" ? -0.5 : 0.5))));
    }
  });
  mainWindow = window;
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (targetUrl !== applicationUrl && !targetUrl.startsWith(`${applicationUrl}#`)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, targetUrl) => {
    if (targetUrl !== applicationUrl && !targetUrl.startsWith(`${applicationUrl}#`)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.once("ready-to-show", () => window.show());
  void window.loadURL(applicationUrl);
}

function getTrustedDevelopmentUrl() {
  if (app.isPackaged || !process.env.ELECTRON_RENDERER_URL) return undefined;
  const url = new URL(process.env.ELECTRON_RENDERER_URL);
  if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("ELECTRON_RENDERER_URL must use a loopback HTTP origin.");
  }
  return url.href;
}

function isAllowedNetworkRequest(targetUrl: string, devUrl: string | undefined) {
  if (!devUrl) return false;
  try {
    const target = new URL(targetUrl);
    const trusted = new URL(devUrl);
    return target.host === trusted.host && ["http:", "https:", "ws:", "wss:"].includes(target.protocol);
  } catch {
    return false;
  }
}

async function startApplication() {
  Menu.setApplicationMenu(null);
  if (process.platform === "win32") app.setAppUserModelId("io.github.xuyouquan856-beep.aetherbound");
  services = createServices();
  const rendererRoot = join(__dirname, "../renderer");
  protocol.handle("reader-app", (request) => createBundleResponse(request, rendererRoot, "reader-app"));
  protocol.handle("reader-rendition", (request) => createBundleResponse(request, rendererRoot, "reader-rendition"));
  protocol.handle("reader-resource", (request) => createPublicationResponse(
    request,
    (bookId, sourceRevision, resource) =>
      services?.library.getPreparedPublicationPath(bookId, sourceRevision, resource) ?? null,
  ));
  const devUrl = getTrustedDevelopmentUrl();
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (details, callback) => {
    callback({ cancel: !isAllowedNetworkRequest(details.url, devUrl) });
  });
  services.sessions.recoverStaleSessions(60_000);
  if (!app.isPackaged && process.env.READER_E2E === "1" && process.env.READER_E2E_IMPORT_PATH) {
    if (extname(process.env.READER_E2E_IMPORT_PATH).toLowerCase() === ".epub") await services.library.importEpub(process.env.READER_E2E_IMPORT_PATH);
    else await services.library.importTxt(process.env.READER_E2E_IMPORT_PATH);
  }
  services.preparations.start();
  registerIpc(services);
  createWindow();
  // One-time upgrade for libraries prepared before cover thumbnails existed.
  // Runs after the window is up and never blocks startup.
  void backfillCoverThumbnails({
    db: services.db.db,
    dataRoot: services.db.dataRoot,
    createCoverThumbnail: coverThumbnailer,
  })
    .then((created) => {
      // Cover URLs may have moved from /cover to /cover-thumb.
      if (created > 0) services?.library.resetCoverCache();
    })
    .catch(() => undefined);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

// Database migrations run before the window opens. A second launch must not
// contend for the same database or leave another invisible Electron process.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  void app.whenReady().then(startApplication);
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (shutdownComplete || !services) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  const activeServices = services;
  void activeServices.preparations.stop().finally(() => {
    activeServices.db.close();
    services = undefined;
    shutdownComplete = true;
    app.quit();
  });
});
