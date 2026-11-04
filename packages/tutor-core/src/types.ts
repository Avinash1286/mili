import type { Board, Session, SelectionContext, TeachingBeatProposal, PublicAssessment, TutorLearningAction, PracticeResponse } from '@milli/contracts';
export class TutorError extends Error {
  diagnostics?: TutorDiagnostics;
  providerStatus?: number;
  failureCategory?: 'provider-http' | 'network' | 'invalid-response' | 'runtime';
  errorName?: string;
  constructor(public readonly code: string, message: string, public readonly status = 503) { super(message); this.name = 'TutorError'; }
}
export type TutorDiagnostics = { modelCalls: number; toolCalls: number; tools: string[]; repairAttempts: number; textOnlyFallback: boolean; promptVersion: string; rejectedTools: { tool: string; code: string; issues?: { path: string; code: string }[] }[]; lastFinishReason?: string; provider?: string; fallbacks?: { provider: string; code: string }[] };
export type TutorReply = {
  text: string; board?: Board; beats?: TeachingBeatProposal[]; warnings?: string[];
  diagnostics?: TutorDiagnostics;
  /** Server-only callback: caller owns the session transaction, epoch guard and final save. */
  commitLearning?: (session: Session, beatId: string) => Promise<void>;
};
export type PreparedLearningAction = { spokenText: string; displayText: string; assessment?: PublicAssessment; feedback?: string };
export type TutorLearningContext = { assessments: PublicAssessment[]; submittedPresentationId?: string; prepare: (action: TutorLearningAction) => Promise<PreparedLearningAction> };
export type ProviderUsage = {
  provider: 'gemini' | 'groq' | 'cerebras'; model: string;
  /** Provider response identifier, used as the trace identifier. */
  requestId?: string;
  inputTokens?: number; outputTokens?: number; cachedInputTokens?: number;
  thoughtTokens?: number; toolUseInputTokens?: number; totalTokens?: number;
};
/** Called once per HTTP model request; counts are incremental, never turn-cumulative. */
export type ProviderUsageObserver = (usage: Readonly<ProviderUsage>) => void;
/** An OpenAI-compatible tutor fallback. */
export type FastProvider = { provider: 'groq' | 'cerebras'; apiKey: string; model: string; baseUrl?: string; timeoutMs?: number };
export type TutorInput = { session: Session; text: string; selectedNodeId?: string; selection?: SelectionContext; apiKey: string; model: string; fastProviders?: FastProvider[]; signal?: AbortSignal; onUsage?: ProviderUsageObserver; learning?: TutorLearningContext; practiceResponse?: PracticeResponse; turnId?: string; inputMode?: 'typed' | 'spoken'; limits?: { maxModelCalls?: number; maxRepairAttempts?: number; requestTimeoutMs?: number } };
export type GenerateReply = (input: TutorInput) => Promise<TutorReply>;
