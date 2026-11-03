import type { Board, Session, SelectionContext, TeachingBeatProposal } from '@tokai/contracts';
export class TutorError extends Error {
  diagnostics?: TutorDiagnostics;
  providerStatus?: number;
  failureCategory?: 'provider-http' | 'network' | 'invalid-response' | 'runtime';
  errorName?: string;
  constructor(public readonly code: string, message: string, public readonly status = 503) { super(message); this.name = 'TutorError'; }
}
export type TutorDiagnostics = { modelCalls: number; toolCalls: number; tools: string[]; repairAttempts: number; textOnlyFallback: boolean; promptVersion: string; rejectedTools: { tool: string; code: string; issues?: { path: string; code: string }[] }[]; lastFinishReason?: string };
export type TutorReply = {
  text: string; board?: Board; beats?: TeachingBeatProposal[]; warnings?: string[];
  diagnostics?: TutorDiagnostics;
};
export type TutorInput = { session: Session; text: string; selectedNodeId?: string; selection?: SelectionContext; apiKey: string; model: string; signal?: AbortSignal; limits?: { maxModelCalls?: number; maxRepairAttempts?: number } };
export type GenerateReply = (input: TutorInput) => Promise<TutorReply>;
