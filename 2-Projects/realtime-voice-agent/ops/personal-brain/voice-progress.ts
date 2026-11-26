type Write = (text: string) => Promise<void>;
type Mode = 'chat' | 'search';

const phrases: Record<Mode, string[]> = {
  chat: ['让我想一想。', '我想一下啊。', '这个我想想。'],
  search: ['我来查一下。', '让我查一查。', '我看下资料。'],
};
const next = {chat: 0, search: 0};
const chatCooldowns = new Map<string, ReturnType<typeof setTimeout>>();
const maxCooldowns = 128;

function pick(mode: Mode, room: string): string | undefined {
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
  const choices = phrases[mode];
  const index = next[mode];
  next[mode] = (index + 1) % choices.length;
  return choices[index];
}

// The worker emits the first TTS sentence at a terminal mark after at least six
// Unicode scalars. An upstream token alone does not mean there is playable speech.
function speakable(text: string): boolean {
  return /[。！？；!?;…~～\n]/u.test(Array.from(text).slice(5).join(''));
}

export function isVoiceCompletion(room: string | undefined, fromHeader: boolean): boolean {
  // The registered worker adds its signed room as a query. Text and admin use the session header.
  return !fromHeader && /^pv-[a-f0-9]{32}$/.test(room ?? '');
}

export async function withVoiceProgress<T>(
  room: string,
  run: (body: Write, searchStarted: () => void) => Promise<T>,
  write: Write,
  signal: AbortSignal,
  options = {chatWaitMs: 750, searchWaitMs: 390},
): Promise<T> {
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
    const phrase = pick(mode, room);
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
    });
    signal.throwIfAborted();
    await flush();
    return result;
  } finally {
    clearTimeout(timer);
    first = false;
  }
}
