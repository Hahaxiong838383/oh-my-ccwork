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

Current verified S2-B1 READY baseline: `1.2.2-canary.23 (35)`, APK SHA256 `b7cbb42b765fdc534b921d38071d7b1ae849ba6b999955eba63a244f07c3eb29`, Android JVM `68/68`, Game Rust `6/6`, six Launcher services, three human Worker-ASR stop rounds and four explicit exits passing. Caption transport contains local/remote interim/final data across six traces with zero bad remote-underrun samples. Production Worker contract is `601ef841e26860993a1f21dd282622bd470bb0a3`, binary MD5 `586b033fd1bbb3ce22a2d8b2a080d371`. Product credentials live in Android Keystore; bootstrap and ADB reverse `38541/38542` must remain `0`. Before any install or voice diagnosis, run `REQUIRE_SESSION_EVIDENCE=1 /Users/fu-121/mycc/2-Projects/kidshub-ai---godot/scripts/verify_p003_product_voice_baseline.sh`. Never install an older APK or a same-version different-SHA artifact, and never use `pm clear` or uninstall without an explicit credential re-provisioning plan. Online product interruption is Worker-ASR-owned; do not restore Android VAD fast-stop.
