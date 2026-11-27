// Keep whole speakable sentences. A dot between word characters is commonly a
// decimal, version or domain and can arrive alone in its own SSE delta.
const stop = /[。！？!?；;～~…\.\n]/gu;
const letterOrNumber = /[a-z\d]/iu;
function boundary(text: string, final: boolean): number {
  for (const match of text.matchAll(stop)) {
    const i = match.index!;
    if (/[~～]/u.test(match[0]) && /\d/u.test(text[i - 1] ?? '')) {
      if (i === text.length - 1 && !final) return 0;
      if (/\d/u.test(text[i + 1] ?? '')) continue;
    }
    if (match[0] === '.') {
      if (i === text.length - 1 && !final) return 0;
      if (letterOrNumber.test(text[i - 1] ?? '') && letterOrNumber.test(text[i + 1] ?? '')) continue;
    }
    return i + 1;
  }
  return 0;
}

const maxSentence = 88;
const maxIntactSentence = 180;
const noSummary = '我暂时没能把重点说清楚。';

export class BriefSpeech {
  private pending = '';
  private followsAsciiStop = false;
  private skippedLongSentence = false;
  private discardUntilStop = false;
  count = 0;
  done = false;
  constructor(private readonly limit: 1 | 2) {}

  feed(text: string, final = false): string {
    if (this.done) return '';
    this.pending += text;
    let out = '';
    while (this.pending) {
      if (this.discardUntilStop) {
        const end = boundary(this.pending, final);
        if (!end) {
          this.pending = final ? '' : this.pending.slice(-2); // retain decimal-dot context across deltas
          break;
        }
        this.pending = this.pending.slice(end);
        this.discardUntilStop = false;
        continue;
      }
      this.pending = this.pending.replace(/^[\s。！？!?；;～~….”’」』]+/u, '');
      if (!this.pending) break;
      const end = boundary(this.pending, final);
      // No arbitrary cut inside an unpunctuated word or technical expression.
      if (!end && !final && this.pending.length <= maxSentence) break;
      const candidate = this.pending.slice(0, end || undefined).trim();
      let sentence = candidate;
      if (candidate.length > maxSentence) {
        // Use a complete leading clause, or keep an earlier complete sentence.
        // Never chop a word, decimal, URL or conditional premise in the middle.
        const prefix = candidate.slice(0, maxSentence);
        const breaks = /[，,]|(?=但是|不过|此外|因此|所以|另外|与此同时|换句话说)/gu;
        const clauses = [...prefix.matchAll(breaks)].filter(m => m[0] !== ',' ||
          !( /\d/u.test(candidate[m.index!-1] ?? '') && /\d/u.test(candidate[m.index!+1] ?? '') ))
          .map(m => prefix.slice(0, m.index).trim());
        const clause = clauses.reverse().find(c => c.length >= 6 && !/^(?:如果|假如|只要|虽然|由于|尽管|因为)[^，,；;]*$/u.test(c)
          && !/(?:比如|例如|包括|分别是|分别为|原因是|如下|第一|首先|以及)$/u.test(c));
        if (clause) {
          sentence = clause + '。';
        } else {
          // The next delta may finish a perfectly good first sentence. Preserve
          // one complete statement if shortening it would change its meaning.
          if (!end && !final) {
            if (candidate.length > maxIntactSentence) {
              this.skippedLongSentence = true;
              this.discardUntilStop = true;
              this.pending = this.pending.slice(-2);
            }
            break;
          }
          if (this.count || candidate.length > maxIntactSentence || /(.)\1{9}/u.test(candidate)) {
            this.skippedLongSentence = true;
            this.pending = end ? this.pending.slice(end) : '';
            continue; // A usable short conclusion can still follow this sentence.
          }
        }
        this.done = true;
      }
      if (!/[。！？!?；;～~….]$/u.test(sentence)) sentence += '。';
      // Spoken punctuation clusters count as one stop. Balance quoted sentences
      // when a closing quote arrives after the chunk we are already emitting.
      for (const [open, close] of [['“','”'], ['「','」'], ['『','』']]) {
        if (sentence.lastIndexOf(open) > sentence.lastIndexOf(close)) sentence += close;
      }
      if (this.followsAsciiStop && /^[A-Za-z0-9]/u.test(sentence)) out += ' ';
      out += sentence;
      this.followsAsciiStop = /[.!?;]$/u.test(sentence);
      this.count++;
      if (this.done || this.count >= this.limit) { this.done = true; this.pending = ''; break; }
      this.pending = end ? this.pending.slice(end) : '';
    }
    return out;
  }
  finish(): string {
    const tail = this.feed('', true);
    return !this.count && this.skippedLongSentence ? noSummary : tail;
  }
}

// Deterministic replies are already complete. Join weather and memory facts so
// the source, city, temperatures, alerts and-when-applicable negatives survive.
export function briefToolSpeech(text: string, tool: string | undefined, limit: 1 | 2): string {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest) {
    const end = boundary(rest, true) || rest.length;
    const part = rest.slice(0, end).trim();
    if (part) parts.push(part);
    rest = rest.slice(end).replace(/^[\s。！？!?；;～~…]+/u, '');
  }
  if (parts.length <= limit) return text;
  if (tool === 'search') {
    const warnings = parts.filter(s => /预警|警报|紧急|注意安全|尚未证实|未能核实/u.test(s));
    const selected = [...new Set([...parts.slice(0, limit), ...warnings])];
    parts.splice(0, parts.length, ...selected);
  }
  const groups = [...parts.slice(0, limit - 1), parts.slice(limit - 1).map((p, i, tail) =>
    i === tail.length - 1 ? p : p.replace(/[。！？!?；;～~….\s]+$/u, '') + '，').join('')];
  return groups.reduce((out, group) => out + (/[.!?;]$/u.test(out) && /^[A-Za-z0-9]/u.test(group) ? ' ' : '') + group, '');
}
