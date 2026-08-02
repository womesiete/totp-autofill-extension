const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Encode a JavaScript string as UTF-8 bytes for Web Crypto operations.
 */
export function encodeUtf8(value) {
	return textEncoder.encode(value);
}

/**
 * Decode UTF-8 bytes after authenticated AES-GCM decryption.
 */
export function decodeUtf8(value) {
	return textDecoder.decode(value);
}

/**
 * Convert bytes to Base64 without spreading a potentially large Uint8Array
 * into a function call. The Buffer branch exists only for Node-based tests;
 * Chrome uses btoa and never needs a Node polyfill in the production bundle.
 */
export function bytesToBase64(bytes) {
	if (typeof globalThis.btoa === "function") {
		let binary = "";
		const chunkSize = 0x8000;

		for (let offset = 0; offset < bytes.length; offset += chunkSize) {
			const chunk = bytes.subarray(offset, offset + chunkSize);
			binary += String.fromCharCode(...chunk);
		}

		return globalThis.btoa(binary);
	}

	if (globalThis.Buffer) {
		return globalThis.Buffer.from(bytes).toString("base64");
	}

	throw new Error("No Base64 encoder is available in this environment.");
}

/**
 * Decode Base64 into bytes. The result can be passed directly to importKey,
 * decrypt, or any other Web Crypto API that accepts a BufferSource.
 */
export function base64ToBytes(value) {
	if (typeof globalThis.atob === "function") {
		const binary = globalThis.atob(value);
		const bytes = new Uint8Array(binary.length);

		for (let index = 0; index < binary.length; index += 1) {
			bytes[index] = binary.charCodeAt(index);
		}

		return bytes;
	}

	if (globalThis.Buffer) {
		return new Uint8Array(globalThis.Buffer.from(value, "base64"));
	}

	throw new Error("No Base64 decoder is available in this environment.");
}
