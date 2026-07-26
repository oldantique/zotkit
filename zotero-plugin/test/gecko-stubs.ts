/** Minimal Gecko globals for tests that touch prefs, uuids or profile paths. */
const prefsStore = new Map<string, string>();

export function installGeckoStubs(): void {
  const globals = globalThis as Record<string, any>;
  globals.Services = {
    ...globals.Services,
    prefs: {
      getStringPref: (name: string, fallback = "") => prefsStore.get(name) ?? fallback,
      setStringPref: (name: string, value: string) => { prefsStore.set(name, value); },
      getIntPref: (_name: string, fallback: number) => fallback,
      getBoolPref: (_name: string, fallback: boolean) => fallback,
      setIntPref: () => {},
    },
    uuid: globals.Services?.uuid ?? {
      generateUUID: () => `{${Math.random().toString(16).slice(2)}0000000000}`,
    },
  };
  globals.PathUtils = globals.PathUtils ?? { join: (...parts: string[]) => parts.join("/") };
  globals.Zotero = globals.Zotero ?? { Profile: { dir: "/profile" } };
}
