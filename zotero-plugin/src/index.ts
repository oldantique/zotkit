import "@xterm/xterm/css/xterm.css";
import "katex/dist/katex.min.css";
import "./styles.css";
import { ZoteroChatPlugin } from "./plugin";

const plugin = new ZoteroChatPlugin();

export const ZoteroChatRuntime = {
  startup: (data: { id: string; version: string; rootURI: string }) => plugin.startup(data),
  shutdown: (_options?: { appShutdown?: boolean }) => plugin.shutdown(),
  onMainWindowLoad: (win: Window) => plugin.onMainWindowLoad(win),
  onMainWindowUnload: (win: Window) => plugin.onMainWindowUnload(win)
};

(globalThis as unknown as { ZoteroChatRuntime: typeof ZoteroChatRuntime }).ZoteroChatRuntime = ZoteroChatRuntime;
