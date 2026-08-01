// popup/popup.js

document.addEventListener('DOMContentLoaded', () => {
	const statusDiv = document.getElementById('status');
	const manualSelectionDiv = document.getElementById('manual-selection');

	// Get the active tab's URL
	chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
		const currentUrl = tabs[0].url;
		
		// Send a message to the background script to check the URL
		chrome.runtime.sendMessage({ action: 'checkUrl', url: currentUrl }, (response) => {
			if (response && response.matchFound) {
				statusDiv.textContent = 'Match found!';
				// Logic to generate and display/autofill the TOTP
			} else {
				statusDiv.textContent = 'No match found.';
				manualSelectionDiv.style.display = 'block';
				// Logic to populate the manual selection dropdown
			}
		});
	});
});