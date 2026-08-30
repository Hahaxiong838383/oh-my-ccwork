# -*- mode: python ; coding: utf-8 -*-
# GestureDemo.spec - 打包 macOS .app
# 构建：.venv/bin/pyinstaller GestureDemo.spec --noconfirm
# 产物：dist/GestureDemo.app
from PyInstaller.utils.hooks import collect_all

# mediapipe 的 .tflite 模型和 .binarypb 图定义不在 wheel 的 py 文件里，
# 必须整包收集，否则运行时报找不到模型
mp_datas, mp_binaries, mp_hiddenimports = collect_all("mediapipe")

# v3.8：ptgaze 的 yaml 配置/归一化相机参数也在包数据里
pt_datas, pt_binaries, pt_hiddenimports = collect_all("ptgaze")

a = Analysis(
    ["app.py"],
    pathex=[],
    binaries=mp_binaries + pt_binaries,
    datas=mp_datas + pt_datas + [
        # v3.8 模型权重打进包（运行时 models/ 相对 _internal 根解析）
        ("models/face_landmarker.task", "models"),
        ("models/eth-xgaze_resnet18.safetensors", "models"),
        # --verify-backend 离线自检用测试人脸图
        ("assets/test_face.jpg", "assets"),
    ],
    hiddenimports=mp_hiddenimports + pt_hiddenimports,
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
    icon="assets/icon.icns",
    bundle_identifier="cc.chenchuan.gesturedemo",
    info_plist={
        "NSCameraUsageDescription": "手势拖拽 Demo 需要摄像头进行手部与注视追踪",
        "NSHighResolutionCapable": True,
        "LSMinimumSystemVersion": "12.0",
    },
)
