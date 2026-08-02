import { rm } from "node:fs/promises";

/**
 * Build output is disposable. Removing it before a build prevents a stale file
 * from surviving if an entry point or copied asset is later renamed.
 */
await rm(new URL("../dist", import.meta.url), {
	force: true,
	recursive: true
});
