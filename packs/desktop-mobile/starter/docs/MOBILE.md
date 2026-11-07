# Desktop and mobile

This project starts as a Tauri desktop app for Windows and macOS. The same web front end and Rust core can also ship to mobile.

## What can be verified where

| Target | Local Windows machine | CI |
|---|---|---|
| Windows desktop | Yes | Yes |
| macOS desktop | No | Yes |
| Android | Yes, after installing a JDK and the Android SDK | Add it when you adopt it |
| iOS | **No: needs Xcode, which only runs on a Mac** | macOS runners only |

An agent can't verify iOS behavior from a Windows machine. Until macOS CI covers it, treat iOS as unverified, and say so in the PR's Risk section.

## Adding Android

1. Install a JDK and the Android SDK, and set `JAVA_HOME`, `ANDROID_HOME`, and `NDK_HOME`.
2. Run `cargo tauri android init`, and commit the result.
3. Add `cargo tauri android build --debug` to `verify.e2e`.
4. Connect a device or start an emulator, confirm it with `adb devices`, and run `cargo tauri android dev` to try it.

Screenshots can come from `adb exec-out screencap -p > shot.png`. Look at them.

## Adding iOS

Run `cargo tauri ios init` on a Mac, then add a macOS CI job running `cargo tauri ios build --debug`.

## Signing and stores

Signing identities, store accounts, and release tracks cost money and sit outside this repo, so they're major decisions for the admin. Staged rollout is the release channel here: internal track first, then a percentage rollout. Halting a rollout is the way back, because a store release can't be reverted the way a commit can. Note that in [ROLLBACK.md](ROLLBACK.md).

Secrets for signing stay out of this repo's CI until the admin decides otherwise: this template's CI holds no secrets by design.
