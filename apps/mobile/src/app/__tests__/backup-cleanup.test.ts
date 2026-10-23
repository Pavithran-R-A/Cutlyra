/**
 * GitHub #37 / PAV-96 — a failed backup must not strand a 0-byte archive in
 * the folder the user picked.
 *
 * The SAF picker creates the document the instant it returns, so everything
 * between "we hold a URI" and "the archive is written" is a window in which a
 * failure leaves an empty file behind. These tests drive the REAL orchestration
 * in `../backup.ts` against a fake bridge.
 *
 * Mocking note: `mock.module` is PROCESS-GLOBAL in bun (CI runs
 * `bun test packages apps/web src apps/mobile/src` in one process), so this
 * file doubles ONLY `@cutlyra/native-bridge` — nothing else in the test suite
 * loads that package by specifier (the other importers take types only).
 * editor-core's modules are left real on purpose: its GitHub #35 suite is the
 * module under test there and cannot re-mock itself, so doubling it from here
 * would break it. The real `buildExportRecipe` supplies the failure naturally
 * by throwing for a project that does not exist.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const realNativeBridge = await import("@cutlyra/native-bridge");

// ---------------------------------------------------------------------------
// Fake bridge
// ---------------------------------------------------------------------------

type Destination = {
	uri: string;
	sizeBytesAtPick: number;
	isNewlyCreated: boolean;
	displayName?: string;
};

const state = {
	pickResult: null as Destination | null,
	discardResult: {
		deleted: true,
		outcome: "removed",
		message: "The empty archive file it had created was removed.",
	},
	discardError: null as unknown,
};

const calls = {
	exportArchive: [] as Array<{ destinationUri: string; sizeBytesAtPick: number }>,
	discardArchiveDestination: [] as Array<{ uri: string; sizeBytesAtPick: number }>,
};

const bridge = {
	platform: "android",
	async pickArchiveDestination() {
		return state.pickResult;
	},
	async exportArchive(params: { destinationUri: string; sizeBytesAtPick: number }) {
		calls.exportArchive.push({
			destinationUri: params.destinationUri,
			sizeBytesAtPick: params.sizeBytesAtPick,
		});
		return { manifestJson: "{}" };
	},
	async discardArchiveDestination(params: { uri: string; sizeBytesAtPick: number }) {
		calls.discardArchiveDestination.push({
			uri: params.uri,
			sizeBytesAtPick: params.sizeBytesAtPick,
		});
		if (state.discardError) throw state.discardError;
		return state.discardResult;
	},
};

class FakeNativeBridgeError extends Error {
	code: string;
	constructor({ code, message }: { code: string; message: string }) {
		super(message);
		this.code = code;
		this.name = "NativeBridgeError";
	}
}

mock.module("@cutlyra/native-bridge", () => ({
	getNativeBridge: async () => bridge,
	NativeBridgeError: FakeNativeBridgeError,
}));

// Put the real package back for any file that loads after this one.
afterAll(() => {
	mock.module("@cutlyra/native-bridge", () => realNativeBridge);
});

const { runBackupProject, discardUnwrittenDestination, describeBackupError } = await import(
	"../backup"
);
const { BackupError } = await import("@cutlyra/editor-core/services/backup/types");

function newDestination(sizeBytesAtPick: number): Destination {
	return {
		uri: "content://documents/1234",
		sizeBytesAtPick,
		isNewlyCreated: sizeBytesAtPick === 0,
		displayName: "Project 1 backup.cutlyra-backup",
	};
}

/** No project with this id exists, so the REAL buildExportRecipe throws
 *  (IO_ERROR: "project … does not exist" on a working storage backend, a
 *  storage-initialisation failure under bun) — exactly the failure class this
 *  cleanup exists for. The assertions below deliberately do NOT pin the cause
 *  text: they pin what we do about it. */
const MISSING_PROJECT_ID = "no-such-project-for-github-37";

beforeEach(() => {
	state.pickResult = newDestination(0);
	state.discardError = null;
	state.discardResult = {
		deleted: true,
		outcome: "removed",
		message: "The empty archive file it had created was removed.",
	};
	calls.exportArchive.length = 0;
	calls.discardArchiveDestination.length = 0;
});

// ---------------------------------------------------------------------------
// runBackupProject — the failure window between the picker and the write
// ---------------------------------------------------------------------------

describe("backup destination cleanup (GitHub #37)", () => {
	test("a cancelled picker throws USER_CANCELLED and never cleans anything", async () => {
		state.pickResult = null;

		await expect(
			runBackupProject({ projectId: MISSING_PROJECT_ID, projectName: "Project 1" }),
		).rejects.toMatchObject({ code: "USER_CANCELLED" });
		expect(calls.exportArchive).toHaveLength(0);
		expect(calls.discardArchiveDestination).toHaveLength(0);
	});

	test("a failed export removes the empty destination it created", async () => {
		const error = (await runBackupProject({
			projectId: MISSING_PROJECT_ID,
			projectName: "Project 1",
		}).catch((e: unknown) => e)) as InstanceType<typeof BackupError>;

		expect(error).toBeInstanceOf(BackupError);
		expect(error.code).toBe("IO_ERROR");
		expect(calls.exportArchive).toHaveLength(0);

		// The file the picker created is removed again, and the user is told so.
		expect(calls.discardArchiveDestination).toEqual([
			{ uri: "content://documents/1234", sizeBytesAtPick: 0 },
		]);
		expect(describeBackupError(error)).toContain("was removed");
	});

	test("a provider that refuses the delete is reported as leaving the file behind", async () => {
		state.discardResult = {
			deleted: false,
			outcome: "refused",
			message:
				"The file it created is still at the location you chose and must be deleted by you — the storage provider declined the delete request.",
		};

		const error = (await runBackupProject({
			projectId: MISSING_PROJECT_ID,
			projectName: "Project 1",
		}).catch((e: unknown) => e)) as InstanceType<typeof BackupError>;

		const text = describeBackupError(error);
		expect(text).toContain("still at the location you chose");
		expect(text).not.toContain("was removed.");
	});

	test("a pre-existing file is never deleted and is left out of the message", async () => {
		state.pickResult = newDestination(4096);

		const error = (await runBackupProject({
			projectId: MISSING_PROJECT_ID,
			projectName: "Project 1",
		}).catch((e: unknown) => e)) as InstanceType<typeof BackupError>;

		expect(calls.discardArchiveDestination).toHaveLength(0);
		// The original failure stands alone: no cleanup suffix is appended.
		expect(error.message).not.toContain("was removed");
		expect(error.message).not.toContain("still at the location");
	});

	test("a destination whose ownership is unproven is never deleted", async () => {
		state.pickResult = newDestination(-1);

		const error = (await runBackupProject({
			projectId: MISSING_PROJECT_ID,
			projectName: "Project 1",
		}).catch((e: unknown) => e)) as InstanceType<typeof BackupError>;

		expect(calls.discardArchiveDestination).toHaveLength(0);
		expect(error.message).toContain("an empty file may remain there");
	});

	test("a cleanup that itself fails still surfaces the original failure", async () => {
		state.discardError = new Error("plugin method missing");

		const error = (await runBackupProject({
			projectId: MISSING_PROJECT_ID,
			projectName: "Project 1",
		}).catch((e: unknown) => e)) as InstanceType<typeof BackupError>;

		expect(error.code).toBe("IO_ERROR");
		expect(error.message).toContain("could not be cleaned up");
	});
});

// ---------------------------------------------------------------------------
// discardUnwrittenDestination — the decision contract on its own
// (a plain object literal is enough here: the bridge is a parameter)
// ---------------------------------------------------------------------------

describe("discardUnwrittenDestination (GitHub #37)", () => {
	test("appends the cleanup suffix to the original failure", async () => {
		const result = await discardUnwrittenDestination({
			destination: newDestination(0) as never,
			error: new Error("boom"),
			bridge: bridge as never,
		});
		expect(result.code).toBe("IO_ERROR");
		expect(result.message).toBe("boom The empty archive file it had created was removed.");
	});

	test("keeps the native refusal wording when the provider says no", async () => {
		state.discardResult = {
			deleted: false,
			outcome: "refused",
			message: "The file it created is still at the location you chose and must be deleted by you.",
		};
		const result = await discardUnwrittenDestination({
			destination: newDestination(0) as never,
			error: new Error("boom"),
			bridge: bridge as never,
		});
		expect(result.message).toContain("still at the location you chose");
	});

	test("leaves an untouched pre-existing file out of the message entirely", async () => {
		const result = await discardUnwrittenDestination({
			destination: newDestination(1234) as never,
			error: new Error("boom"),
			bridge: bridge as never,
		});
		expect(result.message).toBe("boom");
		expect(calls.discardArchiveDestination).toHaveLength(0);
	});

	test("an unproven destination is reported as possibly left behind, not cleaned", async () => {
		const result = await discardUnwrittenDestination({
			destination: newDestination(-1) as never,
			error: new Error("boom"),
			bridge: bridge as never,
		});
		expect(result.message).toContain("an empty file may remain there");
		expect(calls.discardArchiveDestination).toHaveLength(0);
	});

	test("preserves a USER_CANCELLED code rather than relabelling it", async () => {
		const result = await discardUnwrittenDestination({
			destination: newDestination(0) as never,
			error: new FakeNativeBridgeError({ code: "USER_CANCELLED", message: "cancelled" }),
			bridge: bridge as never,
		});
		expect(result.code).toBe("USER_CANCELLED");
		expect(result.message).toContain("was removed");
	});
});

// ---------------------------------------------------------------------------
// Success path + mid-write interruption, through the injection seam
//
// `runBackupProject({ deps })` takes its bridge and recipe builder from the
// caller, so these need NO module doubling at all — the process-global kind
// that broke editor-core's suite is simply not in play.
// ---------------------------------------------------------------------------

/** A descriptor exactly as buildExportRecipe would produce one, so the
 *  success-path assertions compare against real-shaped data. */
const RECIPE_MEDIA = [
	{
		assetId: "a1",
		proxyPath: "media/a1/proxy.mp4",
		sourcePath: null,
		thumbnailPath: "media/a1/thumb.jpg",
		name: "clip",
		type: "video",
		sizeBytes: 123,
		lastModified: 1,
		width: 640,
		height: 360,
		duration: 10,
		fps: 30,
		hasAudio: true,
		sourceRotationDegrees: 0,
		sourceWidth: 1920,
		sourceHeight: 1080,
	},
];

describe("successful export wiring (GitHub #37)", () => {
	test("forwards the pick-time size so native can prove ownership on failure", async () => {
		await runBackupProject({
			projectId: "p1",
			projectName: "Project 1",
			deps: {
				bridge: bridge as never,
				buildRecipe: (async () => ({
					projectJson: JSON.stringify({ id: "p1" }),
					projectName: "Project 1",
					media: RECIPE_MEDIA as never,
				})) as never,
			},
		});

		// The evidence that lets native delete a destination it created is the
		// size the provider reported at pick time — it must arrive intact.
		expect(calls.exportArchive).toEqual([
			{ destinationUri: "content://documents/1234", sizeBytesAtPick: 0 },
		]);
		expect(calls.discardArchiveDestination).toHaveLength(0);
	});

	test("forwards a non-zero pick size untouched for a pre-existing file", async () => {
		state.pickResult = newDestination(4096);

		await runBackupProject({
			projectId: "p1",
			projectName: "Project 1",
			deps: {
				bridge: bridge as never,
				buildRecipe: (async () => ({
					projectJson: "{}",
					projectName: "Project 1",
					media: [] as never,
				})) as never,
			},
		});

		expect(calls.exportArchive).toEqual([
			{ destinationUri: "content://documents/1234", sizeBytesAtPick: 4096 },
		]);
	});

	test("forwards an unknown pick size as -1 rather than dropping the field", async () => {
		state.pickResult = newDestination(-1);

		await runBackupProject({
			projectId: "p1",
			projectName: "Project 1",
			deps: {
				bridge: bridge as never,
				buildRecipe: (async () => ({
					projectJson: "{}",
					projectName: "Project 1",
					media: [] as never,
				})) as never,
			},
		});

		expect(calls.exportArchive).toEqual([
			{ destinationUri: "content://documents/1234", sizeBytesAtPick: -1 },
		]);
	});

	test("a mid-write failure inside native propagates verbatim and never double-cleans", async () => {
		// Native owns cleanup for every failure INSIDE exportArchive (the copy
		// was interrupted mid-stream). JS must pass that error through with
		// native's own wording and must NOT call discardArchiveDestination —
		// otherwise the two layers race to delete the same document.
		const midWriteError = new FakeNativeBridgeError({
			code: "IO_ERROR",
			message:
				"Archive export failed. The empty archive file it had created was removed.",
		});
		const failingBridge = {
			...bridge,
			async exportArchive() {
				throw midWriteError;
			},
		};

		const error = (await runBackupProject({
			projectId: "p1",
			projectName: "Project 1",
			deps: {
				bridge: failingBridge as never,
				buildRecipe: (async () => ({
					projectJson: "{}",
					projectName: "Project 1",
					media: [] as never,
				})) as never,
			},
		}).catch((e: unknown) => e)) as InstanceType<typeof BackupError>;

		expect(error.code).toBe("IO_ERROR");
		// Native's truth about the leftover file survives untouched.
		expect(error.message).toContain("was removed");
		// No second cleanup attempt from the JS layer.
		expect(calls.discardArchiveDestination).toHaveLength(0);
	});

	test("a mid-write failure that refused cleanup keeps the refusal wording", async () => {
		const refusalError = new FakeNativeBridgeError({
			code: "IO_ERROR",
			message:
				"Archive export failed. The file it created is still at the location " +
				"you chose and must be deleted by you — the storage provider would not " +
				"let Cutlyra remove it.",
		});
		const failingBridge = {
			...bridge,
			async exportArchive() {
				throw refusalError;
			},
		};

		const error = (await runBackupProject({
			projectId: "p1",
			projectName: "Project 1",
			deps: {
				bridge: failingBridge as never,
				buildRecipe: (async () => ({
					projectJson: "{}",
					projectName: "Project 1",
					media: [] as never,
				})) as never,
			},
		}).catch((e: unknown) => e)) as InstanceType<typeof BackupError>;

		expect(error.message).toContain("still at the location you chose");
		expect(error.message).not.toContain("was removed.");
		expect(calls.discardArchiveDestination).toHaveLength(0);
	});

	test("the recipe is built BEFORE any bytes move, and export never runs without it", async () => {
		let exportCalledAfterRecipeFailure = false;
		const trackingBridge = {
			...bridge,
			async exportArchive() {
				exportCalledAfterRecipeFailure = true;
				return { manifestJson: "{}" };
			},
		};

		await runBackupProject({
			projectId: "p1",
			projectName: "Project 1",
			deps: {
				bridge: trackingBridge as never,
				buildRecipe: (async () => {
					throw new Error("storage unavailable");
				}) as never,
			},
		}).catch(() => undefined);

		expect(exportCalledAfterRecipeFailure).toBe(false);
	});
});
