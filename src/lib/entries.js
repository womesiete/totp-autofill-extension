import { normalizeStoredDomain } from "./domains.js";

const ALGORITHMS = new Set(["sha1", "sha256", "sha512"]);
const DIGIT_LENGTHS = new Set([6, 7, 8]);
const BASE32_PATTERN = /^[A-Z2-7]+$/u;

function createId() {
	if (typeof globalThis.crypto?.randomUUID === "function") {
		return globalThis.crypto.randomUUID();
	}

	const random = new Uint8Array(16);
	globalThis.crypto.getRandomValues(random);
	random[6] = (random[6] & 0x0f) | 0x40;
	random[8] = (random[8] & 0x3f) | 0x80;
	const hex = [...random].map((value) => value.toString(16).padStart(2, "0"));

	return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function parseInteger(value, fallback) {
	if (value === null || value === undefined || String(value).trim() === "") {
		return fallback;
	}

	const parsed = Number(value);
	return Number.isInteger(parsed) ? parsed : Number.NaN;
}

/**
 * Imports may provide either a bare Base32 secret or a standard otpauth URI.
 * URI metadata is preserved as defaults while the encrypted database stores a
 * normalized, unpadded Base32 secret.
 */
export function parseSecretInput(value) {
	const input = String(value ?? "").trim();

	if (!input) {
		throw new Error("A TOTP secret is required.");
	}

	if (input.toLowerCase().startsWith("otpauth://")) {
		let uri;

		try {
			uri = new URL(input);
		} catch (error) {
			throw new Error("The otpauth URI is invalid.");
		}

		if (uri.protocol !== "otpauth:" || uri.hostname.toLowerCase() !== "totp") {
			throw new Error("Only otpauth://totp URIs are supported.");
		}

		const pathLabel = decodeURIComponent(uri.pathname.replace(/^\//u, ""));
		const secret = normalizeBase32Secret(uri.searchParams.get("secret"));
		const issuer = uri.searchParams.get("issuer")?.trim() ?? "";
		const labelWithoutIssuer = pathLabel.includes(":")
			? pathLabel.slice(pathLabel.indexOf(":") + 1).trim()
			: pathLabel.trim();

		return {
			secret,
			label: labelWithoutIssuer || issuer,
			algorithm: String(uri.searchParams.get("algorithm") ?? "sha1").toLowerCase(),
			digits: parseInteger(uri.searchParams.get("digits"), 6),
			period: parseInteger(uri.searchParams.get("period"), 30)
		};
	}

	return {
		secret: normalizeBase32Secret(input),
		label: "",
		algorithm: "sha1",
		digits: 6,
		period: 30
	};
}

export function normalizeBase32Secret(value) {
	const secret = String(value ?? "")
		.toUpperCase()
		.replace(/[\s-]+/gu, "")
		.replace(/=+$/u, "");

	if (!secret || !BASE32_PATTERN.test(secret)) {
		throw new Error("The secret must be an unpadded Base32 value using A-Z and 2-7.");
	}

	return secret;
}

export function estimateSecretBytes(secret) {
	return Math.floor((normalizeBase32Secret(secret).length * 5) / 8);
}

/**
 * Normalize and validate every entry at the service-worker boundary. Existing
 * timestamps and IDs survive edits, while imported records receive safe new
 * identifiers when necessary.
 */
export function normalizeEntry(rawEntry, existingEntry = null) {
	if (!rawEntry || typeof rawEntry !== "object") {
		throw new Error("Each imported entry must be a JSON object.");
	}

	const parsedSecret = parseSecretInput(rawEntry.secret);
	const label = String(rawEntry.label ?? parsedSecret.label ?? "").trim();
	const algorithm = String(rawEntry.algorithm ?? parsedSecret.algorithm ?? "sha1").toLowerCase();
	const digits = parseInteger(rawEntry.digits ?? parsedSecret.digits, 6);
	const period = parseInteger(rawEntry.period ?? parsedSecret.period, 30);

	if (!label) {
		throw new Error("A label is required.");
	}

	if (label.length > 100) {
		throw new Error("Labels must be 100 characters or fewer.");
	}

	if (!ALGORITHMS.has(algorithm)) {
		throw new Error("The TOTP algorithm must be SHA-1, SHA-256, or SHA-512.");
	}

	if (!DIGIT_LENGTHS.has(digits)) {
		throw new Error("TOTP codes must contain 6, 7, or 8 digits.");
	}

	if (!Number.isInteger(period) || period < 15 || period > 120) {
		throw new Error("The TOTP period must be an integer between 15 and 120 seconds.");
	}

	const now = new Date().toISOString();

	return {
		id: existingEntry?.id ?? (String(rawEntry.id ?? "").trim() || createId()),
		label,
		domain: normalizeStoredDomain(rawEntry.domain),
		secret: parsedSecret.secret,
		algorithm,
		digits,
		period,
		createdAt: existingEntry?.createdAt ?? String(rawEntry.createdAt ?? now),
		updatedAt: now
	};
}

export function createEmptyVault() {
	return {
		version: 1,
		entries: []
	};
}

export function validateVault(vault) {
	if (!vault || typeof vault !== "object" || vault.version !== 1 || !Array.isArray(vault.entries)) {
		throw new Error("The decrypted vault has an unsupported structure.");
	}

	return vault;
}

export function sortEntries(entries) {
	return [...entries].sort((left, right) => {
		const labelResult = left.label.localeCompare(right.label);
		return labelResult !== 0 ? labelResult : left.domain.localeCompare(right.domain);
	});
}

export function summarizeEntry(entry) {
	return {
		id: entry.id,
		label: entry.label,
		domain: entry.domain,
		digits: entry.digits,
		period: entry.period
	};
}

export function maskSecret(secret) {
	const normalized = normalizeBase32Secret(secret);
	return `•••• •••• ${normalized.slice(-4)}`;
}
