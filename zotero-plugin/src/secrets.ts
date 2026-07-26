/**
 * Secret storage backed by the Zotero (Gecko) Login Manager. Secrets never
 * touch prefs or logs. Outside Gecko (vitest) an in-memory map keeps the
 * call sites testable; the real branch is covered by the macOS smoke pass.
 */
const LOGIN_ORIGIN = "chrome://zotkit";
const memoryFallback = new Map<string, string>();

function memoryKey(realm: string, username: string): string {
  return `${realm}|${username}`;
}

function loginsApi(): any | null {
  if (typeof Components === "undefined") return null;
  try {
    return (globalThis as { Services?: { logins?: unknown } }).Services?.logins ?? null;
  }
  catch {
    return null;
  }
}

async function findLogin(api: any, realm: string, username: string): Promise<any | null> {
  const logins = await api.searchLoginsAsync({ origin: LOGIN_ORIGIN, httpRealm: realm });
  for (const login of logins) {
    if (login.username === username) return login;
  }
  return null;
}

export async function saveSecret(realm: string, username: string, secret: string): Promise<void> {
  const api = loginsApi();
  if (!api) {
    memoryFallback.set(memoryKey(realm, username), secret);
    return;
  }
  const existing = await findLogin(api, realm, username);
  if (existing) api.removeLogin(existing);
  const info = Components.classes["@mozilla.org/login-manager/loginInfo;1"]
    .createInstance(Components.interfaces.nsILoginInfo);
  info.init(LOGIN_ORIGIN, null, realm, username, secret, "", "");
  await api.addLoginAsync(info);
}

export async function readSecret(realm: string, username: string): Promise<string | null> {
  const api = loginsApi();
  if (!api) return memoryFallback.get(memoryKey(realm, username)) ?? null;
  const login = await findLogin(api, realm, username);
  return login ? String(login.password) : null;
}

export async function deleteSecret(realm: string, username: string): Promise<void> {
  const api = loginsApi();
  if (!api) {
    memoryFallback.delete(memoryKey(realm, username));
    return;
  }
  const login = await findLogin(api, realm, username);
  if (login) api.removeLogin(login);
}

export function maskSecret(secret: string): string {
  return `····${secret.slice(-4)}`;
}
