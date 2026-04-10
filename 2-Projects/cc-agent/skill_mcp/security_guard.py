"""
安全扫描器
检测危险命令、硬编码密钥、Prompt Injection 等风险内容
"""

import re
from dataclasses import dataclass, field
from typing import List


@dataclass
class ScanResult:
    """扫描结果"""
    status: str                          # pass / warn / block
    risk_level: str                      # low / medium / high / critical
    dangerous_commands: List[str] = field(default_factory=list)
    secrets: List[str] = field(default_factory=list)
    prompt_injection: List[str] = field(default_factory=list)
    findings: List[str] = field(default_factory=list)


# ─── 危险命令模式 ───────────────────────────────────────────────────────────────
_DANGEROUS_CMD_PATTERNS = [
    # 删除类
    (r"\brm\s+-[rf]{1,3}\s+/", "危险删除: rm -rf /"),
    (r"\brm\s+--no-preserve-root", "危险删除: --no-preserve-root"),
    # 格式化
    (r"\bmkfs\b", "格式化命令: mkfs"),
    (r"\bdd\b.+\bif=/dev/zero\b", "磁盘清零: dd if=/dev/zero"),
    (r"\bshred\b", "磁盘粉碎: shred"),
    # 网络提权
    (r"\bcurl\b.+\|\s*(sudo\s+)?bash", "管道执行远程脚本: curl|bash"),
    (r"\bwget\b.+\|\s*(sudo\s+)?bash", "管道执行远程脚本: wget|bash"),
    # 反弹 shell
    (r"bash\s+-i\s+>&\s*/dev/tcp/", "反弹 shell"),
    (r"\bnc\b.+\b-e\b.+bash", "netcat 反弹 shell"),
    # 提权
    (r"\bchmod\s+[0-9]*7[0-9]*\s+/etc/(passwd|shadow|sudoers)", "提权文件权限修改"),
    (r"\bsudo\s+su\b", "sudo su 提权"),
    # 加密勒索特征
    (r"\bopenssl\b.+\benc\b.+-pass\b.+-in\b", "批量加密文件"),
]

# ─── 密钥 / 敏感信息模式 ────────────────────────────────────────────────────────
_SECRET_PATTERNS = [
    (r"(?i)(api_key|apikey|api-key)\s*[:=]\s*['\"]?[A-Za-z0-9_\-]{20,}['\"]?", "API Key"),
    (r"(?i)(secret|password|passwd|pwd)\s*[:=]\s*['\"]?.{8,}['\"]?", "密码/Secret"),
    (r"(?i)(token|access_token|auth_token)\s*[:=]\s*['\"]?[A-Za-z0-9_\-\.]{20,}['\"]?", "Token"),
    (r"sk-[A-Za-z0-9]{32,}", "OpenAI API Key"),
    (r"sk-ant-[A-Za-z0-9\-_]{20,}", "Anthropic API Key"),
    (r"AIza[A-Za-z0-9\-_]{35}", "Google API Key"),
    (r"(?i)aws_access_key_id\s*[:=]\s*[A-Z0-9]{20}", "AWS Access Key"),
    (r"(?i)aws_secret_access_key\s*[:=]\s*[A-Za-z0-9+/]{40}", "AWS Secret Key"),
    # 内网地址（warn 级别，不 block）
    (r"\b192\.168\.\d+\.\d+\b", "内网 IP 地址"),
    (r"\b10\.\d+\.\d+\.\d+\b", "内网 IP 地址"),
]

# ─── Prompt Injection 特征 ───────────────────────────────────────────────────────
_INJECTION_PATTERNS = [
    (r"(?i)ignore\s+(all\s+)?previous\s+instructions?", "忽略先前指令"),
    (r"(?i)disregard\s+(all\s+)?previous\s+instructions?", "无视先前指令"),
    (r"(?i)you\s+are\s+now\s+(a\s+)?DAN", "DAN 越狱"),
    (r"(?i)act\s+as\s+(if\s+)?you\s+(have\s+no\s+restrictions|are\s+unrestricted)", "去限制指令"),
    (r"(?i)(system|assistant)\s*:\s*you\s+(must|should|shall)\s+(always|never)", "伪造 system 消息"),
    (r"(?i)jailbreak", "Jailbreak 关键词"),
    (r"<\|im_start\|>|<\|im_end\|>", "ChatML 注入标记"),
    (r"\[INST\]|\[/INST\]", "Llama 指令注入标记"),
]


def scan_content(content: str) -> ScanResult:
    """
    扫描内容中的安全风险。

    返回 ScanResult：
    - status: pass（无问题）/ warn（有警告）/ block（阻断）
    - risk_level: low / medium / high / critical
    """
    dangerous_commands = []
    secrets = []
    prompt_injection = []
    findings = []

    # 检测危险命令
    for pattern, label in _DANGEROUS_CMD_PATTERNS:
        if re.search(pattern, content):
            dangerous_commands.append(label)
            findings.append(f"[危险命令] {label}")

    # 检测密钥/敏感信息
    for pattern, label in _SECRET_PATTERNS:
        if re.search(pattern, content):
            secrets.append(label)
            findings.append(f"[敏感信息] {label}")

    # 检测 Prompt Injection
    for pattern, label in _INJECTION_PATTERNS:
        if re.search(pattern, content):
            prompt_injection.append(label)
            findings.append(f"[注入攻击] {label}")

    # 计算风险等级和 status
    has_dangerous = len(dangerous_commands) > 0
    has_injection = len(prompt_injection) > 0

    # 内网 IP 单独降级处理（只 warn）
    real_secrets = [s for s in secrets if "内网 IP" not in s]

    if has_dangerous or has_injection or len(real_secrets) > 0:
        status = "block"
        risk_level = "critical" if has_dangerous or has_injection else "high"
    elif len(secrets) > 0:
        # 仅内网 IP 等低风险敏感信息
        status = "warn"
        risk_level = "medium"
    else:
        status = "pass"
        risk_level = "low"

    return ScanResult(
        status=status,
        risk_level=risk_level,
        dangerous_commands=dangerous_commands,
        secrets=secrets,
        prompt_injection=prompt_injection,
        findings=findings,
    )
