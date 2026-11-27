"""Stage the reused source and adapt personal memory wording at build time."""
from pathlib import Path
import re
import shutil
import sys

source, target = map(Path, sys.argv[1:])
modules = """
    child-insight-store conversation-store dislike-undo extract-scheduler
    extraction-log-store exit-intent growth-ledger-store history-observations
    llm-extract memory-extractor memory-item-store memory-safety-filter
    paren-filter profile-store prompt-orchestrator relation-state-store
    rename-gate style-intent style-pool-store style-template trait-store
    tools/baidu-weather tools/fixed-weather tools/moji-weather tools/weather-places
    tools/cctv-news tools/clock-query tools/search-executor tools/search-failure
    tools/search-claim-stream tools/search-dialogue-context tools/search-resume tools/search-tasks
""".split()

for module in modules:
    name = module + '.ts'
    path = target / name
    path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source / name, path)

# Keep validation and provenance rules. Disable game memory at the prompt,
# parsing and injection boundaries. The owner uses the same persona stores.
def remove(pattern, text, count=1):
    result, actual = re.subn(pattern, '', text, flags=re.MULTILINE)
    if actual != count:
        raise SystemExit(f'P003 source moved: {pattern} ({actual})')
    return result

path = target / 'memory-extractor.ts'
text = path.read_text()
text = remove(r"^import .*stripArkDynamicTurns.*\n|^  snapshot=stripArkDynamicTurns.*\n", text, 2)
text = remove(r'''^  '  "game_progress".*\n''', text)
text, count = re.subn(r" \+\n    `，方舟进展=.*?`(?=;| \+)", '', text)
if count != 2:
    raise SystemExit('P003 game extraction context moved')
text = remove(r'^  // 方舟冒险事件.*\n  if \(Array.isArray\(obj.game_progress\)[\s\S]*?^  }\n', text)
text = text.replace(', type GameEvent', '').replace('儿童陪伴 AI', '个人语音助手 AI').replace('孩子', '主人')
# The extraction schema keeps "child" as an internal enum.
path.write_text(text)

path = target / 'prompt-orchestrator.ts'
text = path.read_text()
text = remove(r'^  let gameProgress.*\n|^  if \(gameProgress.length\).*\n', text, 2)
text = remove(r'^      // docs/25 问题4.*\n      // .*\n      gameProgress[^;]+;\n', text)
text = text.replace("import type { AuthContext } from './auth-jwt.js';",
                    "type AuthContext = { accountId: string; role: string };")
# In the private service, facts supplied to the model must be tied to the owner's words.
# Keep the shared persona, relationship and persistent style assembly intact.
for old, new in [
    ('opts?: { skipInjectReceipt?: boolean }', 'opts?: { skipInjectReceipt?: boolean; personalMemory?: {lines:string[]; ids:string[]} }'),
    ('buildChildMemoryBlock(meta, auth)', 'buildChildMemoryBlock(meta, auth, opts?.personalMemory)'),
    ('  auth: AuthContext | null,\n): { text: string; injectedIds:', '  auth: AuthContext | null,\n  personalMemory?: {lines:string[]; ids:string[]},\n): { text: string; injectedIds:'),
    ('  const episodic =\n    auth?.accountId', '  if (personalMemory) parts.splice(0, parts.length, ...personalMemory.lines);\n  const episodic =\n    !personalMemory && auth?.accountId'),
    ('injectedIds: episodic?.injectedIds ?? []', 'injectedIds: personalMemory?.ids ?? episodic?.injectedIds ?? []'),
]:
    if text.count(old) != 1:
        raise SystemExit('Personal evidence hook moved: ' + old)
    text = text.replace(old, new)
path.write_text(text.replace('孩子', '主人'))
path = target / 'style-template.ts'
path.write_text(path.read_text().replace('家长设定', '主人设定').replace('孩子', '主人'))

# Keep the original LLM extraction parser and timeout. Select the same
# dedicated personal OpenAI-compatible upstream as the voice path.
path = target / 'llm-extract.ts'
text = path.read_text()
start = text.index('export async function callExtractionLlm')
header = """
type ResolvedExtractLlm = {
  apiKey?: string; baseUrl?: string; model?: string; extraBody: object;
  provider: string; source: string;
};
function resolveExtractLlm(): ResolvedExtractLlm {
  return extractionTarget();
}
"""
# Reuse the original small provider helper verbatim when staging.
provider = (source / 'providers/minimax-llm.ts').read_text()
helper = re.search(r'^export function stripThink\(.*?^}', provider, re.M | re.S)
if not helper:
    raise SystemExit('P003 stripThink moved')
fetch = """    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      signal: ctrl.signal,
      body: JSON.stringify(body),
    });"""
body = text[start:]
if body.count(fetch) != 1:
    raise SystemExit('P003 extraction fetch moved')
body = body.replace(fetch, fetch.replace("method: 'POST',", "method: 'POST', redirect: 'error',"), 1)
path.write_text("import { extractionTarget } from '../providers.js';\n" + helper.group() + '\n' + header + body)

path = target / 'tools/search-tasks.ts'
text = path.read_text()
old = "if (!/^BJP003\\d{14}$/.test(owner.subject) || !owner.session.startsWith(`sn-${owner.subject}-`))"
if text.count(old) != 1:
    raise SystemExit('P003 search owner gate moved')
text = text.replace(old, "if (!/^[a-z0-9_-]{1,64}$/.test(owner.subject) || !/^[A-Za-z0-9_-]{1,128}$/.test(owner.session))")
position = text.index('  receipt(owner:')
path.write_text(text[:position] + """  handoffToChat(owner: SearchOwner, id: string, delivery: string): SearchTask {
    const task = this.claim(owner, id, delivery);
    task.status = 'delivered';
    task.delivery = 'unknown';
    this.save(task);
    return task;
  }
  searchResult(owner: SearchOwner, id: string): SearchResult | undefined {
    this.tick();
    const task = this.records.get(id);
    return task?.subject === owner.subject && task.session === owner.session ? task.result : undefined;
  }
""" + text[position:])

path = target / 'conversation-store.ts'
text = path.read_text()
text = text.replace('ORDER BY ts DESC LIMIT ?', 'ORDER BY ts DESC, rowid DESC LIMIT ?')
position = text.index('  list(opts:')
path.write_text(text[:position] + """  addTurn(input: Omit<ConversationAddInput, 'role' | 'text'>, user: string, assistant: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const pair = [this.add({ ...input, role: 'user', text: user }),
        this.add({ ...input, role: 'assistant', text: assistant })];
      this.db.exec('COMMIT');
      return pair;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

""" + text[position:])

# Personal relay samples can exceed the original direct-provider budget.
# Leave time before the 20-second ledger deadline to return verified headlines.
path = target / 'tools/search-executor.ts'
text = path.read_text()
if text.count('final ? 5000 : 3000') != 1 or text.count('AbortSignal.timeout(20_000)') != 1:
    raise SystemExit('P003 search model timeout moved')
text = text.replace('final ? 5000 : 3000', 'final ? 12000 : 3000')
text = text.replace('AbortSignal.timeout(20_000)', 'AbortSignal.timeout(17_000)')

before = "type Options = { toolAudit?"
evidence = "      const evidence=await this.news.run(query,signal);"
if text.count(before) != 1 or text.count(evidence) != 1:
    raise SystemExit('P003 verified public evidence hook moved')
text = text.replace(before, "type Options = { onCctvEvidence?:(evidence:readonly Evidence[])=>void; toolAudit?")
path.write_text(text.replace(evidence, evidence + "\n      this.opts.onCctvEvidence?.(evidence);"))
