import assert from "node:assert/strict";
import test from "node:test";
import {
	domainMatches,
	findBestDomainMatch,
	hostnameFromUrl,
	isInjectableUrl,
	normalizeStoredDomain
} from "../src/lib/domains.js";

test("native URL parsing extracts and normalizes hostnames", () => {
	assert.equal(hostnameFromUrl("https://LOGIN.Example.com./mfa?next=1"), "login.example.com");
	assert.equal(normalizeStoredDomain("https://www.Example.com/login"), "example.com");
	assert.equal(normalizeStoredDomain("*.auth.example.com"), "auth.example.com");
});

test("domain matching uses an explicit DNS label boundary", () => {
	assert.equal(domainMatches("example.com", "example.com"), true);
	assert.equal(domainMatches("login.example.com", "example.com"), true);
	assert.equal(domainMatches("notexample.com", "example.com"), false);
	assert.equal(domainMatches("example.com.attacker.test", "example.com"), false);
});

test("the most specific configured domain wins", () => {
	const entries = [
		{ label: "General", domain: "example.com" },
		{ label: "Login", domain: "login.example.com" }
	];

	assert.equal(findBestDomainMatch(entries, "login.example.com")?.label, "Login");
	assert.equal(findBestDomainMatch(entries, "www.example.com")?.label, "General");
	assert.equal(findBestDomainMatch(entries, "unrelated.test"), null);
});

test("only regular web pages are injectable", () => {
	assert.equal(isInjectableUrl("https://example.com"), true);
	assert.equal(isInjectableUrl("http://localhost:8080"), true);
	assert.equal(isInjectableUrl("chrome://extensions"), false);
	assert.equal(isInjectableUrl("file:///tmp/login.html"), false);
	assert.equal(isInjectableUrl("not a url"), false);
});
