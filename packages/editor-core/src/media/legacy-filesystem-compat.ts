/**
 * Legacy filesystem compatibility constants — the ONLY place in the runtime
 * where pre-rebrand ("kneecap") storage identifiers may appear.
 *
 * WHY THIS EXISTS (do not "clean it up"):
 * Cutlyra was developed and shipped under the working name "kneecap" before
 * the 2026-09 rebrand. Projects persisted by those builds reference media
 * under the OLD custody-root basename, and deleting the literal would orphan
 * every pre-rebrand install's media on next load (the bytes remain on disk;
 * only the path prefix would no longer be recognized). iOS additionally
 * MIGRATES `Application Support` content across app-container UUID rotations,
 * so old files keep living under the old basename inside the new container.
 *
 * MIGRATION CONTRACT:
 * - Reading: `salvageRelativeMediaPathFromStaleUrl` (native-paths.ts) matches
 *   persisted URLs against LEGACY + CURRENT root basenames, so pre-rebrand
 *   projects keep opening.
 * - Writing: all native custody code (iOS MediaSandbox, Android MediaImporter)
 *   creates only the CURRENT `cutlyra` root. Old media stays in place, still
 *   reachable via the salvage path above; newly imported media lands under
 *   the new root and carries only new-brand identifiers.
 * - Removal: this literal may only be deleted once telemetry/QA confirms no
 *   active install predates the rebrand. Not before. Removing it earlier is
 *   a data-loss bug, not a branding win.
 *
 * The EDL `$schema` identifier needed NO runtime compat: no mapper or
 * validator ever compares its VALUE (iOS decodes it as an opaque string,
 * Android ignores it, `validateEdl()` never reads it), so the written
 * identifier simply moved to the Cutlyra name (EDL_SCHEMA_ID in
 * `../edl/types.ts`). The frozen pre-rebrand literal is kept HERE — outside
 * the runtime import graph — so the schema/golden tests can keep asserting
 * that historical documents and current writes are both understood. Keep it
 * that way: importing it from runtime modules would embed the old identifier
 * in every app bundle again.
 */

/** Custody-root basenames recognized when salvaging persisted media URLs.
 *  The first entry is the pre-rebrand iOS basename (kept for old-project
 *  salvage); "cutlyra" is the current root every supported writer creates. */
export const LEGACY_FILESYSTEM_ROOT_BASENAMES: readonly string[] = [
	"kneecap",
	"cutlyra",
];

/** Frozen EDL `$schema` identifier minted under the pre-rebrand name. Kept
 *  only so historical EDL documents still validate/match; nothing writes it
 *  anymore (see EDL_SCHEMA_ID in ../edl/types.ts). */
export const LEGACY_EDL_SCHEMA_ID = "https://kneecap.dev/schema/edl-v1.json";

/** `true` when the given $schema value is any identifier this build accepts
 *  (current or frozen legacy). Centralized so the acceptance list has one
 *  home and greppable provenance. */
export function isKnownEdlSchemaId(schemaId: string): boolean {
	return (
		schemaId === LEGACY_EDL_SCHEMA_ID ||
		schemaId === "https://cutlyra.dev/schema/edl-v1.json"
	);
}
