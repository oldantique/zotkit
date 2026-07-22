/* global APP_SHUTDOWN, Zotero, Services, Components, ChromeUtils, IOUtils, PathUtils */

var chromeHandle = null;
var runtimeScope = null;
var startupData = null;

function install() {}

async function startup(data) {
  startupData = data;
  await Zotero.initializationPromise;

  const aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  const manifestURI = Services.io.newURI(data.rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "zotkit", data.rootURI + "chrome/content/"],
    ["locale", "zotkit", "en-US", data.rootURI + "locale/en-US/"],
    ["locale", "zotkit", "zh-CN", data.rootURI + "locale/zh-CN/"]
  ]);

  let mainWindow = Zotero.getMainWindow();
  if (!mainWindow && Zotero.uiReadyPromise) {
    await Zotero.uiReadyPromise;
    mainWindow = Zotero.getMainWindow();
  }
  if (!mainWindow) {
    throw new Error("Zotkit requires a Zotero main window");
  }
  const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
  runtimeScope = {
    Zotero,
    Services,
    Components,
    ChromeUtils,
    IOUtils,
    PathUtils,
    NetUtil,
    window: mainWindow,
    self: mainWindow,
    document: mainWindow.document,
    navigator: mainWindow.navigator,
    performance: mainWindow.performance,
    console: mainWindow.console || console,
    setTimeout: mainWindow.setTimeout.bind(mainWindow),
    clearTimeout: mainWindow.clearTimeout.bind(mainWindow),
    setInterval: mainWindow.setInterval.bind(mainWindow),
    clearInterval: mainWindow.clearInterval.bind(mainWindow),
    requestAnimationFrame: mainWindow.requestAnimationFrame.bind(mainWindow),
    cancelAnimationFrame: mainWindow.cancelAnimationFrame.bind(mainWindow),
    requestIdleCallback: mainWindow.requestIdleCallback.bind(mainWindow),
    cancelIdleCallback: mainWindow.cancelIdleCallback.bind(mainWindow),
    queueMicrotask: mainWindow.queueMicrotask.bind(mainWindow),
    getComputedStyle: mainWindow.getComputedStyle.bind(mainWindow),
    TextEncoder: mainWindow.TextEncoder,
    TextDecoder: mainWindow.TextDecoder,
    btoa: mainWindow.btoa.bind(mainWindow),
    atob: mainWindow.atob.bind(mainWindow),
    URL: mainWindow.URL,
    URLSearchParams: mainWindow.URLSearchParams,
    WebSocket: mainWindow.WebSocket,
    fetch: mainWindow.fetch.bind(mainWindow),
    rootURI: data.rootURI
  };
  // xterm.js is evaluated in this object rather than a normal Window global.
  // Copy the DOM constructors it references as bare globals so module
  // initialization and later terminal interaction both run in Zotero's realm.
  for (const name of [
    "AbortController",
    "AbortSignal",
    "Blob",
    "CSS",
    "CustomEvent",
    "Document",
    "DOMParser",
    "Element",
    "Event",
    "EventTarget",
    "File",
    "FileReader",
    "HTMLElement",
    "HTMLCanvasElement",
    "HTMLTextAreaElement",
    "KeyboardEvent",
    "MouseEvent",
    "MutationObserver",
    "Node",
    "NodeFilter",
    "PointerEvent",
    "Range",
    "ResizeObserver",
    "Selection",
    "WheelEvent",
    "XMLHttpRequest",
    "XMLSerializer"
  ]) {
    if (mainWindow[name] !== undefined) {
      runtimeScope[name] = mainWindow[name];
    }
  }
  runtimeScope._globalThis = runtimeScope;

  Services.scriptloader.loadSubScript(
    data.rootURI + "chrome/content/zoterochat.js",
    runtimeScope
  );
  runtimeScope.ZoteroChatRuntime = runtimeScope.ZoteroChatRuntime
    || runtimeScope.ZoteroChatBundle?.ZoteroChatRuntime;
  if (!runtimeScope.ZoteroChatRuntime) {
    throw new Error("Zotkit runtime did not load");
  }
  await runtimeScope.ZoteroChatRuntime.startup({
    id: data.id,
    version: data.version,
    rootURI: data.rootURI
  });
}

async function onMainWindowLoad({ window }) {
  if (runtimeScope && runtimeScope.ZoteroChatRuntime) {
    await runtimeScope.ZoteroChatRuntime.onMainWindowLoad(window);
  }
}

async function onMainWindowUnload({ window }) {
  if (runtimeScope && runtimeScope.ZoteroChatRuntime) {
    await runtimeScope.ZoteroChatRuntime.onMainWindowUnload(window);
  }
}

async function shutdown(data, reason) {
  if (runtimeScope && runtimeScope.ZoteroChatRuntime) {
    try {
      await runtimeScope.ZoteroChatRuntime.shutdown({ appShutdown: reason === APP_SHUTDOWN });
    }
    catch (error) {
      Zotero.logError(error);
    }
  }
  runtimeScope = null;
  startupData = null;

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function uninstall() {}
