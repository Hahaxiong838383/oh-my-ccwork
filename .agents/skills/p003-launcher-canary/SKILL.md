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

Current installed product baseline: `1.2.2-canary.57 (69)`, `140223463` bytes, APK SHA256 `f847f4850a9fe2159c83a1a5a2e933ba2b2219b9aa19011a5ff703543ca68b2a`; v68 SHA256 `671a1dfaa4f9a4126049f2d58411526c20020f43c430e3453c7c8f85c230add9` is the immediate rollback. Product voice, MCU state readback, posture `800x600@30fps`, OTA P0 and device version UI pass. Posture is driven by debounced MCU presence, requires two abnormal rounds before Android-local speech, keeps majority-no-face confirmation silent, and uses `CENTER_Y_MIN=0.10`. Cooldown priority is debug override → trusted `/v1/device/config` cache → built-in `900s`; accept only schema 1, non-empty revision and `10..86400s`, and never log the Bearer credential. The field matrix is accepted: illegal `5s`, empty revision and schema `2` are rejected while preserving `cfg-2/900s`; restored production returns `UNCHANGED`, with six services and zero fatal errors every round. Product credentials live in Android Keystore; bootstrap and ADB reverse `38541/38542` must remain `0`. Never use `pm clear`, raw `adb uninstall`, or a temporary `android.uid.system` probe. For posture changes, require Camera, NV21, native inference and classifier dimensions to match, then run `/Users/fu-121/mycc/2-Projects/kidshub-ai---godot/scripts/run_posture_resolution_canary.sh`. Normal use assumes the product LED is on; weak-light is an LED-fault diagnostic. The classifier has no too-near threshold; keep that as a separate P1. For MCU readback, treat `0x010D=25 → 0x010E current=30 + lowestPoint=0xFF` as the verified mechanical minimum and never retry with a downward `0x010C` step. VAD version queries must wait for the short MCU OTA startup window to clear rather than poll UART or fabricate a version. OTA/device version fields must use authoritative readback and display `未读取到` when absent; active APK verification is `pm path + aapt + SHA256`. The ordered P1 is `/Users/fu-121/mycc/2-Projects/kidshub-ai---godot/reports/P003_OTA_DEVICE_UI_P1_BACKLOG_20260821.md`; reuse the current Launcher/Godot/OTA Orchestrator and do not add an independent OTA daemon or Android-side OTA database. Full signed APK remains the authoritative artifact and fallback; a later delta path is exact-SHA, single-hop and must reconstruct the byte-identical signed target before normal install. Do not migrate this Launcher to Split/AAB or add Java/Kotlin/DEX hot patching; follow `/Users/fu-121/mycc/2-Projects/kidshub-ai---godot/docs/P003_OTA_DELTA_SPLIT_HOT_UPDATE_STRATEGY_20260821.md`.
