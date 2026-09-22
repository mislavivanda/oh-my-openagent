import type { OhMyOpenCodeConfig } from "../config";
import { getMainSessionID, getSessionAgent } from "../features/claude-code-session-state";
import type { JevModelErrorTriage } from "../features/jev";
import {
  clearPendingModelFallback,
  clearSessionFallbackChain,
  setPendingModelFallback,
  type ModelFallbackHook,
} from "../hooks/model-fallback/hook";
import { shouldRetryError } from "../shared/model-error-classifier";
import { AGENT_MODEL_REQUIREMENTS } from "../shared/model-requirements";
import { extractRetryAttempt, normalizeRetryStatusMessage } from "../shared/retry-status-utils";
import {
  extractErrorMessage,
  extractErrorName,
  extractProviderModelFromErrorMessage,
  normalizeFallbackModelID,
  resolveFallbackAgentName,
} from "./event-error-utils";
import {
  applyUserConfiguredFallbackChain,
  createModelFallbackContinuationController,
  type FallbackContinuationContext,
} from "./event-model-fallback-state";
import type { PluginEventContext } from "./event-types";

function resolveSisyphusMissingMetadataCurrentModelID(): string {
  const firstFallback = AGENT_MODEL_REQUIREMENTS["sisyphus"].fallbackChain[0];
  if (!firstFallback) {
    throw new Error("Sisyphus fallback chain must define a first fallback model");
  }
  return firstFallback.model;
}

const SISYPHUS_MISSING_METADATA_CURRENT_MODEL_ID = resolveSisyphusMissingMetadataCurrentModelID();

type TriageReservation = { cancelled: boolean };

export function createModelFallbackEventHandler(args: {
  pluginConfig: OhMyOpenCodeConfig;
  pluginContext: PluginEventContext;
  modelFallback: ModelFallbackHook | null | undefined;
  isModelFallbackEnabled: boolean;
  isRuntimeFallbackEnabled: boolean;
  shouldAutoRetrySession: (sessionID: string) => boolean;
  isSessionStopped: (sessionID: string) => boolean;
  jevTriage?: JevModelErrorTriage;
}) {
  const lastHandledModelErrorMessageID = new Map<string, string>();
  const lastHandledRetryStatusKey = new Map<string, string>();
  const lastKnownModelBySession = new Map<string, { providerID: string; modelID: string }>();
  const continuationsInFlight = new Set<string>();
  const triageInFlight = new Map<string, TriageReservation>();
  const deletingSessions = new Map<string, number>();
  const lastDispatchedContinuationKeys = new Map<
    string,
    {
      modelKeys: Set<string>;
      providerModelKeys: Set<string>;
      providerlessModelKeys: Set<string>;
    }
  >();
  const continuation = createModelFallbackContinuationController({
    pluginConfig: args.pluginConfig,
    pluginContext: args.pluginContext,
    lastKnownModelBySession,
    continuationsInFlight,
    lastDispatchedContinuationKeys,
  });

  const cancelPendingJevTriage = (sessionID: string): void => {
    if (!args.jevTriage?.enabled) return;
    const sessionPrefix = `${sessionID}:`;
    for (const [key, reservation] of triageInFlight) {
      if (!key.startsWith(sessionPrefix)) continue;
      reservation.cancelled = true;
      triageInFlight.delete(key);
    }
    deletingSessions.set(sessionID, (deletingSessions.get(sessionID) ?? 0) + 1);
  };

  const finishJevTriageDeletion = (sessionID: string): void => {
    if (!args.jevTriage?.enabled) return;
    const count = (deletingSessions.get(sessionID) ?? 0) - 1;
    if (count <= 0) deletingSessions.delete(sessionID);
    else deletingSessions.set(sessionID, count);
  };

  const clearSession = (sessionID: string): void => {
    cancelPendingJevTriage(sessionID);
    lastHandledModelErrorMessageID.delete(sessionID);
    lastHandledRetryStatusKey.delete(sessionID);
    lastKnownModelBySession.delete(sessionID);
    continuationsInFlight.delete(sessionID);
    lastDispatchedContinuationKeys.delete(sessionID);
    if (args.modelFallback) {
      clearPendingModelFallback(args.modelFallback, sessionID);
      clearSessionFallbackChain(args.modelFallback, sessionID);
    }
    finishJevTriageDeletion(sessionID);
  };

  const clearRetryDedupeAfterIdle = (sessionID: string): void => {
    lastHandledRetryStatusKey.delete(sessionID);
    lastDispatchedContinuationKeys.delete(sessionID);
  };

  const setLastKnownModel = (sessionID: string, model: { providerID: string; modelID: string }): void => {
    lastKnownModelBySession.set(sessionID, model);
  };

  const applyFallback = async (
    sessionID: string,
    source: string,
    agentName: string,
    currentProvider: string,
    currentModel: string,
    shouldAutoContinue: boolean,
    fallbackContext: FallbackContinuationContext,
  ): Promise<void> => {
    if (shouldAutoContinue && continuation.shouldSkipFallbackContinuation(sessionID, source, fallbackContext)) return;

    applyUserConfiguredFallbackChain(args.modelFallback, sessionID, agentName, currentProvider, args.pluginConfig);
    const setFallback = args.modelFallback
      ? setPendingModelFallback(args.modelFallback, sessionID, agentName, currentProvider, currentModel)
      : false;

    if (setFallback && shouldAutoContinue) {
      await continuation.autoContinueAfterFallback(sessionID, source, fallbackContext);
    }
  };

  const shouldHandleModelFallback = (): boolean => {
    return args.isModelFallbackEnabled && !args.isRuntimeFallbackEnabled;
  };

  const handleAssistantMessageUpdated = async (params: {
    sessionID: string;
    info: Record<string, unknown>;
    agent?: string;
  }): Promise<boolean> => {
    if (!shouldHandleModelFallback()) return false;

    const assistantMessageID = params.info.id as string | undefined;
    const assistantError = params.info.error;
    if (!assistantMessageID || !assistantError) return false;

    const lastHandled = lastHandledModelErrorMessageID.get(params.sessionID);
    if (lastHandled === assistantMessageID) return true;

    const errorName = extractErrorName(assistantError);
    const errorMessage = extractErrorMessage(assistantError);
    const jevTriage = args.jevTriage;
    const jevEnabled = jevTriage?.enabled === true;
    const triageKey = `${params.sessionID}:${assistantMessageID}`;
    let token: TriageReservation | undefined;
    if (jevEnabled) {
      if ((deletingSessions.get(params.sessionID) ?? 0) > 0 || triageInFlight.has(triageKey)) return true;
      token = { cancelled: false };
      triageInFlight.set(triageKey, token);
    }

    try {
      const shouldRetry = jevEnabled && jevTriage
        ? await jevTriage.shouldRetry(
          { name: errorName, message: errorMessage },
          { site: "message.updated", sessionID: params.sessionID },
        )
        : shouldRetryError({ name: errorName, message: errorMessage });
      if (token?.cancelled) return false;
      if (!shouldRetry) return false;

      const agentName = resolveFallbackAgentName({
        currentAgent: params.agent ?? getSessionAgent(params.sessionID),
        sessionID: params.sessionID,
        mainSessionID: getMainSessionID(),
        message: errorMessage,
      });
      if (!agentName) return false;

      const providerHint = params.info.providerID as string | undefined;
      const currentProvider = continuation.resolveFallbackProviderID(params.sessionID, providerHint);
      const rawModel = (params.info.modelID as string | undefined) ?? SISYPHUS_MISSING_METADATA_CURRENT_MODEL_ID;
      const currentModel = normalizeFallbackModelID(rawModel);
      const fallbackContext = { agentName, providerID: currentProvider, dedupeProviderID: providerHint, modelID: currentModel };
      const shouldAutoContinue = args.shouldAutoRetrySession(params.sessionID) && !args.isSessionStopped(params.sessionID);

      await applyFallback(
        params.sessionID,
        "message.updated",
        agentName,
        currentProvider,
        currentModel,
        shouldAutoContinue,
        fallbackContext,
      );
      if (shouldAutoContinue) lastHandledModelErrorMessageID.set(params.sessionID, assistantMessageID);
      return false;
    } finally {
      if (token && triageInFlight.get(triageKey) === token) triageInFlight.delete(triageKey);
    }
  };

  const handleSessionStatus = async (params: {
    sessionID: string;
    status?: { type?: string; attempt?: number; message?: string; next?: number };
  }): Promise<boolean> => {
    if (params.status?.type === "idle") clearRetryDedupeAfterIdle(params.sessionID);
    if (params.status?.type !== "retry" || !shouldHandleModelFallback()) return false;

    const retryMessage = typeof params.status.message === "string" ? params.status.message : "";
    const parsedForKey = extractProviderModelFromErrorMessage(retryMessage);
    const retryAttempt = extractRetryAttempt(params.status.attempt, retryMessage);
    const retryKey = `${retryAttempt}:${parsedForKey.providerID ?? ""}/${parsedForKey.modelID ?? ""}:${normalizeRetryStatusMessage(retryMessage)}`;
    if (lastHandledRetryStatusKey.get(params.sessionID) === retryKey) return true;
    const jevTriage = args.jevTriage;
    const jevEnabled = jevTriage?.enabled === true;
    const triageKey = `${params.sessionID}:${retryKey}`;
    let token: TriageReservation | undefined;
    if (!jevEnabled) {
      lastHandledRetryStatusKey.set(params.sessionID, retryKey);
      if (!shouldRetryError({ name: undefined, message: retryMessage })) return false;
    } else {
      if ((deletingSessions.get(params.sessionID) ?? 0) > 0 || triageInFlight.has(triageKey)) return true;
      token = { cancelled: false };
      triageInFlight.set(triageKey, token);
    }

    try {
      if (jevEnabled && jevTriage) {
        const shouldRetry = await jevTriage.shouldRetry(
          { name: undefined, message: retryMessage },
          { site: "session.status", sessionID: params.sessionID },
        );
        if (token?.cancelled) return false;
        lastHandledRetryStatusKey.set(params.sessionID, retryKey);
        if (!shouldRetry) return false;
      }

      const agentName = resolveFallbackAgentName({
        currentAgent: getSessionAgent(params.sessionID),
        sessionID: params.sessionID,
        mainSessionID: getMainSessionID(),
        message: retryMessage,
      });
      if (!agentName) return false;

      const parsed = extractProviderModelFromErrorMessage(retryMessage);
      const lastKnown = lastKnownModelBySession.get(params.sessionID);
      const currentProvider = continuation.resolveFallbackProviderID(params.sessionID, parsed.providerID);
      const currentModel = normalizeFallbackModelID(
        parsed.modelID ?? lastKnown?.modelID ?? SISYPHUS_MISSING_METADATA_CURRENT_MODEL_ID,
      );
      const fallbackContext = { agentName, providerID: currentProvider, dedupeProviderID: parsed.providerID, modelID: currentModel };
      const shouldAutoContinue = args.shouldAutoRetrySession(params.sessionID) && !args.isSessionStopped(params.sessionID);

      await applyFallback(
        params.sessionID,
        "session.status",
        agentName,
        currentProvider,
        currentModel,
        shouldAutoContinue,
        fallbackContext,
      );
      return false;
    } finally {
      if (token && triageInFlight.get(triageKey) === token) triageInFlight.delete(triageKey);
    }
  };

  const handleSessionError = async (params: {
    sessionID: string;
    errorMessage: string;
    errorName?: string;
    props?: Record<string, unknown>;
  }): Promise<void> => {
    if (!shouldHandleModelFallback()) return;

    const jevTriage = args.jevTriage;
    const jevEnabled = jevTriage?.enabled === true;
    const triageKey = `${params.sessionID}:${params.errorName ?? ""}:${params.errorMessage.slice(0, 200)}`;
    let token: TriageReservation | undefined;
    if (jevEnabled) {
      if ((deletingSessions.get(params.sessionID) ?? 0) > 0 || triageInFlight.has(triageKey)) return;
      token = { cancelled: false };
      triageInFlight.set(triageKey, token);
    }

    try {
      const shouldRetry = jevEnabled && jevTriage
        ? await jevTriage.shouldRetry(
          { name: params.errorName, message: params.errorMessage },
          { site: "session.error", sessionID: params.sessionID },
        )
        : shouldRetryError({ name: params.errorName, message: params.errorMessage });
      if (token?.cancelled) return;
      if (!shouldRetry) return;

      const agentName = resolveFallbackAgentName({
        currentAgent: getSessionAgent(params.sessionID),
        sessionID: params.sessionID,
        mainSessionID: getMainSessionID(),
        message: params.errorMessage,
      });
      if (!agentName) return;

      const parsed = extractProviderModelFromErrorMessage(params.errorMessage);
      const providerHint = (params.props?.providerID as string | undefined) || parsed.providerID;
      const currentProvider = continuation.resolveFallbackProviderID(params.sessionID, providerHint);
      const currentModel = normalizeFallbackModelID(
        (params.props?.modelID as string | undefined) || parsed.modelID || SISYPHUS_MISSING_METADATA_CURRENT_MODEL_ID,
      );
      const fallbackContext = { agentName, providerID: currentProvider, dedupeProviderID: providerHint, modelID: currentModel };
      const shouldAutoContinue = args.shouldAutoRetrySession(params.sessionID) && !args.isSessionStopped(params.sessionID);

      await applyFallback(
        params.sessionID,
        "session.error",
        agentName,
        currentProvider,
        currentModel,
        shouldAutoContinue,
        fallbackContext,
      );
    } finally {
      if (token && triageInFlight.get(triageKey) === token) triageInFlight.delete(triageKey);
    }
  };

  return {
    cancelPendingJevTriage,
    clearRetryDedupeAfterIdle,
    clearSession,
    finishJevTriageDeletion,
    handleAssistantMessageUpdated,
    handleSessionError,
    handleSessionStatus,
    setLastKnownModel,
  };
}
