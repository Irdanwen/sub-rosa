---
status: accepted
date: 2026-09-15
---

# Android shares the mobile core and owns its system bridges

## Context

Sub Rosa needs an installable Android test app. The iOS shell already has the
mobile interface, in-process June API, agent-lite, and durable work recovery.
Android cannot use Apple's keychain, audio session, photo library or share
sheet. The generic keyring crate's fallback is an in-memory mock, which would
appear to save a credential and then lose it when the process exits.

## Decision

Android uses the existing Tauri mobile shell and `june-embed`. It does not
bundle Hermes or start an external backend. The app identifier remains
`xyz.carpediem.subrosa` and Android 10 (API 29) is the minimum version.

A fork-owned Kotlin library supplies Android system operations through a
Tauri plugin. An Android `keyring::CredentialBuilder` is installed before
settings load. Credentials are encrypted with an AES-GCM key in Android
Keystore; only ciphertext is persisted in private app storage. Android backup
is disabled because restoring ciphertext without its device-bound key cannot
restore a working credential store. A credential-store failure stays a
failure; it never silently falls back to a mock or plaintext.

Microphone capture uses the existing cpal pipeline after the Android runtime
permission has been granted. A microphone foreground service owns its visible
recording notification for the lifetime of capture. Long AI work continues to
use durable rows and the launch/resume sweep (ADR-0018); this release does not
promise that Android will run it while the app is suspended or force-stopped.

The committed Gradle project builds a signed ARM64 APK for direct testing and
an AAB for store distribution. Signing credentials are local ignored files
and GitHub Actions secrets. The same signing identity must be retained for
future APK updates. Store account setup and Play admission are separate from
building an app bundle.

## Alternatives and consequences

A second native UI would duplicate every mobile feature and its persistence
contract. A separate hosted backend would change where requests travel.
Neither is needed for Android.

Keeping the `keyring` API avoids separate credential paths for Carpe Diem,
account sessions, maps and issue reporting. It adds a small native bridge and
requires on-device restart tests: compiling Rust cannot prove Keystore or
Android permissions work. Android-only system behavior must be validated on
an emulator or phone as well as by the build pipeline.

## Addendum 2026-09-28: cpal needs ndk-context

The first recording on a phone failed with `task N panicked with message
"android context was not initialized"`. cpal's oboe backend asks the
`ndk-context` crate for the JavaVM and a Context (to read
`AudioRecord.getMinBufferSize` in `default_input_config()`), and neither
Tauri, tao nor wry fills that crate: they keep their own copies. Compiling
could not catch it, which is the risk the paragraph above names.

`SubRosaPlugin` now calls the native `initNdkContext` with the application
context when it is constructed, which happens at setup, before any command
can reach the microphone. `android.rs` hands the process-wide JavaVM and a
leaked global reference to `ndk_context::initialize_android_context` once.
The application context is used rather than the activity because it outlives
activity recreation. A panicking capture task now reaches the screen as a
sentence, not as the panic text.
