import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectories = new Set([".git", "dist", "node_modules"]);
const indentationCheckedExtensions = new Set([".css", ".html", ".js", ".json", ".mjs", ".cjs"]);
const javaScriptExtensions = new Set([".js", ".mjs", ".cjs"]);
const failures = [];

async function collectFiles(directory) {
	const directoryEntries = await readdir(directory, { withFileTypes: true });
	const files = [];

	for (const directoryEntry of directoryEntries) {
		if (ignoredDirectories.has(directoryEntry.name)) {
			continue;
		}

		const absolutePath = path.join(directory, directoryEntry.name);

		if (directoryEntry.isDirectory()) {
			files.push(...await collectFiles(absolutePath));
		} else if (directoryEntry.isFile()) {
			files.push(absolutePath);
		}
	}

	return files;
}

function relativePath(absolutePath) {
	return path.relative(rootDirectory, absolutePath).split(path.sep).join("/");
}

function checkWhitespace(filePath, source) {
	const lines = source.split("\n");

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const leadingWhitespace = line.match(/^[\t ]+/u)?.[0] ?? "";
		const afterLeadingTabs = line.replace(/^\t*/u, "");
		const isDocumentationPrefix = afterLeadingTabs.startsWith(" *")
			|| afterLeadingTabs === " */";

		if (leadingWhitespace.includes(" ") && !isDocumentationPrefix) {
			failures.push(`${relativePath(filePath)}:${index + 1} uses spaces in leading indentation.`);
		}

		if (/[\t ]+$/u.test(line)) {
			failures.push(`${relativePath(filePath)}:${index + 1} contains trailing whitespace.`);
		}
	}
}

function checkJavaScriptSyntax(filePath) {
	try {
		execFileSync(process.execPath, ["--check", filePath], {
			cwd: rootDirectory,
			stdio: "pipe"
		});
	} catch (error) {
		failures.push(`${relativePath(filePath)} failed node --check:\n${error.stderr?.toString() ?? error.message}`);
	}
}

async function checkJson(filePath, source) {
	try {
		JSON.parse(source);
	} catch (error) {
		failures.push(`${relativePath(filePath)} is invalid JSON: ${error.message}`);
	}
}

async function checkManifest() {
	const manifestPath = path.join(rootDirectory, "public", "manifest.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	const requiredPermissions = [...(manifest.permissions ?? [])].sort();
	const expectedPermissions = ["activeTab", "scripting", "storage"].sort();

	if (manifest.manifest_version !== 3) {
		failures.push("public/manifest.json must use Manifest V3.");
	}

	if (JSON.stringify(requiredPermissions) !== JSON.stringify(expectedPermissions)) {
		failures.push("Required permissions must be exactly storage, activeTab, and scripting.");
	}

	if (requiredPermissions.includes("clipboardWrite")) {
		failures.push("clipboardWrite must not be a required permission.");
	}

	if (!(manifest.optional_permissions ?? []).includes("clipboardWrite")) {
		failures.push("clipboardWrite must be declared only as an optional permission.");
	}

	if (manifest.host_permissions?.length) {
		failures.push("The extension must not request persistent host permissions.");
	}

	if (Number.parseInt(manifest.minimum_chrome_version, 10) < 127) {
		failures.push("minimum_chrome_version must support chrome.action.openPopup for all users.");
	}

	if (manifest.background?.type !== "module") {
		failures.push("The Manifest V3 service worker must be declared as a module.");
	}

	const referencedFiles = [
		manifest.options_ui?.page,
		...Object.values(manifest.icons ?? {}),
		...Object.values(manifest.action?.default_icon ?? {})
	].filter(Boolean);

	for (const referencedFile of new Set(referencedFiles)) {
		try {
			await readFile(path.join(rootDirectory, "public", referencedFile));
		} catch (error) {
			failures.push(`Manifest asset is missing: public/${referencedFile}`);
		}
	}
}

async function checkHtmlAssets() {
	for (const htmlName of ["options.html", "popup.html"]) {
		const source = await readFile(path.join(rootDirectory, "public", htmlName), "utf8");
		const remoteExecutableReference = /<(?:script|link)\b[^>]+(?:src|href)=["']https?:\/\//iu.test(source);

		if (remoteExecutableReference) {
			failures.push(`public/${htmlName} references remote executable code or styles.`);
		}
	}
}

const files = await collectFiles(rootDirectory);

for (const filePath of files) {
	const extension = path.extname(filePath).toLowerCase();

	if (!indentationCheckedExtensions.has(extension)) {
		continue;
	}

	const source = await readFile(filePath, "utf8");
	checkWhitespace(filePath, source);

	if (javaScriptExtensions.has(extension)) {
		checkJavaScriptSyntax(filePath);
	}

	if (extension === ".json") {
		await checkJson(filePath, source);
	}
}

await checkManifest();
await checkHtmlAssets();

for (const requiredPath of [
	"package.json",
	"webpack.config.js",
	"public/manifest.json",
	"src/background.js",
	"src/content.js",
	"src/options.js",
	"src/popup.js"
]) {
	if (!files.some((filePath) => relativePath(filePath) === requiredPath)) {
		failures.push(`Required project file is missing: ${requiredPath}`);
	}
}

if (failures.length > 0) {
	console.error(`Source validation failed with ${failures.length} issue(s):`);

	for (const failure of failures) {
		console.error(`- ${failure}`);
	}

	process.exitCode = 1;
} else {
	console.log(`Source validation passed for ${files.length} files.`);
}
