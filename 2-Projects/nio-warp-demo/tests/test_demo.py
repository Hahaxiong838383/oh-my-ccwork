from pathlib import Path

from warp_demo.core import DemoConfig, run_demo


def test_software_closed_loop(tmp_path: Path) -> None:
    config = DemoConfig(
        screen_width=640,
        screen_height=144,
        canvas_width=640,
        canvas_height=208,
        footprint_width=600,
        footprint_height=192,
        control_cols=19,
        control_rows=9,
        sample_cols=41,
        sample_rows=17,
    )
    result = run_demo(tmp_path, config)

    assert result.passed
    assert (tmp_path / "contact_sheet.png").exists()
    assert (tmp_path / "acceptance_report.json").exists()
