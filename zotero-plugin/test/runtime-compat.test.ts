import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const projectFile = (path: string): string => readFileSync(join(process.cwd(), path), "utf8");

describe("Zotero 9 runtime compatibility", () => {
  it("uses a standalone Zotkit add-on identity and namespace", () => {
    const manifest = JSON.parse(projectFile("manifest.json"));
    const platform = projectFile("src/platform.ts");
    const bootstrap = projectFile("bootstrap.js");

    expect(manifest.applications.zotero.id).toBe("zotkit@oldantique.github.io");
    expect(platform).toContain('PLUGIN_ID = "zotkit@oldantique.github.io"');
    expect(platform).toContain('PREF_BRANCH = "extensions.zotkit."');
    expect(platform).toContain('Zotero.Profile.dir, "zotkit"');
    expect(projectFile("src/plugin.ts")).toContain('pluginDirectoryName: "zotkit"');
    expect(bootstrap).toContain('["content", "zotkit"');
    expect(manifest.applications.zotero.id).not.toContain("zoterochat");
  });

  it("provides the Window globals required by xterm's browser bundle", () => {
    const bootstrap = projectFile("bootstrap.js");
    for (const name of [
      "window: mainWindow",
      "navigator: mainWindow.navigator",
      "performance: mainWindow.performance",
      "requestIdleCallback: mainWindow.requestIdleCallback.bind(mainWindow)",
      '"Element"',
      '"Document"',
      '"MutationObserver"',
    ]) {
      expect(bootstrap).toContain(name);
    }
  });

  it("uses Gecko IOUtils.write and the Zotero 9 custom section element", () => {
    const bridge = projectFile("src/native-bridge.ts");
    const plugin = projectFile("src/plugin.ts");

    expect(bridge).toContain("IOUtils.write(target, bytes");
    expect(bridge).not.toContain("IOUtils.writeAtomic");
    expect(plugin).toContain("item-pane-custom-section");
    expect(plugin).toContain("this.registeredPaneID = paneID");
    expect(plugin).toContain("candidate.dataset?.pane === paneID");
    expect(plugin).toContain('type: "zotkit-focus-terminal"');
    expect(plugin).toContain('icon: "chrome://zotkit/content/icons/terminal.svg"');
    expect(plugin).toContain('icon: "chrome://zotkit/content/icons/icon16.svg"');
    expect(plugin).toContain('icon: "chrome://zotkit/content/icons/icon20.svg"');
    expect(projectFile("src/terminal-panel.ts")).toContain('host.classList.add("zc-pane-host")');
    expect(projectFile("src/terminal-panel.ts")).not.toContain('"/bin/zsh"');
    expect(projectFile("src/settings.ts")).not.toContain('"shell"');
    expect(plugin).not.toContain("onInit:");
    expect(plugin.indexOf("this.onMainWindowLoad(win)")).toBeLessThan(
      plugin.indexOf("this.registerSection()"),
    );
  });

  it("uses a private Unix-domain socket instead of an impersonable TCP port", () => {
    const bridge = projectFile("src/native-bridge.ts");
    const helper = projectFile("native/src/zoterochat_helper.c");

    expect(bridge).toContain("createUnixDomainTransport");
    expect(bridge).toContain('profilePath("run")');
    expect(bridge).toContain('["0700", directory]');
    expect(bridge).toContain('"--socket"');
    expect(bridge).not.toContain("127.0.0.1");
    expect(bridge).not.toContain("Math.random()");
    expect(bridge).not.toContain("new WebSocket(");
    expect(bridge).toContain("X-Zotkit-Client-Proof");
    expect(bridge).toContain("x-zotkit-server-proof");
    expect(bridge).not.toContain("X-ZoteroChat-Token");
    expect(bridge).not.toContain("?token=");
    expect(helper).toContain("socket(AF_UNIX, SOCK_STREAM, 0)");
    expect(helper).toContain("getpeereid(fd, &peer_uid, &peer_gid)");
    expect(helper).toContain("peer_uid != geteuid()");
    expect(helper).toContain('hmac_sha1_base64(token, "client:", key)');
    expect(helper).toContain('hmac_sha1_base64(token, "server:", key)');
    expect(helper).not.toContain("socket(AF_INET, SOCK_STREAM, 0)");
  });

  it("does not start Codex or extract Reader context during plugin startup", () => {
    const plugin = projectFile("src/plugin.ts");
    const terminal = projectFile("src/terminal-panel.ts");
    const startup = plugin.slice(
      plugin.indexOf("async startup("),
      plugin.indexOf("async shutdown("),
    );
    expect(startup).not.toContain("this.bridge.start(");
    expect(startup).not.toContain("this.terminal.open(");
    expect(startup).not.toContain("this.refreshContext(");
    expect(plugin).toContain("this.openTerminal(body)");
    expect(plugin).toContain("refreshForPageChange()");
    expect(plugin).toContain('["file", "tab"]');
    expect(plugin).toContain('["select", "load"].includes(event)');
    expect(plugin).toContain("refreshSelectedReaderTab(tabID, isReader, attempt)");
    expect(plugin).toContain('closest("item-details")?.getAttribute("data-tab-id")');
    expect(plugin).toContain("this.terminal.hasLiveSessions");
    expect(plugin).toContain('body.closest("collapsible-section")?.hasAttribute("open")');
    expect(plugin).toContain("!this.hasOpenSidebar()");
    expect(terminal).toContain(
      "IOUtils.setPermissions?.(mcpConfigPath, 0o600, false)",
    );
    expect(terminal).toContain('"--sandbox", "read-only"');
    expect(terminal).toContain('"--ask-for-approval", "untrusted"');
    expect(terminal).toContain('"--disable", "code_mode_host"');
    expect(terminal).toContain("CODEX_READER_DEVELOPER_INSTRUCTIONS");
    expect(terminal).toContain("zotero_reader.get_reader_context once");
    expect(terminal).toContain("zotero_reader.search_current_pdf first");
    expect(terminal).toContain("zotero_reader.read_pdf_pages");
    expect(terminal).toContain("Never use textutil, pdftotext");
    expect(terminal).toContain("Never call tools from the same zotero_reader MCP server concurrently");
    expect(terminal).toContain(
      'args: ["--zotkit-mcp", "--context", session.workspace]',
    );
    expect(terminal.match(/command: this\.bridge\.helperPath/g)).toHaveLength(2);
    expect(terminal.match(/mcp_servers\.\$\{name\}\.enabled=true/g)).toHaveLength(1);
    expect(terminal).toContain(
      "mcp_servers.${name}.default_tools_approval_mode=${tomlString(\"approve\")}",
    );
    expect(terminal).toContain("mcp_servers.${name}.tool_timeout_sec=10");
    expect(terminal).toContain("this.bridge.zotkitPath");
    expect(terminal).toContain("ZOTKIT_CLI: this.bridge.zotkitPath");
    expect(terminal).toContain("librarySnapshotPath: this.current.librarySnapshotPath");
    expect(terminal).toContain("ZOTKIT_SNAPSHOT");
    expect(terminal).not.toContain('findExecutable("zotkit")');
    expect(terminal).not.toContain("pipx install zotkit");
    expect(terminal).not.toContain("~/.config/zotkit/env");
    expect(projectFile("src/platform.ts")).not.toContain('"codex" | "claude" | "zotkit"');
  });

  it("always rebuilds the native helper from source while packaging", () => {
    const packaging = projectFile("scripts/build.mjs");

    expect(packaging).toContain('function buildNativeHelper()');
    expect(packaging).toContain(
      'execFileSync("make", ["-C", path.join(repo, "native"), "universal"]',
    );
    expect(packaging).toContain("const helper = buildNativeHelper();");
    expect(packaging).not.toContain("mtimeMs");
    expect(packaging).not.toMatch(/\bstat\s*\(/);
  });

  it("ships localized section actions and context-aware fixed-size SVGs", () => {
    const english = projectFile("locale/en-US/zoterochat.ftl");
    const chinese = projectFile("locale/zh-CN/zoterochat.ftl");
    for (const locale of [english, chinese]) {
      expect(locale).toContain("zotkit-section-new-chat");
      expect(locale).toContain("zotkit-section-terminal");
    }
    for (const path of ["assets/chat.svg", "assets/terminal.svg"]) {
      const icon = projectFile(path);
      expect(icon).toContain('width="16" height="16"');
      expect(icon).toContain('stroke="context-fill"');
    }
  });

  it("keeps the fixed-size Zotero sidenav button icon-only with tooltip and ARIA text", () => {
    const locales = [
      projectFile("locale/en-US/zoterochat.ftl"),
      projectFile("locale/zh-CN/zoterochat.ftl")
    ];
    for (const locale of locales) {
      expect(locale).toMatch(/zotkit-pane-sidenav =\r?\n\s+\.tooltiptext = \S/);
      expect(locale).toMatch(/zotkit-pane-sidenav =[\s\S]*?\.aria-label = \S/);
      expect(locale).not.toMatch(/zotkit-pane-sidenav = [^\r\n]+/);
    }
  });

  it("localizes custom-section UI through attributes without replacing Zotero's DOM", () => {
    const locales = [
      projectFile("locale/en-US/zoterochat.ftl"),
      projectFile("locale/zh-CN/zoterochat.ftl")
    ];
    for (const locale of locales) {
      expect(locale).toMatch(/zotkit-pane-header =\r?\n\s+\.label = \S/);
      expect(locale).toMatch(/zotkit-pane-header =[\s\S]*?\.aria-label = \S/);
      expect(locale).not.toMatch(/zotkit-pane-header = [^\r\n]+/);

      for (const id of ["new-chat", "terminal"]) {
        expect(locale).toMatch(new RegExp(`zotkit-section-${id} =\\r?\\n\\s+\\.tooltiptext = \\S`));
        expect(locale).toMatch(new RegExp(`zotkit-section-${id} =[\\s\\S]*?\\.aria-label = \\S`));
        expect(locale).not.toMatch(new RegExp(`zotkit-section-${id} = [^\\r\\n]+`));
      }
    }
  });
});
