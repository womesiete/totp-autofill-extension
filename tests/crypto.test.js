import assert from "node:assert/strict";
import test from "node:test";
import {
	createEncryptedVault,
	decryptVaultWithKey,
	importVaultKey,
	parseVaultEnvelope,
	reencryptVault,
	unlockEncryptedVault
} from "../src/lib/crypto.js";

const TEST_ITERATIONS = 1000;
const TEST_PASSWORD = "correct horse battery staple";
const TEST_VAULT = {
	version: 1,
	entries: [
		{
			id: "entry-1",
			label: "Example",
			domain: "example.com",
			secret: "JBSWY3DPEHPK3PXP",
			algorithm: "sha1",
			digits: 6,
			period: 30
		}
	]
};

test("the vault round-trips through AES-GCM without plaintext at rest", async () => {
	const encrypted = await createEncryptedVault(TEST_VAULT, TEST_PASSWORD, {
		iterations: TEST_ITERATIONS
	});

	assert.equal(encrypted.serializedEnvelope.includes("JBSWY3DPEHPK3PXP"), false);
	assert.equal(encrypted.serializedEnvelope.includes("example.com"), false);
	assert.equal(typeof encrypted.encodedKey, "string");
	assert.deepEqual((await unlockEncryptedVault(encrypted.serializedEnvelope, TEST_PASSWORD)).vault, TEST_VAULT);
});

test("wrong passwords and modified ciphertext fail authentication", async () => {
	const encrypted = await createEncryptedVault(TEST_VAULT, TEST_PASSWORD, {
		iterations: TEST_ITERATIONS
	});
	await assert.rejects(
		unlockEncryptedVault(encrypted.serializedEnvelope, "definitely the wrong password"),
		/Unable to decrypt/u
	);

	const envelope = parseVaultEnvelope(encrypted.serializedEnvelope);
	const dataCharacters = envelope.cipher.data.split("");
	dataCharacters[5] = dataCharacters[5] === "A" ? "B" : "A";
	envelope.cipher.data = dataCharacters.join("");
	await assert.rejects(
		unlockEncryptedVault(JSON.stringify(envelope), TEST_PASSWORD),
		/Unable to decrypt/u
	);
});

test("KDF metadata is authenticated for already-unlocked session keys", async () => {
	const encrypted = await createEncryptedVault(TEST_VAULT, TEST_PASSWORD, {
		iterations: TEST_ITERATIONS
	});
	const key = await importVaultKey(encrypted.encodedKey);
	const envelope = parseVaultEnvelope(encrypted.serializedEnvelope);
	envelope.kdf.iterations += 1;

	await assert.rejects(
		decryptVaultWithKey(JSON.stringify(envelope), key),
		/Unable to decrypt/u
	);
});

test("vault rewrites preserve KDF metadata and rotate the GCM IV", async () => {
	const encrypted = await createEncryptedVault(TEST_VAULT, TEST_PASSWORD, {
		iterations: TEST_ITERATIONS
	});
	const key = await importVaultKey(encrypted.encodedKey);
	const updatedVault = {
		...TEST_VAULT,
		entries: []
	};
	const rewritten = await reencryptVault(encrypted.serializedEnvelope, updatedVault, key);
	const originalEnvelope = parseVaultEnvelope(encrypted.serializedEnvelope);
	const rewrittenEnvelope = parseVaultEnvelope(rewritten);

	assert.deepEqual(rewrittenEnvelope.kdf, originalEnvelope.kdf);
	assert.notEqual(rewrittenEnvelope.cipher.iv, originalEnvelope.cipher.iv);
	assert.deepEqual(await decryptVaultWithKey(rewritten, key), updatedVault);
});

test("session keys must be exactly 256 bits", async () => {
	await assert.rejects(importVaultKey("AQIDBA=="), /invalid length/u);
});
