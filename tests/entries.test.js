import assert from "node:assert/strict";
import test from "node:test";
import {
	estimateSecretBytes,
	maskSecret,
	normalizeBase32Secret,
	normalizeEntry,
	parseSecretInput,
	sortEntries
} from "../src/lib/entries.js";

test("Base32 input is normalized without changing its significant data", () => {
	assert.equal(normalizeBase32Secret("jbsw y3dp-ehpk3pxp=="), "JBSWY3DPEHPK3PXP");
	assert.equal(estimateSecretBytes("JBSWY3DPEHPK3PXP"), 10);
	assert.equal(maskSecret("JBSWY3DPEHPK3PXP"), "•••• •••• 3PXP");
});

test("otpauth URIs supply standard TOTP metadata", () => {
	const parsed = parseSecretInput(
		"otpauth://totp/Acme:user%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Acme&algorithm=SHA256&digits=8&period=45"
	);

	assert.deepEqual(parsed, {
		secret: "JBSWY3DPEHPK3PXP",
		label: "user@example.com",
		algorithm: "sha256",
		digits: 8,
		period: 45
	});
});

test("entries receive normalized domains and safe defaults", () => {
	const entry = normalizeEntry({
		label: "Acme admin",
		domain: "https://www.Admin.Acme.test/login",
		secret: "JBSWY3DPEHPK3PXP"
	});

	assert.equal(entry.label, "Acme admin");
	assert.equal(entry.domain, "admin.acme.test");
	assert.equal(entry.algorithm, "sha1");
	assert.equal(entry.digits, 6);
	assert.equal(entry.period, 30);
	assert.match(entry.id, /^[0-9a-f-]{36}$/u);
});

test("entry validation rejects unsupported parameters", () => {
	assert.throws(() => normalizeEntry({
		label: "Bad",
		domain: "example.com",
		secret: "JBSWY3DPEHPK3PXP",
		algorithm: "md5"
	}), /algorithm/u);
	assert.throws(() => normalizeEntry({
		label: "Bad",
		domain: "example.com",
		secret: "not-base32!"
	}), /Base32/u);
	assert.throws(() => normalizeEntry({
		label: "Bad",
		domain: "example.com",
		secret: "JBSWY3DPEHPK3PXP",
		period: 5
	}), /between 15 and 120/u);
});

test("entries are sorted predictably by label and domain", () => {
	const sorted = sortEntries([
		{ label: "Zulu", domain: "z.example" },
		{ label: "Alpha", domain: "b.example" },
		{ label: "Alpha", domain: "a.example" }
	]);

	assert.deepEqual(sorted.map((entry) => entry.domain), ["a.example", "b.example", "z.example"]);
});
