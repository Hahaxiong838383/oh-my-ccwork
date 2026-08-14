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

Current verified state: S2-A `classes3.dex` probe is READY on RK3562. The device keeps the probe APK installed with `p003_livekit_voice_probe_enabled=0`; S2-B must not take microphone ownership until the voice-rust-worker contract is frozen.
