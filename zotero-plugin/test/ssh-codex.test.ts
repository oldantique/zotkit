import { describe, expect, it } from "vitest";
import { ASKPASS_SCRIPT, buildSshLaunch, type SshCodexProfile } from "../src/ssh-codex";
import { buildAdditionalContext } from "../src/codex-service";

const base: SshCodexProfile = {
  id: "s1",
  name: "lab box",
  host: "lab.example.edu",
  port: 22,
  user: "eric",
  auth: "key",
  keyPath: "/Users/eric/.ssh/id_ed25519",
  remoteCodexPath: "/home/eric/.local/bin/codex",
};

describe("buildSshLaunch", () => {
  it("builds key-auth argv with BatchMode and identity file", () => {
    const launch = buildSshLaunch(base, null);
    expect(launch.argv).toEqual([
      "ssh", "-T", "-p", "22", "-o", "StrictHostKeyChecking=yes",
      "-o", "BatchMode=yes", "-i", "/Users/eric/.ssh/id_ed25519",
      "eric@lab.example.edu", "--",
      "/home/eric/.local/bin/codex", "app-server", "--stdio",
    ]);
    expect(launch.env).toEqual({ NO_COLOR: "1" });
  });

  it("builds password-auth env without embedding the password", () => {
    const launch = buildSshLaunch({ ...base, auth: "password", keyPath: undefined }, "/profile/zotkit-askpass.sh");
    expect(launch.argv).not.toContain("BatchMode=yes");
    expect(launch.env.SSH_ASKPASS).toBe("/profile/zotkit-askpass.sh");
    expect(launch.env.SSH_ASKPASS_REQUIRE).toBe("force");
    expect(JSON.stringify(launch)).not.toContain("password");
    expect(launch.env.ZOTKIT_SSH_PASSWORD).toBeUndefined();
  });

  it("askpass script echoes the env password", () => {
    expect(ASKPASS_SCRIPT).toContain("ZOTKIT_SSH_PASSWORD");
    expect(ASKPASS_SCRIPT.startsWith("#!/bin/sh")).toBe(true);
  });
});

describe("remote additional context", () => {
  const context = {
    attachment: { key: "A", libraryID: 1, title: "T", filename: "t.pdf", creators: [], tags: [] },
    parent: null,
    pdfPath: "/papers/t.pdf",
    page: { pageIndex: 0, pageNumber: 1, pageLabel: "1", text: "x", source: "pdfjs", warnings: [] },
    selection: null,
    warnings: [],
  } as never;

  it("omits local paths when includeLocalPaths is false", () => {
    const local = buildAdditionalContext(context, {}, { includeLocalPaths: true });
    const remote = buildAdditionalContext(context, {}, { includeLocalPaths: false });
    expect(JSON.stringify(local)).toContain("PDF path");
    expect(JSON.stringify(remote)).not.toContain("PDF path");
    expect(JSON.stringify(remote)).not.toContain("PDF directory");
  });
});
