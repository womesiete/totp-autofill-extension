/**
 * Return the number of whole seconds remaining in the active TOTP period.
 * Epoch values are calculated in seconds because RFC 6238 and otplib v13 use
 * Unix timestamps in seconds rather than JavaScript millisecond timestamps.
 */
export function getRemainingSeconds(period, nowMilliseconds = Date.now()) {
	const nowSeconds = Math.floor(nowMilliseconds / 1000);
	const elapsed = nowSeconds % period;
	return elapsed === 0 ? period : period - elapsed;
}
