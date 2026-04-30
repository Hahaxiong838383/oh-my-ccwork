# Skills 寮€鍙戞寚鍗?

Skills 鏄?Claude Code 鐨勫彲鎵╁睍鑳藉姏妯″潡銆?

## 浠€涔堟槸 Skill

Skill 鏄竴涓洰褰曪紝鍖呭惈 `SKILL.md` 鏂囦欢鍜屽彲閫夌殑璧勬簮鏂囦欢锛岀敤浜庢墿灞?CC 鐨勮兘鍔涳細
- **涓撲笟宸ヤ綔娴?*锛氬姝ラ鐨勯鍩熸祦绋?
- **宸ュ叿闆嗘垚**锛氱壒瀹氭枃浠舵牸寮忔垨 API 鐨勪娇鐢ㄦ柟娉?
- **棰嗗煙鐭ヨ瘑**锛氬叕鍙哥壒瀹氱煡璇嗐€乻chema銆佷笟鍔￠€昏緫
- **鎵撳寘璧勬簮**锛氳剼鏈€佸弬鑰冩枃妗ｃ€佽祫浜ф枃浠?

## 鐩綍缁撴瀯

```
skill-name/
鈹溾攢鈹€ SKILL.md          # 蹇呴』 - 鏍稿績鎸囦护
鈹斺攢鈹€ 鍙€夎祫婧?
    鈹溾攢鈹€ scripts/      # 鍙墽琛岃剼鏈紙Python/Bash锛?
    鈹溾攢鈹€ references/   # 鍙傝€冩枃妗ｏ紙鎸夐渶鍔犺浇锛?
    鈹斺攢鈹€ assets/       # 杈撳嚭璧勬簮锛堟ā鏉裤€佸浘鏍囷級
```

## SKILL.md 鏍煎紡

```yaml
---
name: skill-name
description: 鍋氫粈涔?+ 浠€涔堟椂鍊欒Е鍙戯紙杩欐槸鏈€閲嶈鐨勫瓧娈碉級
---

# Skill 鏍囬

[鎸囦护鍐呭]

## 瑙﹀彂璇?
- "鍏抽敭璇?"
- "鍏抽敭璇?"

## 鎵ц姝ラ
1. xxx
2. xxx

## 绀轰緥
[绀轰緥鐢ㄦ硶]
```

## 鍒涘缓鏂?Skill

1. 鍒涘缓鐩綍锛歚mkdir -p .claude/skills/浣犵殑skill鍚峘
2. 缂栧啓 `SKILL.md`
3. 娣诲姞鑴氭湰鎴栬祫婧愶紙濡傞渶瑕侊級
4. 娴嬭瘯瑙﹀彂璇嶆槸鍚︽湁鏁?

## 鏈粨搴撳寘鍚殑 Skill

| Skill | 鍔熻兘 | 瑙﹀彂璇?|
|-------|------|--------|
| `setup` | 棣栨浣跨敤寮曞锛屼氦浜掑紡瀹屾垚閰嶇疆 | `/setup` |
| `dashboard` | 鑳藉姏鐪嬫澘鍙鍖?| `/dashboard` |
| `skill-creator` | 甯姪鍒涘缓鏂扮殑 Skill | `/skill-creator` |
| `decision` | 鍐崇瓥璁板綍锛屼粠瀵硅瘽涓婁笅鏂囪嚜鍔ㄦ彁鍙栫敓鎴愮粨鏋勫寲鍐崇瓥鏉＄洰 | `/decision` |
| `candidate-interview-analysis` | 候选人面试分析、简历拆解、定制面试问答、评分标准与飞书文档输出 | `候选人分析` / `面试问答` |
| `goal-plan-p2` | 鍏徃&閮ㄩ棬鐩爣/璁″垝/浠诲姟绠＄悊琛紙P2锛夊叏灞€瑙勫垯涓庢牎楠?| `/goal-plan-p2` |
| `mycc` | 绉诲姩绔闂悗绔紝鍦ㄦ墜鏈轰笂浣跨敤 CC | `/mycc` |
| `feishu-mcp-setup` | 椋炰功 MCP 閰嶇疆寮曞锛屼粠闆堕厤缃?open-feishu-mcp | `/feishu-mcp-setup` |
| `feishu-ops` | 椋炰功鎿嶄綔鎵嬪唽锛屾枃妗?琛ㄦ牸/Wiki 鎿嶄綔鎸囧崡 | `/feishu-ops` |
| `rule-compress` | 万能公式 v1 规则压缩引擎，对散文式规则文件做 4 维优先级分析 + P0-P3 分层 + 索引下沉无损压缩 | `/rule-compress` |

### mycc - 绉诲姩绔闂?

璁╀綘鍦ㄦ墜鏈烘祻瑙堝櫒鎴栧井淇￠噷璁块棶鏈湴鐨?Claude Code銆?

**瀹夎渚濊禆**锛?
```bash
cd .claude/skills/mycc/scripts
npm install
```

**浣跨敤**锛?
```bash
# 鍦ㄤ綘鐨勯」鐩洰褰曚笅
/mycc
```

**骞冲彴鏀寔**锛歮acOS / Linux锛圵indows 鏆備笉鏀寔锛屽彲鐢?WSL锛?

## 鏇村璧勬簮

- [瀹樻柟 Skill 浠撳簱](https://github.com/anthropics/skills)


