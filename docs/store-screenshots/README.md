# Cutlyra — Play store screenshots

These are the phone screenshots for the Google Play listing. Google currently
requires **at least four** screenshots at a minimum 1080 px resolution, 9:16
portrait (minimum 1080×1920) — see
<https://support.google.com/googleplay/android-developer/answer/9866151>.
All four files below meet that exactly.

| File | Screen |
| --- | --- |
| `01-projects-home.png` | Projects home |
| `02-editor-timeline.png` | Timeline / editor |
| `03-text-panel.png` | Text styling panel |
| `04-export-sheet.png` | Export sheet (resolution / frame rate / quality) |

## Provenance — read before uploading

Captured from the **shipped mobile web bundle at exact main `aee28b7`**
(`apps/mobile` + `@cutlyra/mobile-ui`), rendered in a Chromium window at a
412-logical-px phone width and a 1080×1920 device frame, with the app's own
`#app`/`100dvh` layout rules intact. The Android build wraps this same
bundle in a WebView, so the chrome, spacing and type scale match the app.

Content rules that were applied:

- **No personal data.** Every clip in the timeline is an original image
  generated in-page for this capture (flat brand-tone scenes drawn on a
  canvas — dusk horizon, cyan studio, coral night). No user gallery, no
  existing project, no device photo was used.
- **No test diagnostics.** The `#/autotest` harness route was never mounted,
  so no fixture filenames (`autotest-image.jpeg`), harness verdicts, debug
  overlays or EDL dumps appear. The "Preview EDL output" button visible in
  `04-export-sheet.png` is part of the shipped export sheet, not a harness
  affordance (`packages/mobile-ui/src/components/panels/export-sheet.tsx`
  documents it as a real verification step).
- **No inherited OpenCut branding.** Only Cutlyra's own UI and wordmark.
- **No host/preview watermark.** The capture environment injects an overlay
  into the page; it is hidden for these captures and verified absent from the
  saved PNGs.

## What still has to be recaptured

These are accurate, but they come from the bundle rendered in a browser, not
from the **Play-delivered candidate on a physical device**. Before submitting
the production release, recapture the same four screens from the build Play
actually serves so that permissions, version, first-run screen and system
surfaces (Photo Picker, export destination) match what users and reviewers
receive. Keep this directory's layout and file names when replacing them.

`docs/screenshots/` holds older QA captures. Those are **evidence only** and
must not be uploaded — the timeline capture there shows test fixture names
and a test pattern.
