# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# --- R8 readiness for the CI-only `r8test` build type (GitHub #57) ---
# Written from docs/qa/release-quality-audit.md section 1. These rules
# MUST also be re-validated before any distribution build enables R8:
# the CI job `android-instrumentation-r8` installs the r8test build and
# runs the instrumented suite against it.

# Capacitor bridge: plugin classes, plugin methods, permission/activity callbacks.
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keepclassmembers class * {
    @com.getcapacitor.PluginMethod <methods>;
    @com.getcapacitor.annotation.PermissionCallback <methods>;
    @com.getcapacitor.annotation.ActivityCallback <methods>;
}
-keepattributes RuntimeVisibleAnnotations,RuntimeVisibleParameterAnnotations,AnnotationDefault

# Instrumented-suite linkage (GitHub #57). The androidTest APK is
# minified by a separate R8 run that AGP feeds this app's mapping, so any
# app member it calls must still EXIST here under the mapped name. Members
# that only the tests call are exactly what R8 removes in the app (data
# class `copy`/`componentN`, Kotlin null-check helpers, …), and each one
# kills the whole run with NoSuchMethodError before a single test starts
# (measured: Intrinsics.checkNotNullParameter, then Edl.copy). Keeping the
# module's own members intact leaves class-name obfuscation and every
# library/resource/native rule below doing their real work.
-keepclassmembers class app.cutlyra.editor.** { *; }

# Kotlin runtime helper the instrumented APK links through by name after
# mapping; R8 removes the helpers whose in-app callers were all inlined.
-keep class kotlin.jvm.internal.Intrinsics { *; }

# JNI: class name and native method names are part of the ABI.
-keep class app.cutlyra.editor.stt.WhisperJNI { *; }
-keepclasseswithmembernames,includedescriptorclasses class * { native <methods>; }

# WebView bridge (defensive: any future @JavascriptInterface surface).
-keepclassmembers class * { @android.webkit.JavascriptInterface <methods>; }

# Retrace artifacts: Play (and CI) archives these for stacktrace mapping.
-printmapping build/outputs/mapping/r8test/mapping.txt
-printusage build/outputs/mapping/r8test/usage.txt
-printconfiguration build/outputs/mapping/r8test/configuration.txt
