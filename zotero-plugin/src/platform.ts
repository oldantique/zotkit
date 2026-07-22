export const PLUGIN_ID = "zotkit@oldantique.github.io";
export const PANE_ID = "zotkit-pane";
export const PREF_BRANCH = "extensions.zotkit.";

export function debug(message: string, data?: unknown): void {
  const suffix = data === undefined ? "" : ` ${safeJSONStringify(data)}`;
  Zotero.debug(`[Zotkit] ${message}${suffix}`);
}

export function logError(error: unknown): void {
  const value = error instanceof Error ? error : new Error(String(error));
  Zotero.logError(value);
}

export function safeJSONStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  }
  catch {
    return String(value);
  }
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function randomID(prefix = "zc"): string {
  const uuid = String(Services.uuid.generateUUID()).replace(/[{}-]/g, "");
  return `${prefix}-${uuid}`;
}

export function prefString(name: string, fallback = ""): string {
  try {
    const value = Services.prefs.getStringPref(PREF_BRANCH + name, fallback);
    return typeof value === "string" ? value : fallback;
  }
  catch {
    return fallback;
  }
}

export function prefInt(name: string, fallback: number): number {
  try {
    return Services.prefs.getIntPref(PREF_BRANCH + name, fallback);
  }
  catch {
    return fallback;
  }
}

export function prefBool(name: string, fallback: boolean): boolean {
  try {
    return Services.prefs.getBoolPref(PREF_BRANCH + name, fallback);
  }
  catch {
    return fallback;
  }
}

export function setPrefString(name: string, value: string): void {
  Services.prefs.setStringPref(PREF_BRANCH + name, value);
}

export function setPrefInt(name: string, value: number): void {
  Services.prefs.setIntPref(PREF_BRANCH + name, Math.round(value));
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    return await IOUtils.exists(path);
  }
  catch {
    return false;
  }
}

export function makeLocalFile(path: string): any {
  const file = Components.classes["@mozilla.org/file/local;1"]
    .createInstance(Components.interfaces.nsIFile);
  file.initWithPath(path);
  return file;
}

export function homePath(...parts: string[]): string {
  const home = Services.dirsvc.get(
    "Home",
    Components.interfaces.nsIFile
  ).path;
  return PathUtils.join(home, ...parts);
}

export function profilePath(...parts: string[]): string {
  return PathUtils.join(Zotero.Profile.dir, "zotkit", ...parts);
}

export function configuredLibraryRoot(): string {
  return prefString("libraryRoot") || homePath("Documents", "chancezotero");
}

export async function findExecutable(name: "codex" | "claude"): Promise<string | null> {
  const override = prefString(`${name}Path`);
  const candidates = [
    override,
    homePath(".local", "bin", name),
    homePath(".npm-global", "bin", name),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

export function launchURL(url: string): void {
  if (!/^https:\/\//i.test(url)) throw new Error("Only HTTPS login URLs may be opened");
  Zotero.launchURL(url);
}
