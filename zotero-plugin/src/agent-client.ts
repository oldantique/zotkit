import type {
  AccountLoginParams,
  AccountLoginResponse,
  AccountReadResponse,
  ModelListParams,
  ModelListResponse,
  ThreadForkParams,
  ThreadForkResponse,
  ThreadReadResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadRollbackParams,
  ThreadRollbackResponse,
  ThreadStartParams,
  ThreadStartResponse,
  TurnInterruptParams,
  TurnStartParams,
  TurnStartResponse,
  TurnSteerParams,
  TurnSteerResponse,
} from "./codex-app-server";

/** Backend feature flags resolved when a backend starts; UI reads them from service state. */
export interface AgentCapabilities {
  supportsAgentMode: boolean;
  supportsSteering: boolean;
  supportsLogin: boolean;
  supportsCheckpoints: boolean;
}

/**
 * The narrow client surface CodexService actually consumes. Extracted from
 * CodexAppServerClient's call sites, not invented: EngineClient implements the
 * same contract in-process, feeding the same ThreadStore with the same
 * notification vocabulary.
 */
export interface AgentClient {
  readonly agentCapabilities: AgentCapabilities;
  connect(): Promise<unknown>;
  close(code?: number, reason?: string): void;
  accountRead(params?: { refreshToken?: boolean }): Promise<AccountReadResponse>;
  modelList(params?: ModelListParams): Promise<ModelListResponse>;
  threadStart(params?: ThreadStartParams): Promise<ThreadStartResponse>;
  threadResume(params: ThreadResumeParams): Promise<ThreadResumeResponse>;
  threadRead(threadId: string, includeTurns?: boolean): Promise<ThreadReadResponse>;
  threadSetName(threadId: string, name: string): Promise<Record<string, never>>;
  turnStart(params: TurnStartParams): Promise<TurnStartResponse>;
  turnInterrupt(params: TurnInterruptParams): Promise<Record<string, never>>;
  // Codex-only surfaces. Call sites must gate on agentCapabilities.
  turnSteer?(params: TurnSteerParams): Promise<TurnSteerResponse>;
  accountLoginStart?(params: AccountLoginParams): Promise<AccountLoginResponse>;
  accountLogout?(): Promise<Record<string, never>>;
  threadFork?(params: ThreadForkParams): Promise<ThreadForkResponse>;
  threadRollback?(params: ThreadRollbackParams): Promise<ThreadRollbackResponse>;
}

export const CODEX_CAPABILITIES: AgentCapabilities = Object.freeze({
  supportsAgentMode: true,
  supportsSteering: true,
  supportsLogin: true,
  supportsCheckpoints: true,
});

export const ENGINE_CAPABILITIES: AgentCapabilities = Object.freeze({
  supportsAgentMode: false,
  supportsSteering: false,
  supportsLogin: false,
  supportsCheckpoints: false,
});
