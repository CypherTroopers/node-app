import path from "node:path";
import { app, BrowserWindow, dialog, Menu, shell } from "electron";
import { createCypherApp } from "../src/server/app.ts";
import { resolveStateDirectory } from "../src/state-directory.js";

const PRODUCT_NAME = "ColossusX Node Manager";
const EXPLORER_ORIGIN = "https://colossusx.make-cph-great-again.community";
const supported =
  (process.platform === "win32" && process.arch === "x64") ||
  (process.platform === "darwin" && process.arch === "arm64") ||
  (process.platform === "linux" && process.arch === "x64");

app.setName(PRODUCT_NAME);
app.setAppUserModelId("ai.cyphertroopers.colossusx-node-manager");

let mainWindow: BrowserWindow | undefined;
let service: ReturnType<typeof createCypherApp> | undefined;
let startup: Promise<void>;
let shutdown: Promise<void> | undefined;
let quitting = false;
let quitAllowed = false;

function isAppUrl(value: string, origin: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === origin && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function openExplorer(value: string): void {
  try {
    const url = new URL(value);
    if (
      url.origin !== EXPLORER_ORIGIN ||
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return;
    }
    void shell.openExternal(url.href).catch(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        void dialog.showMessageBox(mainWindow, {
          type: "error",
          title: PRODUCT_NAME,
          message: "The block explorer could not be opened.",
          detail: "Open the explorer in your browser and try again.",
        });
      }
    });
  } catch {
    // Only parsed HTTPS explorer URLs may reach the operating system's URL handler.
  }
}

function quit(): Promise<void> {
  if (shutdown) {
    return shutdown;
  }
  quitting = true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle(`${PRODUCT_NAME} — Stopping node…`);
  }
  shutdown = (async () => {
    await startup.catch(() => {});
    await service?.close();
    quitAllowed = true;
    app.quit();
  })().catch(async () => {
    shutdown = undefined;
    quitting = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle(PRODUCT_NAME);
      await dialog.showMessageBox(mainWindow, {
        type: "error",
        title: PRODUCT_NAME,
        message: "The node has not finished stopping.",
        detail:
          "Keep this application open and check the node process. After it stops, try closing the application again.",
      });
    } else {
      dialog.showErrorBox(
        PRODUCT_NAME,
        "The node has not finished stopping. Check its process before reopening the application.",
      );
    }
  });
  return shutdown;
}

async function start(): Promise<void> {
  await app.whenReady();
  if (!supported) {
    dialog.showErrorBox(
      PRODUCT_NAME,
      "This application supports Windows x64, macOS Apple silicon, and Linux x64 only.",
    );
    return;
  }
  if (quitting) {
    return;
  }
  const desktopData = app.getPath("userData");
  const defaultDesktopData = path.join(app.getPath("appData"), PRODUCT_NAME);
  const explicitStateDirectory =
    desktopData === defaultDesktopData ? undefined : path.join(desktopData, "runtime");
  const { stateDir, warning } = await resolveStateDirectory(explicitStateDirectory);
  if (warning) console.warn(warning);
  service = createCypherApp({
    packageRoot: app.getAppPath(),
    stateDir,
    windowsHostPath:
      process.platform === "win32"
        ? path.join(
            app.isPackaged
              ? path.join(process.resourcesPath, "app.asar.unpacked")
              : app.getAppPath(),
            "dist/windows-pty-host.js",
          )
        : undefined,
  });
  const { origin, bootstrapUrl } = await service.listen();
  if (quitting) {
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin"
        ? [
            {
              label: PRODUCT_NAME,
              submenu: [{ role: "about" as const }, { role: "quit" as const }],
            },
          ]
        : []),
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { role: "togglefullscreen" },
        ],
      },
      ...(process.platform === "darwin"
        ? []
        : [{ label: "File", submenu: [{ role: "quit" as const }] }]),
    ]),
  );
  const window = new BrowserWindow({
    title: PRODUCT_NAME,
    width: 1440,
    height: 1060,
    minWidth: 700,
    minHeight: 600,
    backgroundColor: "#0e1015",
    icon: path.join(app.getAppPath(), "assets/icon.png"),
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      navigateOnDragDrop: false,
    },
  });
  mainWindow = window;
  const contents = window.webContents;
  contents.session.setPermissionRequestHandler((requester, permission, callback, details) => {
    callback(
      requester === contents &&
        isAppUrl(details.requestingUrl, origin) &&
        permission === "clipboard-sanitized-write",
    );
  });
  contents.session.setPermissionCheckHandler(
    (requester, permission, requestingOrigin) =>
      requester === contents &&
      isAppUrl(requestingOrigin, origin) &&
      permission === "clipboard-sanitized-write",
  );
  contents.setWindowOpenHandler(({ url }) => {
    openExplorer(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url, origin)) {
      event.preventDefault();
      openExplorer(url);
    }
  });
  contents.on("will-redirect", (event, url) => {
    if (!isAppUrl(url, origin)) {
      event.preventDefault();
    }
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.session.on("will-download", (event) => event.preventDefault());
  window.on("close", (event) => {
    if (!quitAllowed) {
      event.preventDefault();
      void quit();
    }
  });
  window.on("closed", () => {
    mainWindow = undefined;
  });
  await window.loadURL(bootstrapUrl);
  if (!quitting) {
    window.show();
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.on("before-quit", (event) => {
    if (!quitAllowed) {
      event.preventDefault();
      void quit();
    }
  });
  app.on("window-all-closed", () => {
    void quit();
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void quit());
  }
  startup = start();
  void startup.then(
    () => {
      if (!supported) {
        void quit();
      }
    },
    () => {
      dialog.showErrorBox(
        PRODUCT_NAME,
        "The local management service could not start. Close the application and try again.",
      );
      void quit();
    },
  );
}
