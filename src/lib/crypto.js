import {
	AES_ALGORITHM,
	AES_KEY_LENGTH,
	IV_LENGTH_BYTES,
	PBKDF2_HASH,
	PBKDF2_ITERATIONS,
	SALT_LENGTH_BYTES,
	VAULT_AAD,
	VAULT_FORMAT_VERSION
} from "./constants.js";
import {
	base64ToBytes,
	bytesToBase64,
	decodeUtf8,
	encodeUtf8
} from "./encoding.js";

const AES_GCM_TAG_LENGTH = 128;
const MINIMUM_ACCEPTED_PBKDF2_ITERATIONS = 1000;
const MAXIMUM_ACCEPTED_PBKDF2_ITERATIONS = 5000000;

/**
 * Return the platform Web Crypto implementation. Chrome exposes it on
 * globalThis.crypto, and modern Node versions expose the same API for tests.
 */
function getWebCrypto() {
	if (!globalThis.crypto?.subtle) {
		throw new Error("Web Crypto is not available in this environment.");
	}

	return globalThis.crypto;
}

function randomBytes(length) {
	const bytes = new Uint8Array(length);
	getWebCrypto().getRandomValues(bytes);
	return bytes;
}

/**
 * PBKDF2 derives a 256-bit AES-GCM key from the user's password and the random
 * salt stored in the encrypted envelope. The key is extractable only because
 * the raw bytes must be placed in chrome.storage.session so they survive MV3
 * service-worker suspension. The exported bytes never enter persistent local
 * storage.
 */
export async function deriveVaultKey(password, salt, options = {}) {
	if (typeof password !== "string" || password.length === 0) {
		throw new Error("A non-empty master password is required.");
	}

	const iterations = options.iterations ?? PBKDF2_ITERATIONS;
	const hash = options.hash ?? PBKDF2_HASH;

	if (
		!Number.isInteger(iterations)
		|| iterations < MINIMUM_ACCEPTED_PBKDF2_ITERATIONS
		|| iterations > MAXIMUM_ACCEPTED_PBKDF2_ITERATIONS
	) {
		throw new Error("PBKDF2 iterations are outside the accepted range.");
	}

	if (hash !== PBKDF2_HASH) {
		throw new Error(`Unsupported PBKDF2 hash: ${String(hash)}`);
	}

	const cryptoApi = getWebCrypto();
	const passwordBytes = encodeUtf8(password);
	const passwordKey = await cryptoApi.subtle.importKey(
		"raw",
		passwordBytes,
		"PBKDF2",
		false,
		["deriveKey"]
	);

	try {
		return await cryptoApi.subtle.deriveKey(
			{
				name: "PBKDF2",
				salt,
				iterations,
				hash
			},
			passwordKey,
			{
				name: AES_ALGORITHM,
				length: AES_KEY_LENGTH
			},
			true,
			["encrypt", "decrypt"]
		);
	} finally {
		passwordBytes.fill(0);
	}
}

export async function exportVaultKey(key) {
	const rawKey = await getWebCrypto().subtle.exportKey("raw", key);
	const bytes = new Uint8Array(rawKey);
	const encoded = bytesToBase64(bytes);
	bytes.fill(0);
	return encoded;
}

/**
 * Reconstruct the non-extractable in-memory CryptoKey every time the service
 * worker needs it. This deliberately avoids relying on service-worker globals,
 * which Chrome may discard between events.
 */
export async function importVaultKey(encodedKey) {
	const bytes = base64ToBytes(encodedKey);

	try {
		if (bytes.length !== AES_KEY_LENGTH / 8) {
			throw new Error("The session encryption key has an invalid length.");
		}

		return await getWebCrypto().subtle.importKey(
			"raw",
			bytes,
			{
				name: AES_ALGORITHM,
				length: AES_KEY_LENGTH
			},
			false,
			["encrypt", "decrypt"]
		);
	} finally {
		bytes.fill(0);
	}
}

function decodeAndAssertLength(value, expectedLength, fieldName) {
	let bytes;

	try {
		bytes = base64ToBytes(value);
	} catch (error) {
		throw new Error(`The encrypted vault ${fieldName} is not valid Base64.`);
	}

	try {
		if (bytes.length !== expectedLength) {
			throw new Error(`The encrypted vault ${fieldName} has an invalid length.`);
		}
	} finally {
		bytes.fill(0);
	}
}

function validateCiphertext(value) {
	let bytes;

	try {
		bytes = base64ToBytes(value);
	} catch (error) {
		throw new Error("The encrypted vault ciphertext is not valid Base64.");
	}

	try {
		if (bytes.length <= AES_GCM_TAG_LENGTH / 8) {
			throw new Error("The encrypted vault ciphertext is too short.");
		}
	} finally {
		bytes.fill(0);
	}
}

function validateEnvelope(envelope) {
	if (!envelope || typeof envelope !== "object") {
		throw new Error("The encrypted vault envelope is invalid.");
	}

	if (envelope.version !== VAULT_FORMAT_VERSION) {
		throw new Error(`Unsupported vault format version: ${String(envelope.version)}`);
	}

	if (
		envelope.kdf?.name !== "PBKDF2"
		|| typeof envelope.kdf?.salt !== "string"
		|| !Number.isInteger(envelope.kdf?.iterations)
		|| envelope.kdf.iterations < MINIMUM_ACCEPTED_PBKDF2_ITERATIONS
		|| envelope.kdf.iterations > MAXIMUM_ACCEPTED_PBKDF2_ITERATIONS
		|| envelope.kdf?.hash !== PBKDF2_HASH
	) {
		throw new Error("The encrypted vault KDF metadata is invalid.");
	}

	if (
		envelope.cipher?.name !== AES_ALGORITHM
		|| envelope.cipher?.tagLength !== AES_GCM_TAG_LENGTH
		|| typeof envelope.cipher?.iv !== "string"
		|| typeof envelope.cipher?.data !== "string"
	) {
		throw new Error("The encrypted vault cipher metadata is invalid.");
	}

	decodeAndAssertLength(envelope.kdf.salt, SALT_LENGTH_BYTES, "salt");
	decodeAndAssertLength(envelope.cipher.iv, IV_LENGTH_BYTES, "initialization vector");
	validateCiphertext(envelope.cipher.data);

	return envelope;
}

export function parseVaultEnvelope(serializedEnvelope) {
	if (typeof serializedEnvelope !== "string" || serializedEnvelope.length === 0) {
		throw new Error("No encrypted vault is available.");
	}

	try {
		return validateEnvelope(JSON.parse(serializedEnvelope));
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error("The encrypted vault is not valid JSON.");
		}

		throw error;
	}
}

/**
 * The KDF and cipher metadata are authenticated as AES-GCM additional data.
 * Modifying the salt, work factor, algorithm, format version, or tag length
 * therefore invalidates the vault even when an already-unlocked session key is
 * available. Only the IV and ciphertext remain outside this canonical block;
 * AES-GCM inherently authenticates both during decryption.
 */
function encodeEnvelopeAdditionalData(kdfMetadata) {
	return encodeUtf8(JSON.stringify({
		context: VAULT_AAD,
		version: VAULT_FORMAT_VERSION,
		kdf: kdfMetadata,
		cipher: {
			name: AES_ALGORITHM,
			tagLength: AES_GCM_TAG_LENGTH
		}
	}));
}

async function encryptWithKey(vault, key, kdfMetadata) {
	const cryptoApi = getWebCrypto();
	const iv = randomBytes(IV_LENGTH_BYTES);
	const plaintext = encodeUtf8(JSON.stringify(vault));
	const additionalData = encodeEnvelopeAdditionalData(kdfMetadata);

	try {
		const encrypted = await cryptoApi.subtle.encrypt(
			{
				name: AES_ALGORITHM,
				iv,
				additionalData,
				tagLength: AES_GCM_TAG_LENGTH
			},
			key,
			plaintext
		);

		return JSON.stringify({
			version: VAULT_FORMAT_VERSION,
			kdf: kdfMetadata,
			cipher: {
				name: AES_ALGORITHM,
				tagLength: AES_GCM_TAG_LENGTH,
				iv: bytesToBase64(iv),
				data: bytesToBase64(new Uint8Array(encrypted))
			}
		});
	} finally {
		plaintext.fill(0);
		additionalData.fill(0);
		iv.fill(0);
	}
}

/**
 * Create a new encrypted vault and return the session-safe raw key alongside
 * the single serialized encrypted string that belongs in storage.local.
 */
export async function createEncryptedVault(vault, password, options = {}) {
	const salt = randomBytes(SALT_LENGTH_BYTES);
	const iterations = options.iterations ?? PBKDF2_ITERATIONS;
	const hash = options.hash ?? PBKDF2_HASH;
	const key = await deriveVaultKey(password, salt, { iterations, hash });

	try {
		const serializedEnvelope = await encryptWithKey(vault, key, {
			name: "PBKDF2",
			hash,
			iterations,
			salt: bytesToBase64(salt)
		});
		const encodedKey = await exportVaultKey(key);

		return {
			serializedEnvelope,
			encodedKey
		};
	} finally {
		salt.fill(0);
	}
}

/**
 * Decrypt and authenticate the vault. AES-GCM rejects incorrect passwords and
 * any modification to the ciphertext, IV, or authenticated envelope metadata.
 */
export async function decryptVaultWithKey(serializedEnvelope, key) {
	const envelope = parseVaultEnvelope(serializedEnvelope);
	const iv = base64ToBytes(envelope.cipher.iv);
	const ciphertext = base64ToBytes(envelope.cipher.data);
	const additionalData = encodeEnvelopeAdditionalData(envelope.kdf);
	let plaintextBytes = null;

	try {
		const plaintext = await getWebCrypto().subtle.decrypt(
			{
				name: AES_ALGORITHM,
				iv,
				additionalData,
				tagLength: envelope.cipher.tagLength
			},
			key,
			ciphertext
		);
		plaintextBytes = new Uint8Array(plaintext);
		return JSON.parse(decodeUtf8(plaintextBytes));
	} catch (error) {
		throw new Error("Unable to decrypt the vault. The password may be incorrect or the vault may be damaged.");
	} finally {
		plaintextBytes?.fill(0);
		additionalData.fill(0);
		iv.fill(0);
		ciphertext.fill(0);
	}
}

export async function unlockEncryptedVault(serializedEnvelope, password) {
	const envelope = parseVaultEnvelope(serializedEnvelope);
	const salt = base64ToBytes(envelope.kdf.salt);
	const key = await deriveVaultKey(password, salt, {
		iterations: envelope.kdf.iterations,
		hash: envelope.kdf.hash
	});

	try {
		const vault = await decryptVaultWithKey(serializedEnvelope, key);
		const encodedKey = await exportVaultKey(key);

		return {
			vault,
			encodedKey
		};
	} finally {
		salt.fill(0);
	}
}

/**
 * Saving entry changes reuses the already-derived session key, rotates the
 * AES-GCM IV, and preserves the original PBKDF2 metadata. The password itself
 * is therefore never needed after the session has been unlocked.
 */
export async function reencryptVault(serializedEnvelope, vault, key) {
	const envelope = parseVaultEnvelope(serializedEnvelope);
	return encryptWithKey(vault, key, envelope.kdf);
}
