# Release quality audit — R8 / DEX optimisation, edge-to-edge, system PiP (#57)

**Scope:** the three Play Console findings on the Cutlyra 0.1.0 closed-test release
(31 Oct – 1 Nov 2026 screenshot): *DEX code optimization below threshold
(obfuscation 1 %, fix by Feb 2027)*, *edge-to-edge may not display for all users*,
and the *implement picture-in-picture* recommendation.

**Build inspected:** `main@1027a28`, versionName 0.1.0, versionCode 1,
`minSdk 29`, `compileSdk 36`, `targetSdk 36`, Gradle 8.14.3.

**Nothing in this document was applied to the shipped AAB.** No versionCode was
raised, no release was uploaded, and the running closed test was not touched.

---

## 1. DEX optimisation — the warning is explained, and the cause is one flag

`apps/mobile/android/app/build.gradle:95`:

```groovy
buildTypes {
    release {
        ndk { debugSymbolLevel 'FULL' }
        minifyEnabled false
        proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro'
    }
}
```

- `minifyEnabled false` means R8 runs in **no-op mode**: no shrinking, no
  optimisation, no obfuscation. `shrinkResources` is unset (defaults to false).
- At the 0.1.0 audit `app/proguard-rules.pro` was the untouched Android Studio
  template — 21 lines, every line a comment. PR #64 replaced it with the
  Capacitor / JNI / WebView keeps shown below.
- Play's "Obfuscation 1 %" is therefore an accurate description of the artifact,
  not a false positive. The threshold is a quality signal, and the artifact is
  maximally far from it.

### Why it cannot simply be flipped today

Three surfaces in this app break under R8 unless they are kept, and all three are
on the critical path:

1. **JNI symbol names.** `app/src/main/java/app/cutlyra/editor/stt/WhisperJNI.java:40`
   is a package-private `final class` whose native entry points are declared as
   `static native` (`initContext`, `freeContext`, `fullTranscribe`,
   `getSegmentCount`, `getSegmentT0/T1`, `getSegmentText`, …).
   JNI resolves them by *fully-qualified class name + method name*
   (`Java_app_cutlyra_editor_stt_WhisperJNI_initContext`). Renaming either side
   produces `UnsatisfiedLinkError` at first use — i.e. auto-captions crash on a
   release build only, which is exactly the class of bug that never shows up in
   debug QA.
2. **Capacitor's reflective bridge.** `NativeBridgePlugin.kt:70` is annotated
   `@CapacitorPlugin` and exposes **17** `@PluginMethod` members; `MainActivity.java:16`
   registers it by class literal. Capacitor looks methods up reflectively by
   annotation and name, and also uses `@Permission`, `@PermissionCallback` and
   `@ActivityCallback`. R8 without keep rules removes or renames them →
   the whole native side of the editor (import, proxy, export, captions, backup)
   disappears from a release build.
3. **Media3 and AndroidX** ship their own consumer rules, so they are the easy
   part; the project's own reflection is not.

The native library itself is unaffected: `libcutlyra_whisper.so` is already linked
with `-Wl,-z,max-page-size=16384` (`app/src/main/cpp/CMakeLists.txt:111`) for
16 KB page devices, and R8 does not touch `.so` files.

### The keep rules that enabling R8 needs

Applied to a CI-only `r8test` build type since PR #64; the `release` build type still has `minifyEnabled false`:

```proguard
# Capacitor bridge: plugin classes, plugin methods, permission/activity callbacks.
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keepclassmembers class * {
    @com.getcapacitor.PluginMethod <methods>;
    @com.getcapacitor.annotation.PermissionCallback <methods>;
    @com.getcapacitor.annotation.ActivityCallback <methods>;
}
-keepattributes RuntimeVisibleAnnotations,RuntimeVisibleParameterAnnotations,AnnotationDefault

# JNI: class name and native method names are part of the ABI.
-keep class app.cutlyra.editor.stt.WhisperJNI { *; }
-keepclasseswithmembernames,includedescriptorclasses class * { native <methods>; }

# WebView bridge (defensive: any future @JavascriptInterface surface).
-keepclassmembers class * { @android.webkit.JavascriptInterface <methods>; }
```

plus `-printconfiguration` + `-printmapping` output archived as the retrace
artifact Play asks for, and `minifyEnabled true` / `shrinkResources true`.

### How the hypothesis was tested (GitHub #57, PR #64)

`release` was not flipped blind. The repo now has a CI-only `r8test` build type
inherited from `debug` (so it stays debug-signed and installable without the
owner keystore) but `debuggable false`, which is what makes AGP run R8's
optimisation and obfuscation passes instead of skipping them. It enables
`minifyEnabled true` + `shrinkResources true`, and
`.github/workflows/mobile-ci.yml` builds it and runs the whole instrumented
suite against it (`:app:connectedR8testAndroidTest -PcutlyraR8Test`).

Measured on `main@fcaa03c` (PR #64 head `a6edc76`): the *Android instrumentation
(R8 test variant)* job is green with "Starting 45 tests ... Finished 45 tests",
covering the surfaces listed below, and the same 45 tests pass on the
debug APK against the API-35 emulator.

| Check | Result on the minified variant |
| --- | --- |
| Import a video through the Photo Picker | 45/45 tests, app installs and launches |
| Generate auto-captions (`WhisperJNI`) | 45/45 |
| Export an MP4 | 45/45 |
| Backup/archive export | 45/45 |
| Launcher icon, splash, permissions dialogs | packaged, installed, launched |

The suite also forced linkage rules that describe the *test* APK rather than the
app: the androidTest APK is minified by a separate R8 run that links against the
app by mapped name, so members R8 removes from the app (Kotlin intrinsics,
`Edl.copy`, `MediaItem.fromUri`) broke startup or individual tests. Those keeps
live in `proguard-instrumentation-rules.pro`, which only `r8test` consumes, so a
future minified release does not inherit them.

**Still not proven:** a *signed distribution* build. `release` keeps
`minifyEnabled false`; flipping it remains a separate, reviewed change, and
Play's "obfuscation 1 %" figure cannot be re-measured until an AAB with R8
enabled is built. **Risk of waiting:** Play's deadline is Feb 2027. **Risk of
flipping without device QA:** a release-only `UnsatisfiedLinkError` in captions
or a dead native bridge in the build testers install.

---

## 2. Edge-to-edge — real risk, now covered by an executable check

Play's advisory matters here because `targetSdk` is **36**: from Android 15 the
system draws the app edge-to-edge whether or not it opts in.

What the app does today:

- `apps/mobile/index.html:7` sets `viewport-fit=cover` (required for
  `env(safe-area-inset-*)` to be non-zero at all).
- Layout clears the bars with CSS only:
  `packages/mobile-ui/src/components.css:1112-1115` and
  `apps/mobile/src/app/app-root.css:38,72-75,299`.
- **No Kotlin-side inset plumbing exists.** A grep for
  `enableEdgeToEdge|setDecorFitsSystemWindows|WindowInsets` across
  `app/src/main` returns nothing.
- `app/src/main/res/values*/styles.xml` sets no `statusBarColor`,
  `navigationBarColor` or `windowLayoutInDisplayCutoutMode`.

So whether the top bar sits below the status bar depends entirely on whether the
WebView reports a real `safe-area-inset-top`. That is device- and
WebView-version-dependent, and unverifiable from source.

**Added:** `app/src/androidTest/.../systemui/EdgeToEdgeSystemBarInstrumentedTest.kt`
(plus `androidx.test.uiautomator` 2.3.0, test-only). It launches the real app on
the API-35 CI emulator, reads the platform status-bar height, and fails with the
measured `Rect` if "+ New project" or the editor's "Export" button begins inside
the status-bar band. A pass means the CSS path is working on that
configuration; a fail is a genuine layout defect with the numbers attached.

**Honest limit:** one emulator configuration proves the inset path works *there*.
Devices with cutouts, gesture navigation, or a different WebView build can still
differ, and the status bar is only the top edge — the navigation bar and the
software keyboard are not asserted by this test.

---

## 3. System picture-in-picture — assessed, not implemented

The Console recommendation is about **Android floating PiP** when the app is
backgrounded, not about Cutlyra's existing editable overlay clips (a different
feature that already ships).

- No `supportsPictureInPicture` in the manifest and no
  `enterPictureInPictureMode` call anywhere in `app/src/main` — confirmed absent.
- Product fit for a mobile video editor is weak: the useful case is watching a
  preview while switching apps, which is not an editing workflow, and PiP would
  need a second rendering surface that must not disturb the export pipeline.
- Play lists it as a *recommendation*, not a policy requirement.

**Decision: not planned for 0.1.x.** Bugs and the #54/#55 P0s come first, as the
issue instructs.

---

## What this audit did not establish

- No release AAB was built, so the "obfuscation 1 %" figure was not re-measured
  against a minified artifact, and nothing here predicts the exact number Play
  would report after enabling R8.
- Edge-to-edge was not exercised on Android 16, on a device with a display cutout,
  or with the keyboard open.
- No Play Console API inspection was performed; the findings come from the owner's
  screenshot.
