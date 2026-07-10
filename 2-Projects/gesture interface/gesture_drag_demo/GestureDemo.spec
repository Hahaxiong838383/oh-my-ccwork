# -*- mode: python ; coding: utf-8 -*-
# GestureDemo.spec - 打包 macOS .app
# 构建：.venv/bin/pyinstaller GestureDemo.spec --noconfirm
# 产物：dist/GestureDemo.app
from PyInstaller.utils.hooks import collect_all

# mediapipe 的 .tflite 模型和 .binarypb 图定义不在 wheel 的 py 文件里，
# 必须整包收集，否则运行时报找不到模型
mp_datas, mp_binaries, mp_hiddenimports = collect_all("mediapipe")

a = Analysis(
    ["app.py"],
    pathex=[],
    binaries=mp_binaries,
    datas=mp_datas,
    hiddenimports=mp_hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    exclude_binaries=True,
    name="GestureDemo",
    console=False,
    upx=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    name="GestureDemo",
    upx=False,
)

app = BUNDLE(
    coll,
    name="GestureDemo.app",
    icon=None,
    bundle_identifier="cc.chenchuan.gesturedemo",
    info_plist={
        "NSCameraUsageDescription": "手势拖拽 Demo 需要摄像头进行手部与注视追踪",
        "NSHighResolutionCapable": True,
        "LSMinimumSystemVersion": "12.0",
    },
)
