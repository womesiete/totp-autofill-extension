const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

// Webpack configuration to bundle background, popup, and content scripts
// along with any external dependencies like otplib.
module.exports = {
	entry: {
		background: './src/background.js',
		popup: './src/popup/popup.js',
		content: './src/content.js'
	},
	output: {
		path: path.resolve(__dirname, 'dist'),
		filename: '[name].js', // Output files will dynamically match the entry object keys
	},
	plugins: [
		// Copies static files from src to dist without modifying them
		new CopyPlugin({
			patterns: [
				{ from: "src/manifest.json", to: "manifest.json" },
				{ from: "src/popup/popup.html", to: "popup/popup.html" },
				{ from: "src/popup/popup.css", to: "popup/popup.css" },
				{ from: "src/icons", to: "icons" }
			],
		}),
	],
};