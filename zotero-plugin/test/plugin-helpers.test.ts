import { describe, expect, it } from "vitest";
import { resolveSettingsHost, shouldAutoOpenFloat, type AutoOpenFloatState } from "../src/plugin-helpers";

function baseState(overrides: Partial<AutoOpenFloatState> = {}): AutoOpenFloatState {
  return {
    running: true,
    hasConnectedViews: false,
    floatVisible: false,
    autoOpenedTurnId: null,
    dismissedTurnId: null,
    activeTurnId: "turn-1",
    ...overrides,
  };
}

describe("shouldAutoOpenFloat (bug-triage #2)", () => {
  it("opens when a turn is running, no sidebar body is connected, and the float isn't already visible", () => {
    expect(shouldAutoOpenFloat(baseState())).toBe(true);
  });

  it("does nothing when no turn is running", () => {
    expect(shouldAutoOpenFloat(baseState({ running: false }))).toBe(false);
  });

  it("does nothing when a sidebar chat view is still connected -- the turn already has visible surface", () => {
    expect(shouldAutoOpenFloat(baseState({ hasConnectedViews: true }))).toBe(false);
  });

  it("does nothing when the float panel is already visible", () => {
    expect(shouldAutoOpenFloat(baseState({ floatVisible: true }))).toBe(false);
  });

  it("fires at most once per turn -- already auto-opened for this turn", () => {
    expect(shouldAutoOpenFloat(baseState({ autoOpenedTurnId: "turn-1" }))).toBe(false);
  });

  it("does not fight a dismissal the user made during this same turn", () => {
    expect(shouldAutoOpenFloat(baseState({ dismissedTurnId: "turn-1" }))).toBe(false);
  });

  it("re-arms for a new turn even if the previous turn was auto-opened", () => {
    expect(shouldAutoOpenFloat(baseState({ autoOpenedTurnId: "turn-0", activeTurnId: "turn-1" }))).toBe(true);
  });

  it("re-arms for a new turn even if the previous turn was dismissed", () => {
    expect(shouldAutoOpenFloat(baseState({ dismissedTurnId: "turn-0", activeTurnId: "turn-1" }))).toBe(true);
  });
});

interface Host {
  isConnected: boolean;
  name: string;
}

function host(name: string, isConnected = true): Host {
  return { name, isConnected };
}

describe("resolveSettingsHost (gear-click no-op bug)", () => {
  it("prefers the clicked view's own body when it's still connected", () => {
    const preferred = host("clicked");
    const active = host("active");
    const fallback = host("fallback");
    expect(resolveSettingsHost(preferred, active, fallback)).toBe(preferred);
  });

  it("falls back to the active sidebar body when the preferred body has been disconnected", () => {
    const preferred = host("clicked", false);
    const active = host("active");
    const fallback = host("fallback");
    expect(resolveSettingsHost(preferred, active, fallback)).toBe(active);
  });

  it("falls back to the active sidebar body when no preferred body was given", () => {
    const active = host("active");
    const fallback = host("fallback");
    expect(resolveSettingsHost(null, active, fallback)).toBe(active);
  });

  it("falls back to the first connected mounted view when neither preferred nor active resolve", () => {
    const fallback = host("fallback");
    expect(resolveSettingsHost(null, null, fallback)).toBe(fallback);
    expect(resolveSettingsHost(host("clicked", false), null, fallback)).toBe(fallback);
  });

  it("returns null -- caller must report an error instead of silently doing nothing -- when nothing resolves", () => {
    expect(resolveSettingsHost(null, null, null)).toBeNull();
    expect(resolveSettingsHost(host("clicked", false), null, null)).toBeNull();
  });
});
