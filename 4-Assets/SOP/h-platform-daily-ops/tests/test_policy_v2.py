"""离线策略契约：仅读取本目录文本，不导入/运行真实探针。"""
from __future__ import annotations

import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
PROMPT = ROOT / "codeg-automation-prompt.txt"
README = ROOT / "README.md"

MEMORY_REFS = (
    "project_feishu_grok_h_byos",
    "feedback_tenant_capability_drift_mechanism",
    "feedback_identifier_shape_is_not_identity",
    "feedback_concurrent_sessions_shared_checkout",
)


class PolicyV2Test(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.prompt = PROMPT.read_text(encoding="utf-8")
        cls.readme = README.read_text(encoding="utf-8")

    def assert_tokens(self, text: str, *tokens: str) -> None:
        for token in tokens:
            with self.subTest(token=token):
                self.assertIn(token, text)

    def section(self, start: str, end: str) -> str:
        return self.prompt.split(start, 1)[1].split(end, 1)[0]

    def test_schedule_and_luna_are_explicit(self) -> None:
        self.assert_tokens(
            self.prompt, "Automation ID 4", "09:10 Asia/Shanghai",
            "agent=codex", "model=gpt-5.6-luna", "config_values.model",
            "cwd=/home/hahaxiong83/mycc", "isolation=shared_in_root",
            "2026-09-12",
        )
        self.assert_tokens(
            self.readme, "10 9 * * *", "gpt-5.6-luna",
            "config.config_values.model", "turn_context.payload.model",
        )

    def test_four_keys_use_canonical_a_not_stale_b(self) -> None:
        self.assert_tokens(
            self.prompt,
            "/home/hahaxiong83/.claude/projects/-home-hahaxiong83-mycc/memory/",
            *MEMORY_REFS, "未命中", "后续纠正", "B 历史镜像",
            "不得用它们替代 A", "不扫描无关项目",
        )
        self.assert_tokens(self.readme, *MEMORY_REFS)

    def test_one_existing_probe_and_fresh_v2_report(self) -> None:
        self.assert_tokens(
            self.prompt, "精确执行一次", "只调用这个既有入口一次",
            "/home/hahaxiong83/.local/bin/daily-readonly-check",
            "不另跑 checker", "不手动 SSH", "schemaVersion=2",
            "checkedAt 属于本次采集", "reportError", "巡检未完成",
            "旧 latest.json 不得冒充当前状态", "且不重跑",
        )

    def test_no_mutators_or_external_messages(self) -> None:
        self.assert_tokens(
            self.prompt, "禁止修改任何文件、数据库或任务",
            "禁止自动 attest / 补签", "禁止覆盖租户内容", "禁止部署",
            "禁止重启", "禁止发送外部消息", "禁止提交、推送",
            "只给命令不执行", "历史处置命令当成本轮授权",
        )

    def test_raw_severity_and_known_test_warning_are_preserved(self) -> None:
        self.assert_tokens(
            self.prompt, "levels{critical,warning,info}", "issues/details",
            "OK，已知项 N 条", "报告 WARNING", "报告 CRITICAL",
            "保留探针原始 status/levels", "探针 WARNING → 判读 CRITICAL",
            "不伪造探针 OK", "不要用“异常”“故障”描述这些 warning",
        )
        parity = self.section("tenant_parity_lag（warning）", "tenant_parity_notes（info）")
        self.assert_tokens(
            parity, "陈川测试bot/agent-method", "已知测试用例",
            "不要建议覆盖/追平", "不能推广到相似名称或其他 skill",
        )

    def test_egress_is_distinct_from_bot_connections(self) -> None:
        egress = self.section("egress_down（critical）", "control_release_drift（warning）")
        self.assert_tokens(
            egress, "连接数不是可用性证据", "自 downSince 起已 X 小时",
            "checkedAt", "[in-main -> tag]", "balancer", "不要动 bridge",
            "出口可用性未确认",
        )
        refresh = self.section("grok_refresh_failed（warning）", "其余 code")
        self.assert_tokens(refresh, "同一出口根因", "保留两个 code", "根因未确认")

    def test_control_release_is_evidence_gated(self) -> None:
        release = self.section("control_release_drift（warning）", "app_errors：")
        self.assert_tokens(
            release, "releaseId", "sourceCommit", "controlVersion",
            "有记忆/证据支撑", "H_CONTROL_SOURCE_COMMIT=<源提交>",
            "ops/attest-current-h-control-release.sh check", "同版本却 drifted",
            "源提交不明保留占位", "不执行 check 或 attest",
        )

    def test_errors_report_age_without_invented_identity(self) -> None:
        errors = self.section("app_errors：", "rpc_orphaned（critical）")
        self.assert_tokens(
            errors, "botName/uid", "先报年龄", "quota_window/auth",
            "24h 内 = critical", ">24h = warning 旧账",
            "时间未知写未确认并保留探针级别", "探针未给身份",
        )
        self.assert_tokens(self.prompt, "身份只认 details", "不是今日新事故")

    def test_rpc_fresh_stale_and_live_unknown_are_separate(self) -> None:
        rpc = self.section("rpc_orphaned（critical）", "tenant_parity_lag（warning）")
        self.assert_tokens(
            rpc, "details.fresh[]", "details.stale[]", "每10分钟自动回收",
            "连续两天仍在", "expiry.lastSweepAt", "rpc orphan sweep",
            "total - live", "total-live-liveUnknown", "live 缺失或 null 时不当0",
            "不直接认卡死", "不手改 durable", "不自行重跑",
        )

    def test_l2_and_site_boundaries_are_retained(self) -> None:
        self.assert_tokens(
            self.prompt, "L0 公司基线", "L1 部门与 L2 个人允许增量分叉",
            "Skills 差异不等于飞书 Bot 权限差异",
            "Mini 不在 dev198 tenant parity 的覆盖范围内",
            "智能助手_产品专家在 dev198", "AI 专家在 Mini",
            "实时 placement 未上报则本轮未验证",
        )

    def test_current_baseline_is_not_an_evergreen_threshold(self) -> None:
        self.assert_tokens(
            self.prompt, "v1.67.0", "20260911-170637-h-control-v1.67.0",
            "ba3c2bd", "Bot 18/18", "记忆17/17", "合法个性化4人6项",
            "不是永恒阈值", "作废旧基线", "未来正常新增租户、升级版本",
        )

    def test_runtime_source_migration_cannot_reinstall_v1(self) -> None:
        self.assert_tokens(
            self.readme, "feishu-grok-bridge 仓", "v1 归档",
            "不得覆盖现有 runtime", "ops/home-studio/h-platform-daily-ops.py",
            "ops/home-studio/daily-readonly-check", "ops/home-studio/install.sh",
            "本目录不再提供安装命令", "tests/test_contract.py",
            "禁止直写 SQLite", "完整 AutomationDraft",
        )
        self.assertNotIn("install -m ", self.readme)
        self.assertNotIn("systemctl --user daemon-reload", self.readme)


if __name__ == "__main__":
    unittest.main()
