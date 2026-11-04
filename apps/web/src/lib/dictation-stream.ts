import { DictationStreamServerSchema } from '@milli/contracts';
import { dictationConnection } from './api';

export interface DictationStream { send(samples: Int16Array): void; finish(): Promise<string>; cancel(): void }
export async function openDictationStream(sessionId: string, signal: AbortSignal): Promise<DictationStream> {
  const connection = await dictationConnection();
  signal.throwIfAborted();
  const socket = new WebSocket(connection.url);
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  let resolveText!: (text: string) => void, rejectText!: (error: Error) => void;
  let settled = false;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const transcript = new Promise<string>((resolve, reject) => { resolveText = resolve; rejectText = reject; });
  void transcript.catch(() => undefined);
  const release = () => { clearTimeout(deadline); signal.removeEventListener('abort', abort); socket.close(); };
  const fail = (error: Error) => { if (settled) return; settled = true; rejectReady(error); rejectText(error); release(); };
  const abort = () => fail(new DOMException('Voice input cancelled', 'AbortError'));
  const deadline = setTimeout(() => fail(new Error('Speech recognition timed out. Please try again.')), 45000);
  signal.addEventListener('abort', abort, { once: true });
  socket.onopen = () => socket.send(JSON.stringify({ type: 'start', token: connection.token, sessionId }));
  socket.onerror = () => fail(new Error('Could not connect voice input. Please try again or type your answer.'));
  socket.onclose = () => { if (!settled) fail(new Error('Voice input disconnected. Please try again.')); };
  socket.onmessage = event => {
    try {
      const message = DictationStreamServerSchema.parse(JSON.parse(event.data));
      if (message.type === 'ready') resolveReady();
      else if (message.type === 'error') fail(new Error(message.message));
      else { settled = true; resolveText(message.text); release(); }
    } catch { fail(new Error('Speech recognition returned an invalid response.')); }
  };
  if (signal.aborted) abort();
  await ready;
  return {
    send(samples) {
      if (settled || socket.readyState !== WebSocket.OPEN) throw new Error('Voice input is disconnected.');
      if (socket.bufferedAmount > 64000) { fail(new Error('Your connection is too slow for voice input. Please try typing.')); return; }
      const bytes = new Uint8Array(samples.length * 2), view = new DataView(bytes.buffer);
      samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
      socket.send(bytes);
    },
    finish() { if (!settled && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'finish' })); return transcript; },
    cancel: abort,
  };
}
