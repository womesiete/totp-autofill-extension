import assert from "node:assert/strict";
import test from "node:test";
import { getRemainingSeconds } from "../src/lib/time.js";

async function loadTotpModule(testContext) {
	try {
		return await import("../src/lib/totp.js");
	} catch (error) {
		if (error?.code === "ERR_MODULE_NOT_FOUND" && String(error.message).includes("otplib")) {
			testContext.skip("Install npm dependencies to execute otplib integration tests.");
			return null;
		}

		throw error;
	}
}

test("otplib produces the RFC 6238 SHA-1 test vector", async (testContext) => {
	const module = await loadTotpModule(testContext);

	if (!module) {
		return;
	}

	const code = await module.generateTotp({
		secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
		algorithm: "sha1",
		digits: 8,
		period: 30
	}, 59);

	assert.equal(code, "94287082");
});

test("the compatibility guardrail accepts common 80-bit secrets", async (testContext) => {
	const module = await loadTotpModule(testContext);

	if (!module) {
		return;
	}

	const code = await module.generateTotp({
		secret: "JBSWY3DPEHPK3PXP",
		algorithm: "sha1",
		digits: 6,
		period: 30
	}, 1700000000);

	assert.match(code, /^\d{6}$/u);
});

test("remaining-time calculation resets at the start of each period", () => {
	assert.equal(getRemainingSeconds(30, 60000), 30);
	assert.equal(getRemainingSeconds(30, 61000), 29);
	assert.equal(getRemainingSeconds(45, 89000), 1);
});
