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

Current device baselines are model-specific: primary 003 Ultra is `1.2.2-canary.58 (70)`, SHA256 `332171b3...deb3`, with v69 rollback at `artifacts/rollback/welcome-v69-20260821-175241/rollback.sh`; second 0010 Max is `1.2.2-canary.60 (72)`, SHA256 `357454d8...4fce`, with v71 rollback at `artifacts/second-device/D160X65140100046/20260821-0010-v72-max-height/rollback.sh`. Max uses `2.0m` as its lowest display; Ultra uses `2.5m`. Max-only lowest-point raw `0xEE` means unsupported query, so display the current Byte5 height with a degraded hint instead of an error. Product voice, MCU state readback, posture `800x600@30fps`, OTA P0, device version UI and automatic welcome remain protected. Product credentials live in Android Keystore; bootstrap and ADB reverse `38541/38542` must remain `0`. Never use `pm clear`, raw `adb uninstall`, or a temporary `android.uid.system` probe. For posture changes, require Camera, NV21, native inference and classifier dimensions to match, then run `/Users/fu-121/mycc/2-Projects/kidshub-ai---godot/scripts/run_posture_resolution_canary.sh`. Posture cooldown priority is debug override → trusted `/v1/device/config` cache → built-in `900s`; accept only schema 1, non-empty revision and `10..86400s`, and never log the Bearer credential. For MCU readback, treat `0x010D=25 → 0x010E current=30 + lowestPoint=0xFF` as the verified Ultra mechanical minimum and never retry with a downward `0x010C` step. VAD version queries must wait for the short MCU OTA startup window to clear rather than poll UART or fabricate a version. OTA/device version fields must use authoritative readback and display `未读取到` when absent; active APK verification is `pm path + aapt + SHA256`, never a mixed `dumpsys package` version. Full signed APK remains the authoritative artifact and fallback; a later delta path is exact-SHA, single-hop and must reconstruct the byte-identical signed target before normal install. Do not migrate this Launcher to Split/AAB or add Java/Kotlin/DEX hot patching; follow `/Users/fu-121/mycc/2-Projects/kidshub-ai---godot/docs/P003_OTA_DELTA_SPLIT_HOT_UPDATE_STRATEGY_20260821.md`.
