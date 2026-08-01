(() => {
	const STATE_KEY = "__githubLoadMore";

	if (window[STATE_KEY]) {
		return;
	}

	const LOAD_MORE_TEXT_PATTERN =
		/^load\s+more(?:\s+(?:(?:hidden\s+)?comments?|replies|threads?|discussion|review\s+comments?|timeline(?:\s+items?)?))?[\s.!…]*$/i;
	const EXCLUDED_BUTTON_CONTEXT_SELECTOR = [
		"details-menu",
		"modal-dialog",
		"details-dialog",
		"[role='dialog']",
		".Overlay",
		".SelectMenu",
		".dropdown-menu"
	].join(",");
	const DRAFT_EDITOR_SELECTOR = [
		"textarea:not([disabled]):not([readonly])",
		"[contenteditable='true']"
	].join(",");
	const DRAFT_CONTEXT_SELECTOR = [
		"form",
		".js-previewable-comment-form",
		".js-inline-comment-form",
		".js-comment",
		".timeline-comment",
		".review-comment",
		"[data-testid*='comment']",
		"[data-testid*='review']"
	].join(",");

	const SUPPORTED_GITHUB_PAGE_PATTERNS = [
		{
			name: "PR",
			pattern: /^\/[^/]+\/[^/]+\/pull\/\d+(\/.*)?$/
		},
		{
			name: "Issue",
			pattern: /^\/[^/]+\/[^/]+\/issues\/\d+(\/.*)?$/
		},
		{
			name: "Discussion",
			pattern: /^\/[^/]+\/[^/]+\/discussions(\/.*)?$/
		},
		{
			name: "Org Discussion",
			pattern: /^\/orgs\/[^/]+\/discussions(\/.*)?$/
		},
	];

	const pageInstanceId =
		window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
	const hardTimeoutMs = 300_000; // force stop after 5 minutes
	const maxLoopIterations = 30; // force stop if loop somehow keeps running

	let runningPromise = null;

	const runtimeState = {
		state: "idle",
		message: "",
		pageType: null,
		pageInstanceId,
		url: window.location.href,
		startedAt: null,
		finishedAt: null
	};

	function updateState(nextState) {
		Object.assign(runtimeState, nextState);
	}

	function resetStateForCurrentUrl() {
		if (runtimeState.url === window.location.href) {
			return;
		}

		runningPromise = null;

		updateState({
			state: "idle",
			message: "",
			pageType: null,
			url: window.location.href,
			startedAt: null,
			finishedAt: null
		});
	}

	function hasStaleRunningState() {
		return (
			runtimeState.state === "running" &&
			runtimeState.startedAt &&
			Date.now() - runtimeState.startedAt > hardTimeoutMs
		);
	}

	function recoverStaleRunningState() {
		if (!hasStaleRunningState()) {
			return;
		}

		runningPromise = null;

		updateState({
			state: "error",
			message: "GitHub took too long to respond. Try again.",
			finishedAt: Date.now()
		});
	}

	function validatePage() {
		resetStateForCurrentUrl();

		const { hostname, pathname } = window.location;

		if (hostname !== "github.com") {
			return {
				ok: false,
				reason: "NOT_GITHUB"
			};
		}

		const matchedPage = SUPPORTED_GITHUB_PAGE_PATTERNS.find(({ pattern }) =>
			pattern.test(pathname)
		);

		if (!matchedPage) {
			return {
				ok: false,
				reason: "UNSUPPORTED_GITHUB_PAGE"
			};
		}

		return {
			ok: true,
			pageType: matchedPage.name
		};
	}

	function getState() {
		resetStateForCurrentUrl();
		recoverStaleRunningState();

		return { ...runtimeState };
	}

	function wait(ms) {
		return new Promise((resolve) => window.setTimeout(resolve, ms));
	}

	function waitForDomChange({ timeoutMs = 5000, settleMs = 700 } = {}) {
		return new Promise((resolve) => {
			let settledTimer = null;

			function finish(didChange) {
				window.clearTimeout(settledTimer);
				window.clearTimeout(timeoutTimer);
				observer.disconnect();
				resolve(didChange);
			}

			const observer = new MutationObserver(() => {
				window.clearTimeout(settledTimer);

				settledTimer = window.setTimeout(() => {
					finish(true);
				}, settleMs);
			});

			const timeoutTimer = window.setTimeout(() => {
				finish(false);
			}, timeoutMs);

			observer.observe(document.body, {
				childList: true,
				subtree: true
			});
		});
	}

	async function waitForGitHubToSettle() {
		/**
		 * GitHub often does:
		 * button click -> button disappears -> spinner/skeleton shows -> comments render -> new buttons appear
		 *
		 * So a plain timeout is unreliable. We wait for DOM mutation first,
		 * then add a tiny buffer before checking buttons again.
		 */
		await waitForDomChange({
			timeoutMs: 6000,
			settleMs: 800
		});

		await wait(400);
	}

	function getVisibleButtons() {
		return Array.from(document.querySelectorAll("button")).filter(
			(button) =>
				!button.disabled &&
				button.getAttribute("aria-disabled") !== "true" &&
				button.getAttribute("data-loading") !== "true" &&
				isVisibleElement(button)
		);
	}

	function getButtonText(button) {
		return button.textContent?.replace(/\s+/g, " ").trim() || "";
	}

	function isLoadMoreButton(button) {
		const text = getButtonText(button);

		return (
			LOAD_MORE_TEXT_PATTERN.test(text) &&
			!button.closest(EXCLUDED_BUTTON_CONTEXT_SELECTOR)
		);
	}

	function findLoadMoreButtons() {
		return getVisibleButtons().filter(isLoadMoreButton);
	}

	function formatSectionCount(count) {
		return `${count} hidden ${count === 1 ? "thread" : "threads"}`;
	}

	function isVisibleElement(element) {
		const style = window.getComputedStyle(element);

		return (
			element.offsetParent !== null &&
			style.display !== "none" &&
			style.visibility !== "hidden"
		);
	}

	function getEditorText(editor) {
		if ("value" in editor) {
			return editor.value.trim();
		}

		return editor.textContent?.trim() || "";
	}

	function hasPotentialUnsavedDraft() {
		return Array.from(document.querySelectorAll(DRAFT_EDITOR_SELECTOR)).some(
			(editor) =>
				isVisibleElement(editor) &&
				Boolean(editor.closest(DRAFT_CONTEXT_SELECTOR)) &&
				getEditorText(editor).length > 0
		);
	}

	function isElementStillClickable(button) {
		if (!button || !button.isConnected || button.disabled) {
			return false;
		}

		return (
			button.getAttribute("aria-disabled") !== "true" &&
			button.getAttribute("data-loading") !== "true" &&
			isVisibleElement(button)
		);
	}

	async function clickVisibleLoadMoreButtons({ maxClicks, totalClicks }) {
		const buttons = findLoadMoreButtons();

		if (buttons.length === 0) {
			return {
				clicked: 0,
				totalClicks
			};
		}

		let clicked = 0;

		/**
		 * Important:
		 * We use a snapshot of current buttons, but still verify every button
		 * before clicking because GitHub may re-render the page after each click.
		 */
		for (const button of buttons) {
			if (totalClicks >= maxClicks) {
				break;
			}

			if (!isElementStillClickable(button)) {
				continue;
			}

			button.click();

			clicked += 1;
			totalClicks += 1;

			updateState({
				state: "running",
				message: `Expanded ${formatSectionCount(totalClicks)}. Waiting for new comments to appear.`
			});

			/**
			 * Wait after each click because clicking one Load more button can
			 * re-render nearby timeline sections and invalidate the next button.
			 */
			await waitForGitHubToSettle();
		}

		return {
			clicked,
			totalClicks
		};
	}

	async function expandConversation({ maxClicks = 10, startedAt } = {}) {
		function hasExceededSafetyLimits(loopIterations) {
			const hasTimedOut = Date.now() - startedAt > hardTimeoutMs;
			const hasLoopedTooMuch = loopIterations > maxLoopIterations;

			return hasTimedOut || hasLoopedTooMuch;
		}

		let totalClicks = 0;
		let idleChecks = 0;

		/**
		 * This is the main fix.
		 *
		 * We do not stop the first time no buttons are found.
		 * We wait for GitHub to finish rendering, then check again.
		 */
		const maxIdleChecks = 3;

		let loopIterations = 0;

		while (totalClicks < maxClicks) {
			loopIterations += 1;

			if (hasExceededSafetyLimits(loopIterations)) {
				updateState({
					state: "error",
					message: "Could not finish expanding threads. Try again.",
					finishedAt: Date.now()
				});

				return;
			}

			const result = await clickVisibleLoadMoreButtons({
				maxClicks,
				totalClicks
			});

			totalClicks = result.totalClicks;

			if (result.clicked > 0) {
				idleChecks = 0;
				continue;
			}

			idleChecks += 1;

			if (totalClicks === 0) {
				break;
			}

			if (idleChecks >= maxIdleChecks) {
				break;
			}

			if (totalClicks > 0) {
				updateState({
					state: "running",
					message: "Checking for more hidden threads."
				});
			}

			await waitForGitHubToSettle();
		}

		if (totalClicks === 0) {
			updateState({
				state: "empty",
				message: "You're already caught up. No hidden threads found.",
				finishedAt: Date.now()
			});

			return;
		}

		if (totalClicks >= maxClicks) {
			const hasMoreThreads = findLoadMoreButtons().length > 0;

			updateState({
				state: hasMoreThreads ? "paused" : "done",
				message: hasMoreThreads
					? `Expanded ${formatSectionCount(totalClicks)}. Continue to expand more?`
					: `Expanded ${formatSectionCount(totalClicks)}. You're caught up now.`,
				finishedAt: Date.now()
			});

			return;
		}

		updateState({
			state: "done",
			message: `Expanded ${formatSectionCount(totalClicks)}. You're caught up now.`,
			finishedAt: Date.now()
		});
	}

	function start({ maxClicks = 10 } = {}) {
		const validation = validatePage();
		const startedAt = Date.now();

		if (!validation.ok) {
			updateState({
				state: "error",
				message: "This GitHub page is not supported.",
				finishedAt: Date.now()
			});

			return {
				ok: false,
				reason: validation.reason
			};
		}

		recoverStaleRunningState();

		if (hasPotentialUnsavedDraft()) {
			updateState({
				state: "error",
				message:
					"Save or discard your draft comment before expanding hidden threads.",
				finishedAt: Date.now()
			});

			return {
				ok: false,
				reason: "UNSAVED_DRAFT"
			};
		}

		if (runtimeState.state === "running") {
			return {
				ok: true,
				reason: "ALREADY_RUNNING"
			};
		}

		updateState({
			state: "running",
			message: "",
			pageType: validation.pageType,
			url: window.location.href,
			startedAt: Date.now(),
			finishedAt: null
		});

		runningPromise = expandConversation({
			maxClicks,
			startedAt
		})
			.catch((error) => {
				console.error("[GitHub Load More] Expansion error:", error);

				updateState({
					state: "error",
					message: "Could not finish expanding threads. Try again.",
					finishedAt: Date.now()
				});
			})
			.finally(() => {
				runningPromise = null;
			});

		return {
			ok: true,
			state: "running"
		};
	}

	window[STATE_KEY] = {
		validatePage,
		getState,
		start
	};
})();
