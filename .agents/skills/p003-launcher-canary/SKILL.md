---
name: p003-launcher-canary
description: Safely reverse, patch, rebuild, sign, install, validate, and roll back the P003 EyesCare system Launcher on RK3562. Use for FuturusLauncher.apk, apktool, jadx, smali hooks, classes3.dex injection, system UID signing, ADB Canary, crash recovery, VAD/MyJavis hooks, or P003 Godot Launcher deployment.
---

# P003 Launcher Canary

Use the versioned project skill as the single procedural source:

`/Users/fu-121/mycc/2-Projects/kidshub-ai---godot/skills/p003-launcher-canary/SKILL.md`

Then read its referenced workflow and the repository document:

`/Users/fu-121/mycc/2-Projects/kidshub-ai---godot/docs/LAUNCHER_APKTOOL_S2_PLAN.md`

Do not copy the full workflow into this entry point; keep one versioned source in the P003 code repository.

Current installed product baseline: `1.2.2-canary.54 (66)`, `140182503` bytes, APK SHA256 `f0fa37a80272cf39d9a2da8b2b38a0ec22cf59d876fd131e81a8b53d42254895`; product voice, MCU state readback, posture `800x600@30fps`, OTA P0 and device version UI pass. v65 is the immediate rollback. Product credentials live in Android Keystore; bootstrap and ADB reverse `38541/38542` must remain `0`. Never use `pm clear`, raw `adb uninstall`, or a temporary `android.uid.system` probe. For posture changes, require Camera, NV21, native inference and classifier dimensions to match, then run `/Users/fu-121/mycc/2-Projects/kidshub-ai---godot/scripts/run_posture_resolution_canary.sh`. Normal use assumes the product LED is on; weak-light is an LED-fault diagnostic. The classifier has no too-near threshold; keep that as a separate P1. For MCU readback, treat `0x010D=25 → 0x010E current=30 + lowestPoint=0xFF` as the verified mechanical minimum and never retry with a downward `0x010C` step. VAD version queries must wait for the short MCU OTA startup window to clear rather than poll UART or fabricate a version.
