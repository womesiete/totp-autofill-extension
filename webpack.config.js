import path from "node:path";
import { fileURLToPath } from "node:url";
import CopyWebpackPlugin from "copy-webpack-plugin";

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFilePath);

/**
 * Webpack produces one self-contained bundle for each extension execution
 * context. Runtime chunk extraction and shared chunks are intentionally
 * disabled because Chrome loads the service worker, popup, options page, and
 * injected content script independently.
 *
 * Static extension assets are copied from public/ without transformation. The
 * source tree therefore keeps manifest metadata, HTML, CSS, and icons easy to
 * audit while JavaScript dependencies such as otplib are bundled locally. No
 * remote code is loaded at runtime, which is required by Manifest V3.
 */
export default (_environment, argumentsObject) => {
	const isProduction = argumentsObject.mode === "production";

	return {
		mode: isProduction ? "production" : "development",
		context: currentDirectory,
		entry: {
			background: "./src/background.js",
			content: "./src/content.js",
			options: "./src/options.js",
			popup: "./src/popup.js"
		},
		output: {
			path: path.resolve(currentDirectory, "dist"),
			filename: "[name].js",
			clean: true,
			globalObject: "globalThis"
		},
		/**
		 * Chrome 127 supports the APIs used by the dynamic-popup workflow and
		 * provides the modern JavaScript features emitted by this configuration.
		 */
		target: ["web", "es2022"],
		devtool: isProduction ? false : "source-map",
		plugins: [
			new CopyWebpackPlugin({
				patterns: [
					{
						from: path.resolve(currentDirectory, "public"),
						to: "."
					}
				]
			})
		],
		optimization: {
			/**
			 * Each entry must remain independently executable. A shared runtime or
			 * split chunk would not automatically be loaded when Chrome injects
			 * content.js with chrome.scripting.executeScript().
			 */
			runtimeChunk: false,
			splitChunks: false,
			minimize: isProduction
		},
		resolve: {
			extensions: [".js"]
		},
		performance: {
			hints: isProduction ? "warning" : false,
			maxAssetSize: 500000,
			maxEntrypointSize: 500000
		},
		stats: {
			preset: "errors-warnings",
			assets: true,
			colors: true
		}
	};
};
