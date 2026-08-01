// background.js

chrome.runtime.onInstalled.addListener(() => {
	console.log("TOTP Autofill extension installed.");
	// Initialize default storage here if needed
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
	if (request.action === 'checkUrl') {
		// Logic to check the URL against the database will go here
		console.log("Checking URL:", request.url);
		// Example response
		sendResponse({ matchFound: false, url: request.url });
	}
	return true; // Indicates an asynchronous response
});