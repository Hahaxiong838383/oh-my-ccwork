import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { clampTrait, DAILY_ORGANIC_CAP, TRAIT_LABELS, traitStore } from './p003/trait-store.js';
import { isCrisisContent } from './p003/memory-safety-filter.js';
import type { ConversationItem } from './p003/conversation-store.js';

const compact = (text: string) => text.normalize('NFKC').replace(/[\s，、。,.！!~～]/gu, '');
const reference = '(?:(?:我)?(?:(?:你)?(?:刚刚|刚才)(?:你)?(?:讲|说)(?:的|得)?|(?:你)?(?:刚刚|刚才)(?:的)?|(?:你)?(?:刚)?(?:讲|说)的))?';
const target = '(?:这个|那个|刚才的|刚刚的|这段|那段|这种)?(?:小?故事|回答|回复|讲法|说法|讲故事的方式|讲述方式|说话方式|讲解方式|解释方式)';
const positive = '(?:我(?:很|非常|特别|挺|真|好)?喜欢|我觉得(?:很|非常|特别|挺|真)?好听|(?:很|非常|特别|挺|真|太)?好听|讲得(?:真|很|特别|挺|非常)?好)';
const post = new RegExp('^' + reference + target + positive + '(?:了|啊|呀|呢)?$', 'u');
const pre = new RegExp('^我(?:很|特别|非常|挺|真|好)?喜欢' + reference + target + '(?:啊|呀)?$', 'u');

export function explicitReplyApproval(text: string): 'story' | 'style' | undefined {
  const q = compact(text);
  if (!post.test(q) && !pre.test(q)) return;
  // A bare preference ("我喜欢故事") is about a category, not a particular answer.
  if (!/(?:刚才|刚刚|这|那|你(?:刚)?(?:讲|说)的)/u.test(q)) return;
  return /故事/u.test(q) && !/方式/u.test(q) ? 'story' : 'style';
}

function isStoryTurn(question: string, answer: string): boolean {
  if (/^(?:(?:好的|当然可以|没问题|可以|嗯)[，。！\s]*)*(?:$|抱歉|暂时不能|我(?:目前|暂时)?(?:不能|没法|无法)|你想听什么)/u.test(answer.trim())) return false;
  // A named storytelling request plus the user's own assessment works for short
  // stories, including ones with no conventional opening. Never infer genre from length.
  const q = compact(question);
  const requested = /(?:讲|说|编|写|听|来|读|念)[\p{Script=Han}]{0,25}(?:故事|童话|寓言)/u.test(q)
    && !/(?:不要|不想|别|不喜欢|为什么|有什么好处|分析|点评|评价|提纲|大纲|定义|是什么意思|如何|怎么讲|讲故事的)/u.test(q);
  return requested || /^(?:从前|很久很久以前|在很久很久以前|有一天[，,]|传说[，,])/u.test(answer.trim());
}

export class PersonalStoryFeedback {
  private readonly db: DatabaseSync;
  constructor(dataDir: string) {
    this.db = new DatabaseSync(join(dataDir,'profile.sqlite'));
    this.db.exec('PRAGMA busy_timeout=3000; BEGIN IMMEDIATE');
    try {
      const cols = this.db.prepare('PRAGMA table_info(growth_event)').all();
      for (const col of ['reply_msg_id','feedback_msg_id']) {
        if (!cols.some(c => c.name === col)) this.db.exec('ALTER TABLE growth_event ADD COLUMN ' + col + ' TEXT');
      }
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS personal_growth_reply ON growth_event(account_id,reply_msg_id,rule) WHERE reply_msg_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS personal_growth_feedback ON growth_event(account_id,feedback_msg_id,rule) WHERE feedback_msg_id IS NOT NULL; COMMIT`);
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  record(owner: string, question: ConversationItem, reply: ConversationItem, feedback: ConversationItem): void {
    const approval = explicitReplyApproval(feedback.text);
    if (!approval || explicitReplyApproval(question.text) || [question,reply,feedback].some(x =>
      x.account_id !== owner || x.session_id !== feedback.session_id || x.memory_excluded || isCrisisContent(x.text))
      || question.role !== 'user' || reply.role !== 'assistant' || feedback.role !== 'user'
      || feedback.ts < reply.ts) return;
    const story = isStoryTurn(question.text,reply.text);
    if (approval === 'story' && !story) return;
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const recorded = this.db.prepare('SELECT 1 FROM growth_event WHERE account_id=? AND (reply_msg_id=? OR feedback_msg_id=?) LIMIT 1')
        .get(owner,reply.id,feedback.id);
      if (!recorded) {
        const event = this.db.prepare(`INSERT INTO growth_event(id,account_id,ts,module,dimension,from_val,to_val,trigger_quote,rule,theory,note,reply_msg_id,feedback_msg_id)
          VALUES(?,?,?,?,?,?,?,?,?,'reinforcement',?,?,?)`);
        const exampleId = 'personal-fb-' + randomUUID();
        event.run(exampleId,owner,now,'style','讲法','','明确喜欢',feedback.text.slice(0,50),'explicit_style_feedback',
          '主人明确肯定同一通话内的上一条回答',reply.id,feedback.id);
        // The old latent vector dimensions had model-inferred valence and engagement.
        // This entry is explicitly chosen by the owner. Do not assign a guessed score.
        this.db.prepare(`INSERT INTO style_pool(id,account_id,vector,child_said,xiaoke_did,mass,created_at,last_used_at)
          VALUES(?,?,'[0,0,0,0]',?,?,2,?,?)`).run(exampleId,owner,question.text.slice(0,60),reply.text.slice(0,60),now,now);
        // Keep at most 30 new explicit examples. Pre-existing unverified examples are untouched.
        this.db.prepare(`DELETE FROM style_pool WHERE account_id=? AND id IN
          (SELECT id FROM style_pool WHERE account_id=? AND id LIKE 'personal-fb-%' ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET 30)`).run(owner,owner);
        if (story) {
          const from = traitStore.get(owner).storytelling;
          const to = clampTrait('storytelling',from + 0.02,traitStore.baselineFor(owner).storytelling);
          if (to > from + 1e-9 && traitStore.organicMovedToday(owner,'storytelling') + (to-from) <= DAILY_ORGANIC_CAP + 1e-9) {
            this.db.prepare(`INSERT INTO trait_state(account_id,storytelling,updated_at) VALUES(?,?,?)
              ON CONFLICT(account_id) DO UPDATE SET storytelling=excluded.storytelling,updated_at=excluded.updated_at`).run(owner,to,now);
            event.run(randomUUID(),owner,now,'trait',TRAIT_LABELS.storytelling,String(from),String(to),feedback.text.slice(0,50),'explicit_story_feedback',
              '主人明确肯定同一通话内的上一段故事',reply.id,feedback.id);
          }
        }
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}
