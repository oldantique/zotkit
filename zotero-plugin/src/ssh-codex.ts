import { prefString, setPrefString } from "./platform";

export interface SshCodexProfile {
  id: string;
  name: string;
  host: string;
  port: number;             // 默认 22
  user: string;
  auth: "key" | "password";
  keyPath?: string;         // auth === "key" 时可选(留空 = 用 ssh-agent/默认密钥)
  remoteCodexPath: string;  // 默认 "codex";远程命令不经 login shell,PATH 不全时需绝对路径
}

export interface SshLaunch {
  argv: string[];
  env: Record<string, string>;
}

export const ASKPASS_SCRIPT = "#!/bin/sh\nprintf '%s\\n' \"$ZOTKIT_SSH_PASSWORD\"\n";

export function loadSshProfiles(): SshCodexProfile[] {
  try {
    const parsed = JSON.parse(prefString("sshProfiles", "[]")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSshProfile);
  }
  catch {
    return [];
  }
}

export function saveSshProfiles(profiles: SshCodexProfile[]): void {
  setPrefString("sshProfiles", JSON.stringify(profiles));
}

export function sshSecretRealm(profileId: string): string {
  return `zotkit-ssh:${profileId}`;
}

/**
 * Builds the ssh argv/env that pipes a remote `codex app-server --stdio`
 * through the native helper's spawnPipe. The password itself never appears
 * here: the service merges it into env as ZOTKIT_SSH_PASSWORD after reading
 * the Login Manager secret.
 */
export function buildSshLaunch(profile: SshCodexProfile, askpassPath: string | null): SshLaunch {
  const argv = ["ssh", "-T", "-p", String(profile.port || 22), "-o", "StrictHostKeyChecking=yes"];
  const env: Record<string, string> = { NO_COLOR: "1" };
  if (profile.auth === "key") {
    argv.push("-o", "BatchMode=yes");
    if (profile.keyPath) argv.push("-i", profile.keyPath);
  }
  else {
    if (askpassPath) env.SSH_ASKPASS = askpassPath;
    env.SSH_ASKPASS_REQUIRE = "force";
    env.DISPLAY = ":0";
  }
  argv.push(
    `${profile.user}@${profile.host}`,
    "--",
    profile.remoteCodexPath || "codex",
    "app-server",
    "--stdio",
  );
  return { argv, env };
}

function isSshProfile(value: unknown): value is SshCodexProfile {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && typeof record.name === "string"
    && typeof record.host === "string"
    && typeof record.user === "string"
    && (record.auth === "key" || record.auth === "password")
    && typeof record.remoteCodexPath === "string";
}
