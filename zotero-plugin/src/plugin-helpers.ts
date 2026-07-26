/**
 * Small pure decision helpers pulled out of plugin.ts so they get a direct
 * unit-test harness -- plugin.ts itself has none (it wires live Zotero
 * globals). Keep this file free of Zotero/DOM dependencies.
 */

export interface AutoOpenFloatState {
  /** A codex turn is currently streaming/running. */
  running: boolean;
  /** At least one sidebar chat view is mounted and connected to the DOM. */
  hasConnectedViews: boolean;
  /** The float panel (on the main window) is already visible. */
  floatVisible: boolean;
  /** The turn id (opaque, caller-defined) the auto-open already fired for, if any. */
  autoOpenedTurnId: string | null;
  /** The turn id the user explicitly dismissed the float panel during, if any. */
  dismissedTurnId: string | null;
  /** The turn id of the turn currently running, or null when nothing is running. */
  activeTurnId: string | null;
}

/**
 * Bug-triage #2: a running turn has zero visible surface once every sidebar
 * body disconnects (section collapsed/closed) -- the answer keeps streaming
 * into the store, but the user reads "nothing is happening" as "AI stopped".
 *
 * Decides whether the float panel should be force-opened (never closed --
 * callers must use an ensure-open path, not a toggle) so a running turn
 * always has *some* visible surface. Fires at most once per turn (tracked by
 * `activeTurnId`) and never fights a dismissal the user made during the same
 * turn.
 */
export function shouldAutoOpenFloat(state: AutoOpenFloatState): boolean {
  if (!state.running) return false;
  if (state.hasConnectedViews) return false;
  if (state.floatVisible) return false;
  if (state.activeTurnId !== null && state.activeTurnId === state.autoOpenedTurnId) return false;
  if (state.activeTurnId !== null && state.activeTurnId === state.dismissedTurnId) return false;
  return true;
}
