type Write = (text: string) => Promise<void>;
type Mode = 'chat' | 'search';

export interface VoiceCues { revision: number; chat: string[]; search: string[]; chatWaitMs: number; searchWaitMs: number }
export const DEFAULT_VOICE_PROGRESS_WINDOWS = {chatWaitMs: 350, searchWaitMs: 250} as const;
export const defaultVoiceCues: VoiceCues = {
  ...DEFAULT_VOICE_PROGRESS_WINDOWS, revision: 0,
  chat: ['让我想一想。', '我想一下啊。', '这个我想想。'],
  search: ['我来查一下。', '让我查一查。', '我看下资料。'],
};
let cues = defaultVoiceCues;
export function applyVoiceCues(settings: VoiceCues) { cues = settings; }
const next = {chat: 0, search: 0};
const chatCooldowns = new Map<string, ReturnType<typeof setTimeout>>();
const maxCooldowns = 128;

function pick(mode: Mode, room: string, choices: string[]): string | undefined {
  if (!choices.length) return;
  if (mode === 'chat') {
    if (chatCooldowns.has(room)) return undefined;
    if (chatCooldowns.size >= maxCooldowns) {
      const oldest = chatCooldowns.keys().next().value!;
      clearTimeout(chatCooldowns.get(oldest));
      chatCooldowns.delete(oldest);
    }
    // Remove even when the caller hangs up and the process sits idle.
    const expiry = setTimeout(() => chatCooldowns.delete(room), 20_000);
    expiry.unref();
    chatCooldowns.set(room, expiry);
  }
  const index = next[mode] % choices.length;
  next[mode] = (index + 1) % choices.length;
  return choices[index];
}

// Match the personal worker’s first segment: six scalars at a sentence ending,
// or eight at a full-width comma. A token by itself is not playable speech.
function speakable(text: string): boolean {
  const chars = Array.from(text);
  return /[。！？；!?;…~～\n]/u.test(chars.slice(5).join('')) || chars.slice(7).includes('，');
}

export function isVoiceCompletion(room: string | undefined, fromHeader: boolean): boolean {
  // The registered worker adds its signed room as a query. Text and admin use the session header.
  return !fromHeader && /^pv-[a-f0-9]{32}$/.test(room ?? '');
}

export async function withVoiceProgress<T>(
  room: string,
  run: (body: Write, searchStarted: () => void, suppressCue: () => void) => Promise<T>,
  write: Write,
  signal: AbortSignal,
  options: {chatWaitMs: number; searchWaitMs: number} = cues,
): Promise<T> {
  const phrases = cues;
  let mode: Mode = 'chat';
  let first = true;
  let buffer = '';
  let queue = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  function send(text: string) {
    if (!text) return queue;
    queue = queue.then(async () => {
      signal.throwIfAborted();
      await write(text);
    });
    // A timer write may reject before the model completes. The primary stream
    // still observes that same rejection on its next write or final drain.
    void queue.catch(() => {});
    return queue;
  }
  function flush() {
    clearTimeout(timer);
    first = false;
    const text = buffer;
    buffer = '';
    return send(text);
  }
  function deadline() {
    if (!first || signal.aborted) return;
    const phrase = pick(mode, room, phrases[mode]);
    if (phrase) void send(phrase);
    void flush();
  }
  function schedule(ms: number) {
    clearTimeout(timer);
    timer = setTimeout(deadline, ms);
  }
  schedule(options.chatWaitMs);
  try {
    const result = await run(async text => {
      signal.throwIfAborted();
      if (!first) { await send(text); return; }
      buffer += text;
      if (speakable(buffer) || buffer.length >= 256) await flush();
    }, () => {
      if (first && mode !== 'search') {
        mode = 'search';
        schedule(options.searchWaitMs);
      }
    }, () => {
      // The caller resolves the style before its first write or network await.
      clearTimeout(timer);
      first = false;
    });
    signal.throwIfAborted();
    await flush();
    return result;
  } finally {
    clearTimeout(timer);
    first = false;
  }
}
