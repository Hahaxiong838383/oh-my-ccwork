#!/usr/bin/env python3
"""路 C 确定性块应用器：把 codex 出的 Search/Replace 块精确落盘。

设计要点（2026-06-17，team 三发评审收敛）：
- 把"落盘"从 cc 手动(易失真)变成脚本自动(确定性)——cc 只编排+判官,不碰落盘逻辑。
- Search/Replace 块格式(Aider 范式)不依赖行号,比 unified diff 鲁棒(评审实测 git apply <40%)。
- 原子性：先 dry-run 校验全部块可应用,全 OK 才真写;任一块匹配失败则零写入并报告,
  绝不半应用(半应用会让 repo 处于不一致中间态)。
- 匹配确定性：SEARCH 段在目标文件精确子串匹配。命中 0 次=not-found,>1 次=ambiguous,
  均判失败(不模糊猜测)——失败块连同文件现状回传 codex 重出,而非让 cc 手改。

块格式：
    FILE: <相对/绝对路径>
    <<<<<<< SEARCH
    <原文精确片段,空=新建文件>
    =======
    <新内容,空=删除该 SEARCH 段>
    >>>>>>> REPLACE

用法：apply-blocks.py <blocks-file> <repo-root>
输出：stdout 打印 JSON 报告 {applied:[...], failed:[{file,reason}], created:[...]}；
      全部成功 exit 0；有失败 exit 1（零写入）。
"""
import sys, os, json, re

S_START = '<<<<<<< SEARCH'
S_MID = '======='
S_END = '>>>>>>> REPLACE'


def parse_blocks(text):
    """解析块文本 → [{file, search, replace}]。格式错误抛 ValueError。"""
    blocks = []
    lines = text.split('\n')
    i, n = 0, len(lines)
    while i < n:
        line = lines[i]
        m = re.match(r'^FILE:\s*(.+?)\s*$', line)
        if not m:
            i += 1
            continue
        file_path = m.group(1).strip()
        # 下一非空行应是 SEARCH 起始
        i += 1
        while i < n and lines[i].strip() == '':
            i += 1
        if i >= n or lines[i].strip() != S_START:
            raise ValueError(f'FILE: {file_path} 后缺少 "{S_START}"')
        i += 1
        search_lines = []
        while i < n and lines[i].strip() != S_MID:
            search_lines.append(lines[i])
            i += 1
        if i >= n:
            raise ValueError(f'FILE: {file_path} 块缺少 "{S_MID}" 分隔')
        i += 1  # skip =======
        replace_lines = []
        while i < n and lines[i].strip() != S_END:
            replace_lines.append(lines[i])
            i += 1
        if i >= n:
            raise ValueError(f'FILE: {file_path} 块缺少 "{S_END}"')
        i += 1  # skip >>>>>>> REPLACE
        blocks.append({
            'file': file_path,
            'search': '\n'.join(search_lines),
            'replace': '\n'.join(replace_lines),
        })
    return blocks


def apply_blocks(blocks, repo_root):
    """两遍：先全量 dry 校验(内存模拟),全 OK 才写盘。返回报告 dict。"""
    # 内存态：file_path → 当前内容(None=不存在)
    cache = {}

    def load(fp):
        if fp not in cache:
            abs_p = os.path.join(repo_root, fp)
            cache[fp] = open(abs_p, encoding='utf-8').read() if os.path.exists(abs_p) else None
        return cache[fp]

    applied, failed, created = [], [], []
    # —— 第一遍：dry 校验 + 内存应用 ——
    for b in blocks:
        fp, search, replace = b['file'], b['search'], b['replace']
        content = load(fp)
        if search == '':  # 新建文件
            if content is not None:
                failed.append({'file': fp, 'reason': 'new-file-but-exists（SEARCH 空但文件已存在）'})
                continue
            cache[fp] = replace
            created.append(fp)
            continue
        if content is None:
            failed.append({'file': fp, 'reason': 'file-not-found（目标文件不存在）'})
            continue
        cnt = content.count(search)
        if cnt == 0:
            failed.append({'file': fp, 'reason': 'search-not-found（SEARCH 段在文件中未找到精确匹配）'})
            continue
        if cnt > 1:
            failed.append({'file': fp, 'reason': f'ambiguous（SEARCH 段匹配 {cnt} 处,需更长上下文唯一化）'})
            continue
        cache[fp] = content.replace(search, replace, 1)
        applied.append(fp)

    report = {'applied': applied, 'failed': failed, 'created': created}
    if failed:
        report['written'] = False  # 原子：有失败则零写入
        return report

    # —— 第二遍：真写盘（仅当零失败）——
    for fp in set(applied + created):
        abs_p = os.path.join(repo_root, fp)
        os.makedirs(os.path.dirname(abs_p), exist_ok=True) if os.path.dirname(abs_p) else None
        with open(abs_p, 'w', encoding='utf-8') as f:
            f.write(cache[fp])
    report['written'] = True
    return report


def main():
    if len(sys.argv) != 3:
        print('用法: apply-blocks.py <blocks-file> <repo-root>', file=sys.stderr)
        sys.exit(2)
    blocks_file, repo_root = sys.argv[1], sys.argv[2]
    text = open(blocks_file, encoding='utf-8').read()
    try:
        blocks = parse_blocks(text)
    except ValueError as e:
        print(json.dumps({'parse_error': str(e), 'written': False}, ensure_ascii=False))
        sys.exit(1)
    if not blocks:
        print(json.dumps({'parse_error': '未解析到任何 FILE/SEARCH/REPLACE 块', 'written': False}, ensure_ascii=False))
        sys.exit(1)
    report = apply_blocks(blocks, repo_root)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    sys.exit(0 if report.get('written') else 1)


if __name__ == '__main__':
    main()
