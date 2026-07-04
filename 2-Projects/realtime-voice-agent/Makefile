# realtime-voice-agent — 常用命令
.PHONY: help install dev test lint typecheck check run run-livekit m0-smoke clean tree

help:
	@echo "install    安装包(可编辑)"
	@echo "dev        安装 + dev 依赖(pytest/ruff/mypy)"
	@echo "test       跑测试"
	@echo "lint       ruff 检查"
	@echo "typecheck  mypy 类型检查"
	@echo "check      lint + typecheck + test(交付前双门)"
	@echo "run        启动应用入口(骨架:打印组装结果)"
	@echo "run-livekit 启动 M0 LiveKit worker(需 .env 真值)"
	@echo "m0-smoke   跑 M0 离线契约验收"
	@echo "tree       打印源码树"

install:
	pip install -e .

dev:
	pip install -e ".[dev]"

test:
	pytest

lint:
	ruff check src tests

typecheck:
	mypy

check: lint typecheck test

run:
	python -m voice_agent.app

run-livekit:
	python -m voice_agent.app livekit dev

m0-smoke:
	python scripts/m0_smoke.py

clean:
	rm -rf build dist *.egg-info .pytest_cache .mypy_cache .ruff_cache
	find . -type d -name __pycache__ -exec rm -rf {} +

tree:
	find src tests -type f -name '*.py' | sort
