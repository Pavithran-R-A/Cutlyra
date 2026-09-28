# Cutlyra — builds libcutlyra_whisper.so (Android on-device captions).
#
# The whisper.cpp sources are NOT in this repo; `scripts/fetch-whisper-cpp.sh`
# clones a pinned tag into ./whisper.cpp (gitignored). When that directory is
# absent this file builds NOTHING and the app still compiles and installs —
# captions then fail at runtime with a clear UnsatisfiedLinkError rather than
# breaking the whole Android build for everyone who has not run the fetch.
cmake_minimum_required(VERSION 3.22.1)
project(cutlyra_whisper CXX C)

set(WHISPER_DIR ${CMAKE_CURRENT_SOURCE_DIR}/whisper.cpp)

if(NOT EXISTS ${WHISPER_DIR}/include/whisper.h)
	message(WARNING
		"whisper.cpp sources not found at ${WHISPER_DIR} — skipping libcutlyra_whisper. "
		"Run apps/mobile/scripts/fetch-whisper-cpp.sh to enable Android captions.")
	# A stub target keeps `externalNativeBuild` happy (it requires at least
	# one target) without producing a .so that would fail to link.
	add_library(cutlyra_whisper_absent STATIC ${CMAKE_CURRENT_SOURCE_DIR}/whisper_absent.c)
	return()
endif()

# whisper.cpp's own CMake, driven as a subproject. Everything optional is off:
# the extras (examples, tests, tools, its own SDL/ffmpeg integrations) pull in
# host-only dependencies that do not cross-compile, and the alternate backends
# are irrelevant on the ABIs Cutlyra ships.
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(GGML_LLAMAFILE OFF CACHE BOOL "" FORCE)
add_subdirectory(${WHISPER_DIR} ${CMAKE_CURRENT_BINARY_DIR}/whisper_build EXCLUDE_FROM_ALL)

add_library(cutlyra_whisper SHARED cutlyra_whisper_jni.cpp)
target_link_libraries(cutlyra_whisper PRIVATE whisper log)
target_compile_options(cutlyra_whisper PRIVATE -O3)

# --- Static libc++ on Windows hosts (NDK 27.2, CMake 3.22.1) ---------------
#
# The JNI .so must drag in the C++ runtime statically (whisper.cpp/ggml is
# C++17); shipping c++_shared would add a second .so for one optional
# feature. The obvious `-static-libstdc++` does NOT work here: the NDK
# toolchain adds -no-canonical-prefixes, and on a Windows host whose build
# paths resolve through 8.3 short names (PAVITH~1 / WINDOW~1), that flag
# makes the clang++ driver's own STL path resolution fail silently — it
# drops `-Bstatic -lc++ -Bdynamic` from the link line and ld.lld then fails
# on ~500 unresolved std::__ndk1 symbols. Verified by bisecting the driver
# invocation: every other CMake-added flag keeps the STL, only
# -no-canonical-prefixes loses it (see the handoff note in
# docs/STATUS.md / CUTLYRA_HANDOFF.md for the repro).
#
# Deterministic fix: stop relying on driver auto-injection entirely.
# -nostdlib++ suppresses the C++ runtime link step (compile flags are
# unaffected), and the three static archives — libc++_static.a,
# libc++abi.a, libunwind.a — are linked by explicit full path, resolved
# from the toolchain's own paths so they are host-layout independent and
# identical on any machine. The Bstatic/Bdynamic state is restored so the
# subsequent -lm/-ldl/-lc system libs stay dynamic (Android's libc++_static
# itself only needs the static archives listed here).

# Toolchain paths (same layout as the driver binary CMake already resolved).
get_filename_component(_NDK_TOOLCHAIN_BIN "${CMAKE_CXX_COMPILER}" DIRECTORY)
# bin -> windows-x86_64 (the NDK host-toolchain root that owns sysroot/ and lib/).
get_filename_component(_NDK_TC_ROOT "${_NDK_TOOLCHAIN_BIN}/.." ABSOLUTE)
# sysroot/usr/lib/<triple>/ — triple as detected by CMake, with the known
# Android arm64 triple as fallback (only ABI this build targets).
if(NOT CMAKE_LIBRARY_ARCHITECTURE)
  set(CMAKE_LIBRARY_ARCHITECTURE "aarch64-linux-android")
endif()
set(_NDK_LIBCXX_DIR "${_NDK_TC_ROOT}/sysroot/usr/lib/${CMAKE_LIBRARY_ARCHITECTURE}")
# clang resource dir: NDK 27 installs under the MAJOR version only
# (lib/clang/18), while CMAKE_CXX_COMPILER_VERSION is the full 18.0.3 —
# try the full version first, then the major-only layout. The runtime
# (libunwind) archives are per-TARGET-arch, not per-host: map the Android
# ABI to the lib/linux/<arch> directory name.
if(ANDROID_ABI STREQUAL "arm64-v8a")
  set(_NDK_RT_ARCH "aarch64")
elseif(ANDROID_ABI STREQUAL "x86_64")
  set(_NDK_RT_ARCH "x86_64")
elseif(ANDROID_ABI STREQUAL "armeabi-v7a")
  set(_NDK_RT_ARCH "arm")
elseif(ANDROID_ABI STREQUAL "x86")
  set(_NDK_RT_ARCH "i386")
else()
  message(FATAL_ERROR "cutlyra_whisper: unsupported ANDROID_ABI ${ANDROID_ABI}")
endif()
set(_NDK_CLANG_RT_DIR "${_NDK_TC_ROOT}/lib/clang/${CMAKE_CXX_COMPILER_VERSION}/lib/linux/${_NDK_RT_ARCH}")
if(NOT EXISTS "${_NDK_CLANG_RT_DIR}")
  string(REGEX REPLACE "^([0-9]+)\\..*" "\\1" _NDK_CLANG_MAJOR "${CMAKE_CXX_COMPILER_VERSION}")
  set(_NDK_CLANG_RT_DIR "${_NDK_TC_ROOT}/lib/clang/${_NDK_CLANG_MAJOR}/lib/linux/${_NDK_RT_ARCH}")
endif()

foreach(_lib
    "${_NDK_LIBCXX_DIR}/libc++_static.a"
    "${_NDK_LIBCXX_DIR}/libc++abi.a"
    "${_NDK_CLANG_RT_DIR}/libunwind.a")
  if(NOT EXISTS "${_lib}")
    message(FATAL_ERROR
      "cutlyra_whisper: static C++ runtime archive not found: ${_lib} — \
the NDK layout changed; fix _NDK_LIBCXX_DIR/_NDK_CLANG_RT_DIR above.")
  endif()
endforeach()

target_link_options(cutlyra_whisper PRIVATE -nostdlib++)
# 16 KB page-size devices (Android 15+ opt-in, Android 16 default on new
# devices): a 4 KB-aligned LOAD segment hard-crashes dlopen there
# ("program alignment (4096) cannot be smaller than system page size
# (16384)") — observed live on the API 37 emulator when the captions path
# ran System.loadLibrary. 16384 alignment is a no-op on 4 KB devices.
target_link_options(cutlyra_whisper PRIVATE "-Wl,-z,max-page-size=16384")
target_link_libraries(cutlyra_whisper PRIVATE
  "${_NDK_LIBCXX_DIR}/libc++_static.a"
  "${_NDK_LIBCXX_DIR}/libc++abi.a"
  "${_NDK_CLANG_RT_DIR}/libunwind.a")
# The explicit .a paths above flip the driver into -Bstatic state (driver
# behavior: a file argument implies static search); re-open the dynamic
# search scope so the standard system libraries after them (-lm, -ldl,
# -lc ...) are found dynamically as usual.
target_link_options(cutlyra_whisper PRIVATE
  "-Wl,-Bdynamic")
