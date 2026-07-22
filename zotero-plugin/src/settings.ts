import {
  configuredLibraryRoot,
  pathExists,
  prefBool,
  prefInt,
  prefString,
  profilePath,
  setPrefString
} from "./platform";

export type AgentKind = "codex" | "claude";
export type ReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export interface ZoteroChatSettings {
  libraryRoot: string;
  defaultAgent: AgentKind;
  defaultModel: string;
  reasoningEffort: ReasoningEffort;
  approvalPolicy: string;
  terminalHeight: number;
  showReasoning: boolean;
  storageRoot: string;
}

export async function loadSettings(): Promise<ZoteroChatSettings> {
  const configured = configuredLibraryRoot();
  return {
    libraryRoot: (await pathExists(configured)) ? configured : "",
    defaultAgent: normalizeAgent(prefString("defaultAgent", "codex")),
    defaultModel: prefString("defaultModel", ""),
    reasoningEffort: normalizeEffort(prefString("reasoningEffort", "medium")),
    approvalPolicy: prefString("approvalPolicy", "never"),
    terminalHeight: Math.max(260, Math.min(prefInt("terminalHeight", 420), 900)),
    showReasoning: prefBool("showReasoning", false),
    storageRoot: profilePath()
  };
}

export function saveLibraryRoot(path: string): void {
  setPrefString("libraryRoot", path);
}

function normalizeAgent(value: string): AgentKind {
  return value === "claude" ? value : "codex";
}

function normalizeEffort(value: string): ReasoningEffort {
  return ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(value)
    ? value as ReasoningEffort
    : "medium";
}
