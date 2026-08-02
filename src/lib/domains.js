/**
 * Normalize a hostname returned by URL so matching is case-insensitive and a
 * trailing DNS root dot does not create a false mismatch.
 */
export function normalizeHostname(hostname) {
	return String(hostname ?? "")
		.trim()
		.toLowerCase()
		.replace(/\.$/u, "");
}

/**
 * Native URL parsing is used for every active-tab URL. This intentionally does
 * not guess an eTLD+1 with a hard-coded suffix list. Instead, users store the
 * root domain they want, and subdomains are matched safely by label boundary.
 */
export function hostnameFromUrl(url) {
	const parsedUrl = new URL(url);
	return normalizeHostname(parsedUrl.hostname);
}

/**
 * Accept either a bare domain or a full URL in imports and the options form.
 * Leading wildcard and www labels are removed because entries represent the
 * root matching scope rather than one exact presentation hostname.
 */
export function normalizeStoredDomain(value) {
	const input = String(value ?? "").trim();

	if (!input) {
		throw new Error("A domain is required.");
	}

	const withoutWildcard = input.replace(/^\*\./u, "");
	let hostname;

	try {
		hostname = hostnameFromUrl(
			withoutWildcard.includes("://")
				? withoutWildcard
				: `https://${withoutWildcard}`
		);
	} catch (error) {
		throw new Error("Enter a valid domain such as example.com.");
	}

	hostname = hostname.replace(/^www\./u, "");

	if (!hostname || hostname.includes(" ")) {
		throw new Error("Enter a valid domain such as example.com.");
	}

	return hostname;
}

/**
 * The explicit dot boundary prevents a stored example.com entry from matching
 * an attacker-controlled notexample.com hostname.
 */
export function domainMatches(hostname, storedDomain) {
	const normalizedHostname = normalizeHostname(hostname);
	const normalizedStoredDomain = normalizeStoredDomain(storedDomain);

	return normalizedHostname === normalizedStoredDomain
		|| normalizedHostname.endsWith(`.${normalizedStoredDomain}`);
}

/**
 * Prefer the longest matching domain so a specific login.example.com entry can
 * override a broader example.com entry when both are present.
 */
export function findBestDomainMatch(entries, hostname) {
	const matches = entries
		.filter((entry) => domainMatches(hostname, entry.domain))
		.sort((left, right) => {
			const lengthDifference = right.domain.length - left.domain.length;

			if (lengthDifference !== 0) {
				return lengthDifference;
			}

			return left.label.localeCompare(right.label);
		});

	return matches[0] ?? null;
}

export function isInjectableUrl(url) {
	try {
		const protocol = new URL(url).protocol;
		return protocol === "http:" || protocol === "https:";
	} catch (error) {
		return false;
	}
}
