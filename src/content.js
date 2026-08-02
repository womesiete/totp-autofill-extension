(() => {
	const STATE_KEY = "__offlineTotpAutofillContentState";
	const TOAST_HOST_ID = "__offline_totp_autofill_toast__";

	/**
	 * chrome.scripting.executeScript may inject this bundle repeatedly into the
	 * same page. A state object on the isolated-world global prevents duplicate
	 * message listeners while still allowing each invocation to confirm that the
	 * listener is ready before the background worker sends applyTotp.
	 */
	if (globalThis[STATE_KEY]?.listenerInstalled) {
		return;
	}

	const state = {
		listenerInstalled: true,
		toastRemovalTimer: null
	};
	globalThis[STATE_KEY] = state;

	chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
		if (message?.type !== "applyTotp") {
			return false;
		}

		void applyTotp(message.payload)
			.then(sendResponse)
			.catch((error) => {
				sendResponse({
					autofill: {
						attempted: Boolean(message.payload?.actions?.autofill),
						filled: false,
						error: error.message
					},
					toast: {
						shown: false
					},
					copy: {
						attempted: Boolean(message.payload?.actions?.copy),
						copied: false
					}
				});
			});

		return true;
	});

	async function applyTotp(payload) {
		const code = String(payload?.code ?? "");
		const actions = payload?.actions ?? {};

		if (!/^\d{6,8}$/u.test(code)) {
			throw new Error("The generated TOTP code has an unexpected format.");
		}

		/**
		 * Autofill, toast, and copy are intentionally independent. A page with no
		 * detectable input can still display or copy the code, and one failed
		 * behavior does not suppress the others.
		 */
		const autofill = actions.autofill
			? autofillCode(code)
			: {
				attempted: false,
				filled: false
			};
		const toast = actions.toast
			? showToast(code, String(payload?.label ?? "Authenticator code"), payload?.toastDurationMs)
			: {
				shown: false
			};
		const copy = actions.copy
			? await copyCode(code)
			: {
				attempted: false,
				copied: false
			};

		return {
			autofill,
			toast,
			copy
		};
	}

	function autofillCode(code) {
		const inputs = collectInputs(document);
		const segmentedResult = fillSegmentedInputs(inputs, code);

		if (segmentedResult.filled) {
			return segmentedResult;
		}

		const candidates = inputs
			.filter(isEligibleInput)
			.map((input) => ({
				input,
				score: scoreInput(input, code.length)
			}))
			.sort((left, right) => right.score - left.score);
		const best = candidates[0];

		if (!best || best.score < 45) {
			return {
				attempted: true,
				filled: false,
				reason: "No likely one-time-code input was found."
			};
		}

		setFrameworkCompatibleValue(best.input, code);
		best.input.focus({ preventScroll: true });

		return {
			attempted: true,
			filled: true,
			mode: "single-input",
			score: best.score
		};
	}

	/**
	 * Traverse the document and every open shadow root. Authentication widgets
	 * frequently encapsulate their controls in web components, but closed shadow
	 * roots remain intentionally inaccessible to extensions and page scripts.
	 */
	function collectInputs(root) {
		const inputs = [];
		const walkerRoot = root instanceof Document ? root.documentElement : root;

		if (!walkerRoot) {
			return inputs;
		}

		const visit = (node) => {
			if (node instanceof HTMLInputElement) {
				inputs.push(node);
			}

			if (node.shadowRoot) {
				visit(node.shadowRoot);
			}

			for (const child of node.children ?? []) {
				visit(child);
			}
		};

		visit(walkerRoot);
		return inputs;
	}

	function isEligibleInput(input) {
		const allowedTypes = new Set(["text", "tel", "number", "password", ""]);

		return allowedTypes.has(input.type)
			&& !input.disabled
			&& !input.readOnly
			&& isVisible(input);
	}

	function isVisible(element) {
		const style = globalThis.getComputedStyle(element);
		const rectangle = element.getBoundingClientRect();

		return style.visibility !== "hidden"
			&& style.display !== "none"
			&& Number.parseFloat(style.opacity || "1") > 0
			&& rectangle.width > 0
			&& rectangle.height > 0;
	}

	function scoreInput(input, codeLength) {
		const attributes = [
			input.name,
			input.id,
			input.placeholder,
			input.getAttribute("aria-label"),
			input.getAttribute("data-testid"),
			getAssociatedLabelText(input)
		]
			.filter(Boolean)
			.join(" ")
			.toLowerCase();
		let score = 0;

		if (input === document.activeElement) {
			score += 28;
		}

		if (input.autocomplete === "one-time-code") {
			score += 120;
		}

		if (/(totp|otp|2fa|mfa)/u.test(attributes)) {
			score += 85;
		}

		if (/one[\s_-]*time|auth(?:entication|enticator)?[\s_-]*code|verification[\s_-]*code/u.test(attributes)) {
			score += 70;
		}

		if (/security[\s_-]*code|pass[\s_-]*code|login[\s_-]*code|token/u.test(attributes)) {
			score += 45;
		}

		if (/\bcode\b/u.test(attributes)) {
			score += 45;
		}

		if (input.maxLength === codeLength) {
			score += 22;
		}

		if (input.inputMode === "numeric" || input.type === "number" || input.type === "tel") {
			score += 12;
		}

		if (/password|email|username|phone|search|captcha|postal|zip/u.test(attributes)) {
			score -= 80;
		}

		if (input.type === "password" && !/(otp|totp|2fa|mfa|code|token)/u.test(attributes)) {
			score -= 35;
		}

		return score;
	}

	function getAssociatedLabelText(input) {
		const values = [];

		if (input.labels) {
			for (const label of input.labels) {
				values.push(label.textContent ?? "");
			}
		}

		const closestLabel = input.closest("label");

		if (closestLabel) {
			values.push(closestLabel.textContent ?? "");
		}

		return values.join(" ").trim();
	}

	/**
	 * Segmented OTP widgets use one maxlength=1 input per digit. Filling such a
	 * group first avoids placing the entire token into only the first box. A
	 * group is accepted only when at least one member has OTP-specific metadata
	 * or the currently focused element belongs to the group.
	 */
	function fillSegmentedInputs(inputs, code) {
		const oneCharacterInputs = inputs.filter((input) => {
			return isEligibleInput(input)
				&& input.maxLength === 1
				&& (input.inputMode === "numeric" || input.type === "tel" || input.type === "text");
		});

		if (oneCharacterInputs.length < code.length) {
			return {
				attempted: true,
				filled: false
			};
		}

		const groups = new Map();

		for (const input of oneCharacterInputs) {
			const groupRoot = input.closest("[role='group'], fieldset, form") ?? input.parentElement;

			if (!groupRoot) {
				continue;
			}

			const group = groups.get(groupRoot) ?? [];
			group.push(input);
			groups.set(groupRoot, group);
		}

		for (const group of groups.values()) {
			if (group.length < code.length) {
				continue;
			}

			group.sort(compareDocumentOrder);
			const targetInputs = group.slice(0, code.length);
			const includesFocus = targetInputs.includes(document.activeElement);
			const hasOtpMetadata = targetInputs.some((input) => {
				const attributes = [
					input.name,
					input.id,
					input.placeholder,
					input.getAttribute("aria-label"),
					getAssociatedLabelText(input)
				]
					.filter(Boolean)
					.join(" ")
					.toLowerCase();

				return input.autocomplete === "one-time-code"
					|| /(totp|otp|2fa|mfa|one[\s_-]*time|verification[\s_-]*code|auth(?:entication|enticator)?[\s_-]*code)/u.test(attributes);
			});

			if (!hasOtpMetadata && !includesFocus) {
				continue;
			}

			targetInputs.forEach((input, index) => {
				setFrameworkCompatibleValue(input, code[index]);
			});
			targetInputs[targetInputs.length - 1].focus({ preventScroll: true });

			return {
				attempted: true,
				filled: true,
				mode: "segmented-inputs",
				count: targetInputs.length
			};
		}

		return {
			attempted: true,
			filled: false
		};
	}

	function compareDocumentOrder(left, right) {
		const position = left.compareDocumentPosition(right);
		return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
	}

	/**
	 * Calling the native HTMLInputElement setter updates the DOM value even when
	 * a framework such as React has installed an instance-level value tracker.
	 * Bubbling input and change events then notify the framework without clicking
	 * submit buttons or dispatching an Enter key.
	 */
	function setFrameworkCompatibleValue(input, value) {
		const prototype = Object.getPrototypeOf(input);
		const descriptor = Object.getOwnPropertyDescriptor(prototype, "value")
			?? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");

		if (descriptor?.set) {
			descriptor.set.call(input, value);
		} else {
			input.value = value;
		}

		try {
			input.dispatchEvent(new InputEvent("input", {
				bubbles: true,
				composed: true,
				data: value,
				inputType: "insertText"
			}));
		} catch (error) {
			input.dispatchEvent(new Event("input", {
				bubbles: true,
				composed: true
			}));
		}

		input.dispatchEvent(new Event("change", {
			bubbles: true,
			composed: true
		}));
	}

	function showToast(code, label, requestedDuration) {
		const existing = document.getElementById(TOAST_HOST_ID);

		if (existing) {
			existing.remove();
		}

		if (state.toastRemovalTimer) {
			clearTimeout(state.toastRemovalTimer);
		}

		const host = document.createElement("div");
		host.id = TOAST_HOST_ID;
		host.setAttribute("data-extension-owned", "true");
		const shadowRoot = host.attachShadow({ mode: "open" });
		const style = document.createElement("style");
		style.textContent = `
			:host {
				all: initial;
				position: fixed;
				right: 20px;
				bottom: 20px;
				z-index: 2147483647;
				font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
			}
			.notice {
				box-sizing: border-box;
				min-width: 250px;
				max-width: min(360px, calc(100vw - 40px));
				padding: 16px 18px;
				border: 1px solid rgba(255, 255, 255, 0.18);
				border-radius: 14px;
				background: #111827;
				box-shadow: 0 18px 48px rgba(15, 23, 42, 0.36);
				color: #f8fafc;
			}
			.label {
				margin: 0 0 7px;
				font-size: 13px;
				font-weight: 600;
				line-height: 1.35;
				color: #cbd5e1;
			}
			.code {
				margin: 0;
				font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
				font-size: 28px;
				font-weight: 750;
				letter-spacing: 0.18em;
				line-height: 1.2;
				color: #ffffff;
			}
			.hint {
				margin: 8px 0 0;
				font-size: 12px;
				line-height: 1.35;
				color: #94a3b8;
			}
		`;
		const notice = document.createElement("div");
		notice.className = "notice";
		notice.setAttribute("role", "status");
		notice.setAttribute("aria-live", "polite");
		const labelElement = document.createElement("p");
		labelElement.className = "label";
		labelElement.textContent = label;
		const codeElement = document.createElement("p");
		codeElement.className = "code";
		codeElement.textContent = code;
		const hint = document.createElement("p");
		hint.className = "hint";
		hint.textContent = "Code generated locally. The form was not submitted.";
		notice.append(labelElement, codeElement, hint);
		shadowRoot.append(style, notice);
		(document.body ?? document.documentElement).append(host);

		const duration = Number.isFinite(requestedDuration)
			? Math.max(1000, Math.min(30000, requestedDuration))
			: 10000;
		state.toastRemovalTimer = setTimeout(() => {
			host.remove();
			state.toastRemovalTimer = null;
		}, duration);

		return {
			shown: true,
			durationMs: duration
		};
	}

	async function copyCode(code) {
		try {
			await navigator.clipboard.writeText(code);
			return {
				attempted: true,
				copied: true,
				method: "clipboard-api"
			};
		} catch (clipboardError) {
			const textarea = document.createElement("textarea");
			textarea.value = code;
			textarea.setAttribute("readonly", "");
			textarea.style.position = "fixed";
			textarea.style.left = "-9999px";
			textarea.style.opacity = "0";
			(document.body ?? document.documentElement).append(textarea);
			textarea.select();
			let copied = false;

			try {
				copied = document.execCommand("copy");
			} catch (fallbackError) {
				copied = false;
			} finally {
				textarea.remove();
			}

			return {
				attempted: true,
				copied,
				method: "exec-command",
				error: copied ? undefined : clipboardError.message
			};
		}
	}
})();
