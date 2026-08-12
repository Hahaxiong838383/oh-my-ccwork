from __future__ import annotations

import argparse
from pathlib import Path

from .core import DemoConfig, run_demo


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="运行全反射面预畸变最小闭环 Demo")
    parser.add_argument("--output", type=Path, default=Path("artifacts/latest"), help="输出目录")
    parser.add_argument("--canvas-height", type=int, default=520, help="虚拟画布高度")
    parser.add_argument("--strict", action="store_true", help="验收失败时返回非零状态")
    return parser


def main() -> None:
    args = _parser().parse_args()
    config = DemoConfig(canvas_height=args.canvas_height)
    result = run_demo(args.output.resolve(), config)
    print(f"输出目录：{args.output.resolve()}")
    print(f"全反射区域覆盖率：{result.coverage_ratio:.2%}")
    print(f"平均像素误差：{result.mean_absolute_error:.3f}")
    print(f"P95 像素误差：{result.p95_absolute_error:.3f}")
    print(f"UV 越界比例：{result.invalid_uv_ratio:.3%}")
    print(f"验收结果：{'通过' if result.passed else '未通过'}")
    if args.strict and not result.passed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
