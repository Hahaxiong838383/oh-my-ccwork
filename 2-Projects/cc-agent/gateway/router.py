"""
Task Router - 按任务类型/Agent 解析目标模型
加载 models.yml，静态配置，启动时读一次
"""
import os
import yaml
from pathlib import Path
from dataclasses import dataclass
from typing import Optional


@dataclass
class RouteResult:
    model: str
    fallback: Optional[str]
    source: str  # "explicit" | "task_rule" | "agent_rule" | "default"


class TaskRouter:
    def __init__(self, config_path: Optional[str] = None):
        if config_path is None:
            config_path = Path(__file__).parent / "models.yml"
        self._config = self._load_config(str(config_path))

    def _load_config(self, path: str) -> dict:
        with open(path, "r", encoding="utf-8") as f:
            raw = f.read()
        # 替换环境变量占位符
        api_key = os.environ.get("ONE_API_KEY", "")
        raw = raw.replace("${ONE_API_KEY}", api_key)
        return yaml.safe_load(raw)

    @property
    def base_url(self) -> str:
        return self._config["one_api_base"]

    @property
    def api_key(self) -> str:
        return self._config["one_api_key"]

    def resolve_model(
        self,
        task_type: Optional[str] = None,
        agent: Optional[str] = None,
        model: Optional[str] = None,
    ) -> RouteResult:
        """
        解析目标模型，优先级：显式指定 > task_type 规则 > agent 规则 > 默认
        """
        # 1. 显式指定 model（覆盖所有路由规则）
        if model:
            return RouteResult(model=model, fallback=None, source="explicit")

        routing = self._config.get("routing", {})
        agents = self._config.get("agents", {})

        # 2. task_type 路由规则
        if task_type:
            rules = routing.get("rules", {})
            if task_type in rules:
                rule = rules[task_type]
                return RouteResult(
                    model=rule["model"],
                    fallback=rule.get("fallback"),
                    source="task_rule",
                )

        # 3. agent 路由规则
        if agent:
            if agent in agents:
                ag = agents[agent]
                return RouteResult(
                    model=ag["model"],
                    fallback=ag.get("fallback"),
                    source="agent_rule",
                )

        # 4. 默认模型
        default = routing.get("default", "deepseek-chat")
        return RouteResult(model=default, fallback=None, source="default")

    def list_routes(self) -> dict:
        """返回所有路由配置，用于 llm_models 工具"""
        return {
            "base_url": self.base_url,
            "routing": self._config.get("routing", {}),
            "agents": self._config.get("agents", {}),
        }


# 模块级单例，避免重复加载配置文件
_router: Optional[TaskRouter] = None


def get_router() -> TaskRouter:
    global _router
    if _router is None:
        _router = TaskRouter()
    return _router
