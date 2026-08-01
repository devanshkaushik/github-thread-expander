const EXPANSION_BATCH_SIZE = 10;
const STATE_POLL_INTERVAL_MS = 700;

const STATUS_STORAGE_KEY = "githubLoadMoreStatus";
const LOADER_METHODS = ["validatePage", "getState", "start"];

const actionButton = document.getElementById("actionButton");
const buttonText = document.getElementById("buttonText");
const statusEl = document.getElementById("status");
const pagePill = document.getElementById("pagePill");

let activeTabId = null;
let activeTabUrl = "";
let isValidPage = false;
let isRunning = false;
let currentPageInstanceId = null;
let statePollTimer = null;
let currentStatusMessage = statusEl.textContent;
let currentStatusType = "default";
let statusUpdateTimer = null;

function getTabStorageKey(tabId) {
	return `${STATUS_STORAGE_KEY}:${tabId}`;
}

function setStatus(message, type = "default") {
	if (message === currentStatusMessage && type === currentStatusType) {
		return;
	}

	currentStatusMessage = message;
	currentStatusType = type;

	statusEl.classList.add("updating");
	window.clearTimeout(statusUpdateTimer);

	statusUpdateTimer = window.setTimeout(() => {
		statusEl.textContent = message;
		statusEl.className = `status ${type === "default" ? "" : type}`.trim();
		statusUpdateTimer = null;
	}, 80);
}

function setButton({ text, disabled = false, loading = false }) {
	buttonText.textContent = text;
	actionButton.disabled = disabled;
	actionButton.classList.toggle("loading", loading);
}

function setPill(text) {
	pagePill.textContent = text;
}

function stopStatePolling() {
	if (!statePollTimer) return;

	window.clearInterval(statePollTimer);
	statePollTimer = null;
}

async function getActiveTab() {
	const [tab] = await chrome.tabs.query({
		active: true,
		currentWindow: true
	});

	return tab;
}

async function injectLoader(tabId) {
	await chrome.scripting.executeScript({
		target: { tabId },
		files: ["github-loader.js"]
	});
}

async function callLoader(tabId, method, args = []) {
	if (!LOADER_METHODS.includes(method)) {
		throw new Error(`Unsupported loader method: ${method}`);
	}

	const [result] = await chrome.scripting.executeScript({
		target: { tabId },
		args: [method, args],
		func: async (methodName, methodArgs) => {
			const methods = ["validatePage", "getState", "start"];

			if (!methods.includes(methodName)) {
				return null;
			}

			return await window.__githubLoadMore?.[methodName]?.(...methodArgs);
		}
	});

	return result?.result;
}

async function savePopupStatus(status) {
	if (!activeTabId) return;

	await chrome.storage.session.set({
		[getTabStorageKey(activeTabId)]: {
			...status,
			pageInstanceId: currentPageInstanceId,
			url: activeTabUrl,
			updatedAt: Date.now()
		}
	});
}

async function clearPopupStatus(tabId = activeTabId) {
	if (!tabId) return;

	await chrome.storage.session.remove(getTabStorageKey(tabId));
}

async function readPopupStatus(tabId) {
	const result = await chrome.storage.session.get(getTabStorageKey(tabId));
	return result[getTabStorageKey(tabId)];
}

function renderValidation(validation) {
	isValidPage = Boolean(validation?.ok);
	isRunning = false;

	if (!isValidPage) {
		setPill("Unsupported");
		setStatus(
			"Open a GitHub PR, issue, or discussion page to use this.",
			"error"
		);
		setButton({
			text: "Not available here",
			disabled: true
		});
		return;
	}

	setPill(validation.pageType || "Supported");
	setStatus("Ready to expand hidden threads on this page.", "default");
	setButton({
		text: "Expand hidden threads",
		disabled: false
	});
}

function renderSavedState(savedState) {
	if (!savedState) return false;

	if (savedState.pageType) {
		setPill(savedState.pageType);
	} else if (isValidPage) {
		setPill("Supported");
	}

	if (savedState.state === "running") {
		isRunning = true;
		if (savedState.message) {
			setStatus(savedState.message, "default");
			setButton({
				text: "Expanding...",
				disabled: true,
				loading: true
			});
		} else {
			setButton({
				text: buttonText.textContent,
				disabled: true,
				loading: false
			});
		}
		return true;
	}

	if (savedState.state === "done") {
		isRunning = false;
		setStatus(
			savedState.message || "You're caught up now.",
			"success"
		);
		setButton({
			text: "Check again",
			disabled: false
		});
		return true;
	}

	if (savedState.state === "paused") {
		isRunning = false;
		setStatus(
			savedState.message ||
				"Expanded 10 hidden threads. Continue to expand more?",
			"warning"
		);
		setButton({
			text: "Continue expanding",
			disabled: false
		});
		return true;
	}

	if (savedState.state === "empty") {
		isRunning = false;
		setStatus(
			savedState.message || "You're already caught up. No hidden threads found.",
			"warning"
		);
		setButton({
			text: "Check again",
			disabled: false
		});
		return true;
	}

	if (savedState.state === "error") {
		isRunning = false;
		setStatus(
			savedState.message || "Could not expand hidden threads. Try again.",
			"error"
		);
		setButton({
			text: "Try again",
			disabled: false
		});
		return true;
	}

	return false;
}

async function refreshRuntimeState() {
	if (!activeTabId || !currentPageInstanceId) return;

	const runtimeState = await callLoader(activeTabId, "getState");

	if (runtimeState?.pageInstanceId !== currentPageInstanceId) {
		stopStatePolling();
		return;
	}

	await savePopupStatus(runtimeState);
	renderSavedState(runtimeState);

	if (runtimeState.state !== "running") {
		stopStatePolling();
	}
}

function startStatePolling() {
	stopStatePolling();

	statePollTimer = window.setInterval(() => {
		refreshRuntimeState().catch((error) => {
			console.error("[GitHub Load More] Poll error:", error);
			stopStatePolling();
		});
	}, STATE_POLL_INTERVAL_MS);
}

async function initializePopup() {
	try {
		const tab = await getActiveTab();

		activeTabId = tab?.id;
		activeTabUrl = tab?.url || "";

		if (!activeTabId || !activeTabUrl.startsWith("https://github.com/")) {
			setPill("Unsupported");
			setStatus(
				"Open a GitHub PR, issue, or discussion page to use this.",
				"error"
			);
			setButton({
				text: "Not available here",
				disabled: true
			});
			return;
		}

		await injectLoader(activeTabId);

		const validation = await callLoader(activeTabId, "validatePage");

		if (!validation?.ok) {
			renderValidation(validation);
			return;
		}

		isValidPage = true;
		setPill(validation.pageType || "Supported");

		const currentRuntimeState = await callLoader(activeTabId, "getState");
		currentPageInstanceId = currentRuntimeState?.pageInstanceId || null;

		if (currentRuntimeState?.state === "running") {
			await savePopupStatus(currentRuntimeState);
			renderSavedState(currentRuntimeState);
			startStatePolling();
			return;
		}

		if (
			currentRuntimeState?.state &&
			currentRuntimeState.state !== "idle"
		) {
			await savePopupStatus(currentRuntimeState);
			renderSavedState(currentRuntimeState);
			return;
		}

		const savedState = await readPopupStatus(activeTabId);

		const isSavedStateFromCurrentPage =
			savedState?.pageInstanceId &&
			savedState.pageInstanceId === currentPageInstanceId &&
			savedState.url === activeTabUrl;

		if (savedState && isSavedStateFromCurrentPage) {
			renderSavedState(savedState);
			return;
		}

		await clearPopupStatus(activeTabId);
		renderValidation(validation);
	} catch (error) {
		console.error("[GitHub Load More] Init error:", error);

		setPill("Error");
		setStatus(
			"Could not check this page. Refresh GitHub, then try again.",
			"error"
		);
		setButton({
			text: "Try again",
			disabled: false
		});
	}
}

async function runLoader() {
	if (!activeTabId || isRunning || !isValidPage) {
		return;
	}

	isRunning = true;

	setButton({
		text: buttonText.textContent,
		disabled: true,
		loading: false
	});

	try {
		const result = await callLoader(activeTabId, "start", [
			{
				maxClicks: EXPANSION_BATCH_SIZE
			}
		]);

		if (!result?.ok) {
			const runtimeState = await callLoader(activeTabId, "getState");
			const errorState =
				runtimeState?.state === "error"
					? runtimeState
					: {
							state: "error",
							message:
								"Could not expand hidden threads. Refresh GitHub, then try again."
						};

			await savePopupStatus(errorState);
			renderSavedState(errorState);
			return;
		}

		await refreshRuntimeState();
		startStatePolling();
	} catch (error) {
		console.error("[GitHub Load More] Run error:", error);

		const errorState = {
			state: "error",
			message: "Could not expand hidden threads. Try again."
		};

		await savePopupStatus(errorState);
		renderSavedState(errorState);
	}
}

actionButton.addEventListener("click", runLoader);

initializePopup();
