/**
 * Regression: restore-with-remap wrote the archived project back over the
 * ORIGINAL project's record.
 *
 * A serialized project carries its own top-level `id`. The adapter used to
 * build `{ id: key, ...value }`, so the value's stale `id` (spread last)
 * replaced the requested key. `applyNativeImport` / `restoreProjectArchive`
 * remap only `metadata.id` and pass `key = <remapped id>`, so the remapped
 * record landed under the ARCHIVED id — replacing the existing project row,
 * leaving the restored project unlisted and the original card unopenable
 * ("Project with id …-restored-… not found").
 *
 * Physical-device evidence: qa-evidence/DEFECT-restore-remap-overwrites-project.md
 */

import { describe, expect, it } from "bun:test";
import { withStoreKey } from "@/services/storage/indexeddb-adapter";

describe("withStoreKey", () => {
	it("keeps the requested key when the value carries its own id", () => {
		const archived = {
			id: "original-project-id",
			metadata: { id: "original-project-id", name: "Project 2" },
			scenes: [],
		};

		const stored = withStoreKey({
			key: "original-project-id-restored-abc123",
			value: archived,
		});

		expect(stored.id).toBe("original-project-id-restored-abc123");
		// The remapped metadata id is what callers resolve projects by.
		expect(stored.metadata.id).toBe("original-project-id");
		// Everything except the key is preserved byte-for-byte.
		expect(stored.scenes).toEqual(archived.scenes);
	});

	it("uses the requested key for values with no id of their own", () => {
		const stored = withStoreKey({ key: "asset-1", value: { name: "clip.mp4" } });

		expect(stored).toEqual({ name: "clip.mp4", id: "asset-1" });
	});

	it("never lets a value id differ from the requested key", () => {
		const stored = withStoreKey({
			key: "wanted-key",
			value: { id: "some-other-key", a: 1 },
		});

		expect(stored.id).toBe("wanted-key");
		expect(stored.a).toBe(1);
	});
});
