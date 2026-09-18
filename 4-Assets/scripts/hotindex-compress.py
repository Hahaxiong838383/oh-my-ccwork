#!/usr/bin/env python3
"""hotindex-compress.py — 热索引三刀压缩（先搬再删，可证明零丢失）。

默认 dry-run：产物写 /tmp/hotindex/{MEMORY.new.md,sediment.json,report.md}，不碰任何记忆文件。
--write：先备份 MEMORY.md.bak.<date> → 逐文件原子追加「热索引沉淀」节 → 写新 MEMORY.md。
**只有验证器全绿才允许 --write**（含负向验证：故意删一个链接，验证器必须变红）。

不丢失的可执行定义：
  从 MEMORY.md 移出的每一段文本，逐字追加进该行链接的 topic 文件「## 热索引沉淀（日期）」节。
  验证器检查：① 原始链接全部仍在新文件或（降簇时）簇关键词 rg 能命中该 topic ② 手写压缩行的
  加粗片段 ⊂ 原行（没有编新关键词）③ rghint 每个词 rg 命中 topic ④ 沉淀文本 ⊂ 目标 topic（写后核）。

三刀：
  刀1 p003 长行 → 手写指针行（状态一句 + 回滚/开关锚 + rg 指引），原行沉淀
  刀2 ★教训行的 ≥20 字纯叙事括号（无加粗/代码/链接）→ 沉淀后删除
  刀3 5 条降簇（原行沉淀 + 簇加关键词）+ 5 条晋升（用 INDEX-full 行）
"""
import os, re, sys, json, shutil, datetime, subprocess

MEM_DIR = os.environ.get('HOTINDEX_MEM_DIR') or os.path.expanduser('~/.claude/projects/-home-hahaxiong83-mycc/memory')
M = os.path.join(MEM_DIR, 'MEMORY.md')
OUT = '/tmp/hotindex'
TODAY = datetime.date.today().isoformat()
SED_HEAD = f'## 热索引沉淀（{TODAY}）'
TRIPWIRE = 40 * 1024

LINK = re.compile(r'\[([^\]]+)\]\(([^)]+\.md)\)')
BOLD = re.compile(r'\*\*([^*]+?)\*\*')
PAREN_MIN = int(os.environ.get('HX_PAREN_MIN', '14'))   # 2026-09-18 定 14：20 档差 0.1KB 回不了线，14 档多沉淀 12 段例证/旁白（零丢失）
PAREN = re.compile(r'[（(]([^（）()]{%d,})[）)]' % PAREN_MIN)
RG_HINT = re.compile(r"rg\s+'([^']+)'")
CLUSTER = re.compile(r"^(- \*\*(.+?)\*\*\(~?\d+\)[：:].*?→\s*`rg\s+')(.+?)('`)\s*$")

# ── 刀1：手写压缩行（只列要压的；加粗片段必须来自原行，验证器会查） ──
CUT1 = {
 'p003_asr_nonstream': "- [p003_asr_nonstream](project_p003_asr_nonstream_canary.md) ★ — 二遍识别已全开；回滚=关env键；**热词双口径(一遍100tok/二遍5000词),canary走二遍勿按单口径判超** → rg 'canary|二遍|热词|词表'",
 'p003_dev_cmd_evolution': "- [p003_dev_cmd_evolution](project_p003_device_command_evolution.md) ★ — 设备命令三层漏斗在产(观察模式,chip_first=0)；v3.1 阶段 B 上产；电机问题端侧主责,cc 零开发 → rg 'device_ledger|chip_decision|revision 8|Ultra'",
 'p003_ota': "- [p003_ota](project_p003_ota.md) ★ — APK+PCK 双 OTA server 侧在产(八条 eligibility/身份门/fault 注入开关)；rolled_back 真值 from=恢复后现役 to=被放弃候选；坑:413 需专用 location/探针禁用真机 SN → rg 'eligibility|rolled_back|revoked|413|408|rpm-probe'",
 'p003_dev_config': "- [p003_dev_config](project_p003_device_config.md) ★ — 设备运行配置在产:**GET /v1/device/config凭据sub取SN**;revision=cfg-max单调;加域=CONFIG_KEYS加键不bump schema;**负测注入开关DEVICE_CONFIG_ACCEPTANCE_OVERRIDE(组装层字段改库造不出)** → rg 'CONFIG_KEYS|tombstone|DEVICE_CONFIG_ACCEPTANCE_OVERRIDE'",
 'p003_telemetry': "- [p003_telemetry](project_p003_telemetry.md) ★ — 遥测全链在产(三表+日聚合+parent查询+H5):**门序=注入→凭据→allowlist→限频→schema**;conflict=200+rejected非批级409;public_id零SN → rg 'eyeHealthRate|Retry-After|public_id|guarded|diaglog'",
 'p003_pairing': "- [p003_pairing](project_p003_pairing.md) ★ — 配网v4在产(SoftAP两阶段+nonce桥+ECIES):**salt=SHA256(nonce传输形态字符串UTF-8非解码bytes)**;**v1开关PAIRING_PROTOCOL_V1_ENABLED默认关**;v3后台预授权自动认领在产;凭据恢复S1上产 → rg 'preauth|announce|credentialView|bound_recoverable|RECOVERY_CONTRACT|force-rebind'",
 'p003_sms_auth': "- [p003_sms_auth](project_p003_sms_auth.md) ★ — 短信认证P0已上线:**账号cc-remote非hk-personal**;**家长端入口p003.hahaxiong.cc非kidshub-ai(SPA兜底假200)**;Spug主渠道,aliyun=回滚锚 → rg 'SMS_TEST_PHONE_ALLOWLIST|SMS_PROVIDER|ReturnVerifyCode|Spug|localStorage'",
 'p003_persona_growth': "- [p003_persona_growth](project_p003_persona_growth.md) ★ — 人格成长全线在产(M1-M6+特质向量+成长账本+admin tab);**风格模板选档=per-SN基线,003=funny/0002=quiet,E2E用0002防覆盖真机漂移**;**重置两档scope=persona保音频(执行前读端点实现,清单会膨胀)**;004=同事测试机未进名单 → rg 'persona-growth|local-audio|g1.settings|冻结槽|backchannel|附和词|release_todo'",
 'p003_filler_persona': "- [p003_filler_persona](project_p003_filler_persona.md) ★ — filler人格化F1在产;**F2前worker未消费听感不变**;barge桶永不人格化;colleague全局套=回滚锚 → rg 'filler|barge|colleague'",
 'p003_oneshot': "- [p003_oneshot](project_p003_oneshot.md) ★ — V1.1 One-shot 已封版,280 已全量;off=v272+ 普通回退(秒切);残项+机队底稿在 RELEASES.md;HANDOFF 在 topic 末尾 → rg 'oneshot|firstturn|ONESHOT_FIRST_TURN_POLICY|b104|b93-oneshot|end_candidate|RELEASES'",
}
# ── 刀3：降簇（文件 → 簇名, 关键词）；晋升（slug, 文件, 摘要≤160B） ──
CUT3_DEMOTE = {
 'feedback_queried_the_wrong_product_line.md': ('部署/基建', ['biz-region-id', 'cockpit']),
 'feedback_probe_parameters_are_facts_too.md': ('方法/汇报', ['参数错', '无响应']),
 'feedback_channel_exclusive_anchor_and_single_variable.md': ('语音/RTC', ['多通道', '对照实验', '意外成功']),
 'feedback_intermittent_fault_healthy_window.md': ('部署/基建', ['发作', '痛点驱动']),
 'feedback_probe_failed_so_it_doesnt_exist.md': ('隔离/凭据/agent', ['自动发现', '默认模型']),
 # 与 channel_exclusive_anchor 合写在同一行；评估器同样证据（跨 2 会话被检索 6 次）→ 一并降簇
 'feedback_locale_breaks_output_parsing.md': ('部署/基建', ['locale', 'journald']),
}
CUT3_PROMOTE = [
 ('deployed_source_of_truth', 'feedback_deployed_code_is_the_source_of_truth.md'),
 ('completeness_scope', 'feedback_completeness_signal_needs_scope_binding.md'),
 ('guard_can_be_hollow', 'feedback_guard_itself_can_be_hollow.md'),
 ('id_owned_by_two_systems', 'feedback_identifier_owned_by_two_systems.md'),
 ('accounting_vs_disk', 'feedback_accounting_must_match_disk_state.md'),
]

def index_gist(f, limit=160):
    for line in open(os.path.join(MEM_DIR, 'INDEX-full.md'), errors='replace'):
        if f'({f})' in line and ' — ' in line:
            g = line.rstrip('\n').split(' — ', 1)[1]
            gb = g.encode()[:limit].decode('utf-8', 'ignore').rstrip('，,、；;。 ')
            return gb + ('…' if len(g.encode()) > limit else '')
    return None

def secondary_row(links):
    """降簇行若合写了多条教训，主链接降簇，其余链接保留成一行紧凑指针（gist 用 INDEX-full）。"""
    parts = []
    for slug, f in links:
        if f in CUT3_DEMOTE: continue   # 它自己也降簇，走簇关键词
        g = index_gist(f, 80)
        parts.append(f"[{slug}]({f}) — {g}" if g else f"[{slug}]({f})")
    return ("- " + " ／ ".join(parts)) if parts else None

def rg_hits(kw, f):
    r = subprocess.run(['rg', '-qiF', '--', kw, os.path.join(MEM_DIR, f)])
    return r.returncode == 0

def transform(lines):
    """返回 (new_lines, sediment{file:[text]}, log[])"""
    sed = {}; log = []
    def add(f, text, why):
        sed.setdefault(f, []).append(text); log.append((why, f, len(text.encode())))
    out = []; section = None
    promoted_inserted = False
    for line in lines:
        if line.startswith('## '):
            # 在离开 ★教训 区前插入晋升行
            if section == 'les' and not promoted_inserted:
                for slug, f in CUT3_PROMOTE:
                    g = index_gist(f, 80)
                    if g: out.append(f"- [{slug}]({f}) — {g}"); log.append(('promote', f, 0))
                promoted_inserted = True
            section = ('proj' if '★ 项目' in line else 'les' if '★ 教训' in line
                       else 'cluster' if '场景簇' in line else 'other')
            out.append(line); continue
        if not line.startswith('- '):
            # 头部审计行
            # 审计信息已并入头部「🧭 项目行判据」行（2026-09-18），不再另起一行
            out.append(line); continue
        links = LINK.findall(line)
        # 刀1
        if section == 'proj' and links and links[0][0] in CUT1:
            add(links[0][1], line, 'cut1'); out.append(CUT1[links[0][0]]); continue
        # 刀3 降簇
        if section == 'les' and links and links[0][1] in CUT3_DEMOTE:
            add(links[0][1], line, 'demote')
            if len(links) > 1:
                sr = secondary_row(links[1:])
                if sr: out.append(sr); log.append(('demote_keep', links[0][1], 0))
            continue
        # 刀2
        if section == 'les' and links:
            body_new = line
            # ⚠️ 首版在掩码后的 inner 上查 '['，链接已被换成 XXXX 永远查不到，
            # 于是把含 [soft_constraint_promoted_to_gate](…) 的括号整段删了→验证器抓到「链接丢失」。
            # 判断一律用原文 span；规则泛化：括号里只留加粗与链接，叙事沉淀；含反引号（代码/术语）整段不动。
            for m in list(PAREN.finditer(LINK.sub(lambda x: 'X' * len(x.group(0)), line))):
                span = line[m.start():m.end()]
                if '`' in span: continue
                keep = re.findall(r'\*\*[^*]+?\*\*|\[[^\]]+\]\([^)]+\.md\)', span)
                if keep:
                    repl = '(' + '/'.join(keep) + ')'
                    if len(repl.encode()) >= len(span.encode()) - 10: continue
                    add(links[0][1], span, 'cut2b'); body_new = body_new.replace(span, repl, 1)
                else:
                    add(links[0][1], span, 'cut2'); body_new = body_new.replace(span, '', 1)
            body_new = re.sub(r'[;；,，]{2,}', '；', body_new).replace(' ;', ';').rstrip('；;,， ')
            out.append(body_new); continue
        # 刀3 簇加关键词
        if section == 'cluster':
            cm = CLUSTER.match(line)
            if cm:
                name = cm.group(2); extra = [k for f, (c, kws) in CUT3_DEMOTE.items() if c == name for k in kws]
                if extra:
                    cur = cm.group(3).split('|')
                    merged = cur + [k for k in extra if k not in cur]
                    out.append(cm.group(1) + '|'.join(merged) + cm.group(4)); continue
        out.append(line)
    return out, sed, log

def verify(old_lines, new_lines, sed, strict_sed=False):
    """返回 (ok, problems[])。strict_sed=True 时还检查沉淀文本已在 topic 文件里（写后核）。"""
    P = []
    def kw_hit(k, f):
        # 原热索引里有的 rghint 词只在热索引出现、topic 没有（9-17 冻结槽 那类）——沉淀原行后 rg 就能命中
        return rg_hits(k, f) or any(k.lower() in t.lower() for t in sed.get(f, []))
    old_text = '\n'.join(old_lines); new_text = '\n'.join(new_lines)
    old_links = {f for _, f in LINK.findall(old_text)}
    new_links = {f for _, f in LINK.findall(new_text)}
    # ① 链接：仍在，或降簇且簇关键词能 rg 命中
    for f in old_links - new_links:
        if f in CUT3_DEMOTE:
            c, kws = CUT3_DEMOTE[f]
            miss = [k for k in kws if not kw_hit(k, f)]
            if miss: P.append(f"降簇 {f}: 关键词 {miss} 在 topic 里零命中")
            if not any(re.search(r'\*\*' + re.escape(c) + r'\*\*', l) and all(k in l for k in kws) for l in new_lines):
                P.append(f"降簇 {f}: 簇「{c}」行里没找到全部关键词 {kws}")
        else:
            P.append(f"链接丢失: {f}")
    # ② 刀1 加粗 ⊂ 原行；rghint 命中
    old_by_slug = {LINK.findall(l)[0][0]: l for l in old_lines if l.startswith('- ') and LINK.findall(l)}
    for slug, row in CUT1.items():
        orig = old_by_slug.get(slug)
        if not orig: P.append(f"刀1 {slug}: 原行不存在"); continue
        if LINK.findall(row)[0] != LINK.findall(orig)[0]: P.append(f"刀1 {slug}: 链接被改")
        for lf in {f for _, f in LINK.findall(orig)} - {f for _, f in LINK.findall(row)}:
            P.append(f"刀1 {slug}: 原行次级链接 {lf} 在新行丢失")
        for b in BOLD.findall(row):
            if b not in orig: P.append(f"刀1 {slug}: 加粗「{b[:40]}」不在原行（编了新关键词）")
        f = LINK.findall(row)[0][1]
        for m in RG_HINT.finditer(row):
            for k in m.group(1).split('|'):
                if not kw_hit(k, f): P.append(f"刀1 {slug}: rghint 词「{k}」在 {f} 及待沉淀文本均零命中")
    # ③ 沉淀目标存在；strict 时文本已在文件里
    for f, texts in sed.items():
        p = os.path.join(MEM_DIR, f)
        if not os.path.exists(p): P.append(f"沉淀目标不存在: {f}"); continue
        if strict_sed:
            body = open(p, errors='replace').read()
            for t in texts:
                if t not in body: P.append(f"沉淀未落盘: {f} ← {t[:40]}")
    # ④ 字节
    nb = len(new_text.encode())
    if nb > TRIPWIRE: P.append(f"仍超绊线: {nb/1024:.1f} KB > 40 KB")
    return (not P), P

def rollback(date_tag):
    """--rollback YYYYMMDD：MEMORY.md 从 .bak 恢复；各 topic 文件截掉「## 热索引沉淀（YYYY-MM-DD）」节（它总在文件末尾）。
    只归一化末尾为单个换行，与原文可能差一个空行（markdown 无影响）。"""
    bak = M + f'.bak.{date_tag}'
    if not os.path.exists(bak): print(f"❌ 找不到备份 {bak}"); sys.exit(4)
    head = f"## 热索引沉淀（{date_tag[:4]}-{date_tag[4:6]}-{date_tag[6:]}）"
    n = 0
    for fp in sorted(os.listdir(MEM_DIR)):
        if not fp.endswith('.md') or fp in ('MEMORY.md', 'INDEX-full.md'): continue
        p = os.path.join(MEM_DIR, fp); body = open(p, encoding='utf-8', errors='replace').read()
        i = body.find('\n' + head + '\n')
        if i < 0: continue
        tmp = p + '.tmp'; open(tmp, 'w', encoding='utf-8').write(body[:i].rstrip('\n') + '\n'); os.replace(tmp, p); n += 1
    shutil.copy2(bak, M)
    print(f"回滚完成：MEMORY.md ← {os.path.basename(bak)}；{n} 个 topic 文件截掉沉淀节。")

def main():
    if '--rollback' in sys.argv:
        rollback(sys.argv[sys.argv.index('--rollback') + 1]); return
    os.makedirs(OUT, exist_ok=True)
    # CAS：记下读取时的 mtime，写前再比。2026-09-18 14:44 写入后 21:06 被另一会话整文件写回旧版；
    # hook 层有 hotindex-write-guard 守门，脚本自身再守一道（hook 只管 cc，脚本可能被别的方式调起）。
    seen_mtime = os.stat(M).st_mtime_ns
    old = open(M, encoding='utf-8').read().split('\n')
    new, sed, log = transform(old)
    ok, probs = verify(old, new, sed)
    # 负向验证：删掉一个非降簇链接，验证器必须变红
    mut = [l for l in new]
    for i, l in enumerate(mut):
        if l.startswith('- ') and LINK.findall(l) and LINK.findall(l)[0][1] not in CUT3_DEMOTE and 'p003_ota' in l:
            mut[i] = LINK.sub('', l, 1); break
    neg_ok, neg_probs = verify(old, mut, sed)
    negative_pass = (not neg_ok) and any('链接丢失' in p for p in neg_probs)

    ob, nb = len('\n'.join(old).encode()), len('\n'.join(new).encode())
    sedb = sum(len(t.encode()) for ts in sed.values() for t in ts)
    R = []
    R.append(f"# 三刀 dry-run 报告 {datetime.datetime.now().astimezone():%Y-%m-%d %H:%M %Z}\n")
    R.append(f"| 项 | 值 |\n|---|---:|")
    R.append(f"| 原 MEMORY.md | {ob/1024:.1f} KB / {len(old)} 行 |")
    R.append(f"| 新 MEMORY.md | **{nb/1024:.1f} KB** / {len(new)} 行 |")
    R.append(f"| 省 | {(ob-nb)/1024:.1f} KB ({(ob-nb)/ob:.0%}) |")
    R.append(f"| 绊线 | 40 KB → {'✅ 线内，余量 %.1f KB' % ((TRIPWIRE-nb)/1024) if nb<=TRIPWIRE else '❌ 仍超'} |")
    R.append(f"| 沉淀 | {sum(len(v) for v in sed.values())} 段 / {sedb/1024:.1f} KB → {len(sed)} 个 topic 文件 |")
    from collections import Counter
    c = Counter(w for w, _, _ in log)
    R.append(f"| 刀1 压行 | {c['cut1']} |\n| 刀2 纯叙事括号沉淀 | {c['cut2']} |\n| 刀2b 含加粗括号→只留加粗 | {c['cut2b']} |\n| 刀3 降簇 | {c['demote']}（其中 {c['demote_keep']} 行保留了次级链接） |\n| 刀3 晋升 | {c['promote']} |")
    keep_rows = [l for l in new if l.startswith('- [') and ' ／ ' in l and l not in old]
    if keep_rows:
        R.append("\n## 降簇后保留的次级链接行（自动生成，gist 来自 INDEX-full）")
        for l in keep_rows: R.append(f"- `{l[:150]}…`" if len(l) > 150 else f"- `{l}`")
    R.append(f"\n## 验证器\n- 正向（链接/加粗/rghint/沉淀目标/字节）：{'✅ 全绿' if ok else '❌ ' + str(len(probs)) + ' 项'}")
    for p in probs: R.append(f"  - {p}")
    R.append(f"- 负向（故意删 p003_ota 链接）：{'✅ 验证器变红，能抓' if negative_pass else '❌ 验证器没变红，验证器不可信'}")
    R.append(f"\n## 沉淀去向\n| topic | 段 | 字节 |\n|---|---:|---:|")
    for f, ts in sorted(sed.items(), key=lambda x: -sum(len(t.encode()) for t in x[1])):
        R.append(f"| `{f}` | {len(ts)} | {sum(len(t.encode()) for t in ts)} |")
    open(os.path.join(OUT, 'MEMORY.new.md'), 'w', encoding='utf-8').write('\n'.join(new))
    json.dump(sed, open(os.path.join(OUT, 'sediment.json'), 'w'), ensure_ascii=False, indent=1)
    open(os.path.join(OUT, 'report.md'), 'w', encoding='utf-8').write('\n'.join(R))
    print('\n'.join(R))
    gate = ok and negative_pass
    if '--write' in sys.argv:
        if not gate:
            print("\n❌ 验证未全绿，拒绝写入。"); sys.exit(2)
        if os.stat(M).st_mtime_ns != seen_mtime:
            print("\n❌ MEMORY.md 在本脚本读取后被改过（并发会话），拒绝写入。重跑即可（会基于最新内容重新计算）。"); sys.exit(5)
        bak = M + f'.bak.{TODAY.replace("-", "")}'
        if os.path.exists(bak):
            bak = M + f'.bak.{TODAY.replace("-", "")}-{datetime.datetime.now():%H%M%S}'
        shutil.copy2(M, bak)
        for f, texts in sed.items():
            p = os.path.join(MEM_DIR, f)
            body = open(p, encoding='utf-8', errors='replace').read()
            block = ('\n' if body.endswith('\n') else '\n\n') + SED_HEAD + '\n> 热索引压缩时从 MEMORY.md 移出的原文，逐字保留；热索引里只留指针。\n' + '\n'.join(('- ' + t) if not t.startswith('- ') else t for t in texts) + '\n'
            tmp = p + '.tmp'; open(tmp, 'w', encoding='utf-8').write(body + block); os.replace(tmp, p)
        tmp = M + '.tmp'; open(tmp, 'w', encoding='utf-8').write('\n'.join(new)); os.replace(tmp, M)
        ok2, probs2 = verify(old, open(M, encoding='utf-8').read().split('\n'), sed, strict_sed=True)
        print(f"\n写入完成。备份 {bak}。写后复核（含沉淀落盘）：{'✅ 全绿' if ok2 else '❌ ' + str(probs2)}")
        sys.exit(0 if ok2 else 3)
    sys.exit(0 if gate else 1)

if __name__ == '__main__':
    main()
