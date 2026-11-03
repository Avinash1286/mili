import { createHash } from 'node:crypto';
import { applyBoardTransaction, pruneMapBoardReferences, SceneError, type BoardTransaction, type Session } from '@tokai/contracts';
import { ApiError } from './store.js';

export function sceneFailure(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof SceneError) return new ApiError(error.code.includes('REVISION') || error.code.includes('CONFLICT') ? 409 : 400, error.code, error.message);
  return new ApiError(400, 'INVALID_BOARD_OPERATION', 'The board change could not be applied.');
}

/** Called only while holding the session mutation lock. Repeated IDs never reapply edits. */
export function applySessionBoardTransaction(session: Session, transaction: BoardTransaction, actor: 'student' | 'tutor', pruneMap = true) {
  const digest = createHash('sha256').update(JSON.stringify(transaction)).digest('hex');
  const previous = session.boardOperations?.find(operation => operation.operationId === transaction.operationId);
  if (previous) {
    if (previous.hash !== digest) throw new ApiError(409, 'OPERATION_ID_REUSED', 'This operation ID already belongs to a different board change.');
    return { duplicate: true, board: session.board };
  }
  try { session.board = applyBoardTransaction(session.board, transaction, actor); }
  catch (error) { throw sceneFailure(error); }
  if (pruneMap && session.conceptMap) session.conceptMap = pruneMapBoardReferences(session.conceptMap, session.board);
  session.boardOperations = [...(session.boardOperations ?? []), { operationId: transaction.operationId, hash: digest, revision: session.board.revision ?? 0 }].slice(-100);
  return { duplicate: false, board: session.board };
}
