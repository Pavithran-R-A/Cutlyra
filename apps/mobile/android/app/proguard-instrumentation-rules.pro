# Rules that exist ONLY so the `r8test` CI variant (GitHub #57) can run
# the instrumented suite against a minified app. `r8test` is the only build
# type that adds this file; `release` and `debug` never see it.
#
# Why it is needed: AGP minifies the androidTest APK in a separate R8 run
# fed with this app's mapping, and that test APK does not carry its own
# copy of anything the app already ships. So every class/member the tests
# touch must still exist in the minified app. R8 removes anything only the
# tests use, and each hole kills the run before the first test starts:
#   * kotlin.jvm.internal.Intrinsics -> NoSuchMethodError
#     (checkNotNullParameter, whose in-app callers were all inlined)
#   * app.cutlyra.editor.edl.Edl.copy -> NoSuchMethodError
#   * androidx.tracing.Trace -> NoClassDefFoundError from AndroidJUnitRunner
# Keeping the app module's own members and the test-framework closure closes
# them. Class-name obfuscation, library shrinking and every keep rule in
# proguard-rules.pro (Capacitor reflection, JNI, WebView) still apply, which
# is the surface this job exists to prove.

# The app's own API surface: members stay, class names may still be
# obfuscated (test references are rewritten through the mapping).
-keepclassmembers class app.cutlyra.editor.** { *; }

# media3 is the one library the suite calls directly (MediaItem, Composition,
# effects) to check what the exporter produced. R8 drops overloads the app
# never uses — MediaItem.fromUri(String) was measured going missing — so
# keep its members too. Class names still obfuscate.
-keepclassmembers class androidx.media3.** { *; }

# Kotlin runtime the test APK links through by name after mapping. The
# stdlib is an app dependency, so the test APK drops its own copy, while
# R8 drops the classes the app never uses (measured: Intrinsics helpers,
# kotlin.LazyKt). Keeping the whole (small) stdlib closes that family.
-keep class kotlin.** { *; }

# androidTest runtime. androidx.test ships no consumer keep rules for a
# minified host (android/android-test#2167); these are the packages its
# runner, rules and UiAutomator link against.
-keep class androidx.test.** { *; }
-keep class androidx.tracing.** { *; }
-keep class androidx.concurrent.** { *; }
-keep class androidx.annotation.** { *; }
-keep class androidx.monitor.** { *; }
-keep class org.junit.** { *; }
-keep class junit.** { *; }
-keep class org.hamcrest.** { *; }
-keep class kotlin.test.** { *; }

# R8 otherwise fails the build on the optional deps those packages declare
# (none of them are on the app's runtime path).
-dontwarn androidx.test.**
-dontwarn org.junit.**
-dontwarn org.hamcrest.**
