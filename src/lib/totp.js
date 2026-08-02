import { createGuardrails, generate } from "otplib";
import { MINIMUM_LEGACY_TOTP_SECRET_BYTES } from "./constants.js";

/**
 * Some established providers still issue 80-bit Base32 secrets. otplib v13
 * defaults to a stricter 128-bit minimum, so this explicit compatibility
 * guardrail accepts 10-byte legacy secrets while retaining all other library
 * validation and RFC 6238 behavior.
 */
const compatibilityGuardrails = createGuardrails({
	MIN_SECRET_BYTES: MINIMUM_LEGACY_TOTP_SECRET_BYTES
});

export async function generateTotp(entry, epochSeconds = Math.floor(Date.now() / 1000)) {
	return generate({
		secret: entry.secret,
		algorithm: entry.algorithm,
		digits: entry.digits,
		period: entry.period,
		epoch: epochSeconds,
		guardrails: compatibilityGuardrails
	});
}
