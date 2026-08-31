/**
 * dsh-chat-index — browser (client) bundle.
 *
 * Hand-written in the DSH client module factory format (classic script that
 * registers a CJS factory via window.__ModuleLoader__). The node half serves
 * this file under /plugins; the browser factory uses no require() — it talks
 * to the host half through one documented seam: the lightweight question-index
 * endpoint `GET /chat-index.questions?session=<id>` (registered by
 * ./index.js), which returns every user question as `{ seq, time, id, text }`.
 *
 * Design change vs. the previous build:
 *   - The rail no longer needs the full conversation to be expanded. It reads
 *     the complete question list from the host (a few KB), so the client keeps
 *     the default 50-message window and does NOT auto-click "load older" — no
 *     history is forced into memory.
 *   - Each dot is one user question (all of them, loaded or not). Hover shows
 *     the question text (from the endpoint). Click scrolls to the message; a
 *     question outside the loaded window is reached by on-demand paging (only
 *     when you click it — bounded to that point, not the whole history).
 *
 * The factory injects `sessions` to learn the current session id; everything
 * else is plain DOM/CSS glued to stable, data-attribute seams of the shell:
 *
 *   - [data-conversation-scroll]      the chat scrollport (one active per shell)
 *   - [data-chat-flow-key]            stable per-message key = "N:input-message" + messageId
 *   - [data-time-hover-root]          the user bubble row inside a flow row
 *   - [data-composer-seat]            the sticky composer (rail bottom inset)
 *
 * It renders a single fixed dot-rail over the right edge of whichever
 * conversation scrollport is currently on screen (re-picked on every sync).
 * Dots form a compact, evenly-spaced column centered vertically in the chat
 * viewport; the brand-colored dot marks the current reading position.
 */
window.__ModuleLoader__.load({
	id: "dsh-chat-index",
	factory: () => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const PLUGIN = "dsh-chat-index";
		const CSS_TAG_ID = "dsh-chat-index/rail.css";
		const SCROLL_SEL = "[data-conversation-scroll]";
		const FLOW_KEY_ATTR = "data-chat-flow-key";
		const SYNC_INTERVAL_MS = 5000;
		const ABBREV_LIMIT = 100;
		const DOT_SIZE = 8; // match .dci_dot width/height
		const DOT_HALF = DOT_SIZE / 2;
		const DOT_SPACING = 14; // preferred center-to-center gap, px
		const QUESTIONS_PATH = "/chat-index.questions";
		const QUESTION_TTL_MS = 8000; // don't hammer the endpoint faster than this
		const OLDER_CLICK_PACE_MS = 400; // min interval between on-demand paging clicks
		const OLDER_MAX_CLICKS = 2000; // safety valve for on-demand paging
		// Rendered message key prefix for user/steering rows (conversationContextKey).
		// Built dynamically so a kind-length change never breaks matching.
		const USER_KEY_PREFIX = (() => {
			const kind = "input-message";
			return String(kind.length) + ":" + kind;
		})();

		// ----- CSS (theme tokens mirror the built-in DSH chat shell) ----------
		const CSS = `
.dci_rail{position:fixed;z-index:6;width:12px;pointer-events:none;display:none}
.dci_dot{position:absolute;left:50%;top:0;width:8px;height:8px;margin-left:-4px;border:0;padding:0;border-radius:50%;background:var(--dsw-alias-label-tertiary);opacity:.45;cursor:pointer;pointer-events:auto;display:block;transform:translateX(-50%) scale(1);transition:opacity .15s ease,background .15s ease,transform .15s ease}
.dci_dot:hover{opacity:1;background:var(--dsw-alias-state-business-primary);transform:translateX(-50%) scale(1.5)}
.dci_dot.is-active{opacity:1;background:var(--dsw-alias-state-business-primary)}
.dci_dot.is-active:hover{transform:translateX(-50%) scale(1.5)}
.dci_dot:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dci_tip{position:fixed;top:0;left:0;width:max-content;max-width:320px;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);box-shadow:0 6px 20px rgba(0,0,0,.22);color:var(--dsw-alias-label-primary);font-size:12px;line-height:16px;white-space:normal;word-break:break-word;pointer-events:none;opacity:0;visibility:hidden;transition:opacity .12s ease,visibility .12s;z-index:2147483000}
.dci_tip.dci_show{opacity:1;visibility:visible}
.dci_tipNum{font-family:var(--dsh-font-mono,var(--dsw-font-mono,monospace));font-size:11px;color:var(--dsw-alias-label-tertiary);margin-right:6px;font-variant-numeric:tabular-nums}
@keyframes dci_flash{0%{box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 70%,transparent)}100%{box-shadow:0 0 0 12px transparent}}
.dci_flash{border-radius:14px;animation:dci_flash 1.5s ease-out}
`;

		function injectCss() {
			if (typeof document === "undefined") return;
			if (document.querySelector('style[data-plugin-css="' + CSS_TAG_ID + '"]') !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = PLUGIN;
			tag.dataset.pluginCss = CSS_TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		// ----- text helpers ---------------------------------------------------
		function normalize(text) {
			return (text || "").replace(/\s+/g, " ").trim();
		}

		function abbreviate(text) {
			const flat = normalize(text);
			return flat.length > ABBREV_LIMIT ? flat.slice(0, ABBREV_LIMIT) + "…" : flat;
		}

		/** Extract a messageId from a rendered `data-chat-flow-key` value. */
		function messageIdFromKey(key) {
			if (typeof key !== "string") return null;
			if (!key.startsWith(USER_KEY_PREFIX)) return null;
			const id = key.slice(USER_KEY_PREFIX.length);
			return id.length > 0 ? id : null;
		}

		/** The rendered row for one message id (user or steering rows). */
		function rowForId(id) {
			const wanted = USER_KEY_PREFIX + id;
			const rows = document.querySelectorAll("[" + FLOW_KEY_ATTR + "]");
			for (const row of rows) {
				if (row.getAttribute(FLOW_KEY_ATTR) === wanted) return row;
			}
			return null;
		}

		/** The tight bubble element (for the click flash); falls back to the row. */
		function bubbleOf(item) {
			return item.querySelector('[class*="bubble"]') || item.querySelector("[data-time-hover-root]") || item;
		}

		function visibleArea(el) {
			const r = el.getBoundingClientRect();
			if (r.width <= 0 || r.height <= 0) return 0;
			return r.width * r.height;
		}

		/**
		 * Pick the conversation scrollport currently on screen. Prefers a
		 * visible container that already holds rendered user messages; falls
		 * back to the largest visible container so the rail can appear the
		 * moment a session with history mounts.
		 */
		function pickScrollEl() {
			const candidates = Array.from(document.querySelectorAll(SCROLL_SEL)).filter(
				(el) => document.contains(el) && visibleArea(el) > 0,
			);
			if (candidates.length === 0) return null;
			let best = null;
			let bestScore = -1;
			for (const el of candidates) {
				const userCount = el.querySelectorAll('[data-chat-flow-key]').length;
				const area = visibleArea(el);
				const score = userCount * 1e9 + area;
				if (score > bestScore) {
					bestScore = score;
					best = el;
				}
			}
			return best;
		}

		/**
		 * Find the "load older messages" paging button inside a scrollport
		 * (DSH's own pager, left visible). Structural heuristic: the first
		 * visible button inside the flow column that is NOT inside a chat flow
		 * row, has text, and sits in the top portion of the scrollport.
		 */
		function findOlderButton(scrollEl) {
			const column = scrollEl.querySelector("[data-chat-flow]") || scrollEl;
			const buttons = column.querySelectorAll("button");
			const scrollTop = scrollEl.scrollTop;
			const viewTop = scrollEl.getBoundingClientRect().top;
			let best = null;
			let bestY = Infinity;
			for (const btn of buttons) {
				if (btn.closest(".dci_rail")) continue; // our own dots
				if (btn.closest('[data-chat-flow-key]')) continue; // message copy/clock etc.
				const text = (btn.textContent || "").trim();
				if (!text) continue; // icon-only buttons (back-to-bottom, etc.)
				const r = btn.getBoundingClientRect();
				if (r.width <= 0 || r.height <= 0) continue; // hidden
				const yInScroll = r.top - viewTop + scrollTop;
				if (yInScroll < 0 || yInScroll > scrollEl.clientHeight * 0.5) continue;
				if (yInScroll < bestY) {
					bestY = yInScroll;
					best = btn;
				}
			}
			return best;
		}

		// ----- host question index ------------------------------------------
		/**
		 * Load the complete user-question list from the host endpoint. Cached
		 * per session for QUESTION_TTL_MS; a manual refresh is forced on
		 * session change. Returns the item array (or null on failure).
		 */
		async function fetchQuestions(sessionId) {
			try {
				const url = QUESTIONS_PATH + "?session=" + encodeURIComponent(sessionId);
				const res = await fetch(url, { headers: { accept: "application/json" } });
				if (!res.ok) return null;
				const body = await res.json();
				return Array.isArray(body.items) ? body.items : null;
			} catch {
				return null;
			}
		}

		/**
		 * Rebuild the question index for the given session. Called when the
		 * current session changes, or when a rendered message is not yet in the
		 * index (the log grew since the last fetch). Throttled by TTL.
		 */
		function refreshQuestions(sessionId, force) {
			if (!sessionId) return;
			const now = Date.now();
			if (!force && state.questionAt !== 0 && now - state.questionAt < QUESTION_TTL_MS) return;
			if (state.fetchingQuestions) return;
			state.fetchingQuestions = true;
			state.questionAt = now;
			fetchQuestions(sessionId).then((items) => {
				state.fetchingQuestions = false;
				if (items === null) return;
				state.sessionId = sessionId;
				state.questions = items;
				state.idxById = new Map();
				for (let i = 0; i < items.length; i += 1) {
					if (items[i] && items[i].id != null) state.idxById.set(String(items[i].id), i);
				}
				schedule();
			});
		}

		/** True when any rendered message id is missing from the index. */
		function renderedMessagesOutdated(scrollEl) {
			const rows = scrollEl.querySelectorAll("[" + FLOW_KEY_ATTR + "]");
			for (const row of rows) {
				const id = messageIdFromKey(row.getAttribute(FLOW_KEY_ATTR));
				if (id !== null && !state.idxById.has(id)) return true;
			}
			return false;
		}

		/**
		 * On-demand paging: click "load older" (paced) until the message with
		 * the given id is rendered, then resolve. Used only when a user clicks
		 * a dot for a message outside the loaded window — the memory cost is
		 * bounded to the point the user navigated to.
		 * @returns true when the target was reached.
		 */
		async function loadUntilRendered(id, signal) {
			let clicks = 0;
			while (!signal.aborted && clicks < OLDER_MAX_CLICKS) {
				const row = rowForId(id);
				if (row && row.isConnected && row.getBoundingClientRect().width > 0) return true;
				const btn = findOlderButton(state.scrollEl);
				if (!btn || btn.disabled) {
					// No pager (history fully loaded) — check once more.
					if (!btn) return Boolean(rowForId(id) && rowForId(id).isConnected);
					await wait(OLDER_CLICK_PACE_MS);
					continue;
				}
				try {
					btn.click();
				} catch {
					// detached / odd — next iteration retries
				}
				clicks += 1;
				await wait(OLDER_CLICK_PACE_MS);
			}
			return Boolean(rowForId(id) && rowForId(id).isConnected);
		}

		function wait(ms) {
			return new Promise((resolve) => setTimeout(resolve, ms));
		}

		// ----- plugin state (single rail, rebound active scroll) -------------
		const state = {
			rail: null,
			tip: null,
			scrollEl: null,
			sessionId: null,
			questions: [], // [{ seq, time, id, text }] — all user questions, ascending seq
			idxById: new Map(), // messageId -> index into questions
			questionAt: 0,
			fetchingQuestions: false,
			dots: new Map(), // messageId -> { el, id, text, idx, y, contentY }
			raf: 0,
			ro: null,
			interval: 0,
			flashTimers: new Map(),
		};

		function schedule() {
			if (state.raf) return;
			state.raf = requestAnimationFrame(() => {
				state.raf = 0;
				sync();
			});
		}

		function entryFromTarget(target) {
			const el = target?.closest?.(".dci_dot");
			if (!el) return null;
			for (const entry of state.dots.values()) if (entry.el === el) return entry;
			return null;
		}

		function showTip(entry) {
			if (!entry.text) return;
			const tip = state.tip;
			tip.textContent = "";
			const num = document.createElement("span");
			num.className = "dci_tipNum";
			num.textContent = "#" + (entry.idx + 1);
			tip.appendChild(num);
			tip.appendChild(document.createTextNode(abbreviate(entry.text)));
			tip.classList.add("dci_show");
			const dot = entry.el.getBoundingClientRect();
			const tipH = tip.offsetHeight || 32;
			const tipW = tip.offsetWidth || 200;
			const vw = document.documentElement.clientWidth;
			const vh = document.documentElement.clientHeight;
			let x = dot.left - tipW - 12;
			if (x < 8) x = dot.right + 12;
			let y = dot.top + dot.height / 2 - tipH / 2;
			y = Math.min(Math.max(y, 8), Math.max(8, vh - tipH - 8));
			tip.style.left = Math.max(8, Math.min(x, vw - tipW - 8)) + "px";
			tip.style.top = y + "px";
		}

		function hideTip() {
			state.tip.classList.remove("dci_show");
		}

		function scrollToRow(row) {
			const scrollEl = state.scrollEl;
			if (!scrollEl || !row || !row.isConnected) return;
			const srect = scrollEl.getBoundingClientRect();
			const r = row.getBoundingClientRect();
			const contentY = r.top - srect.top + scrollEl.scrollTop;
			const target = Math.max(0, contentY - scrollEl.clientHeight * 0.25);
			scrollEl.scrollTo({ top: target, behavior: "auto" });
			requestAnimationFrame(() => {
				if (!row.isConnected) return;
				const srect2 = scrollEl.getBoundingClientRect();
				const r2 = row.getBoundingClientRect();
				const contentY2 = r2.top - srect2.top + scrollEl.scrollTop;
				const target2 = Math.max(0, contentY2 - scrollEl.clientHeight * 0.25);
				if (Math.abs(target2 - scrollEl.scrollTop) > 4) {
					scrollEl.scrollTo({ top: target2, behavior: "auto" });
				}
			});
			const bubble = bubbleOf(row);
			bubble.classList.remove("dci_flash");
			void bubble.offsetWidth; // restart the animation
			bubble.classList.add("dci_flash");
			const prev = state.flashTimers.get(bubble);
			if (prev) clearTimeout(prev);
			state.flashTimers.set(
				bubble,
				setTimeout(() => {
					bubble.classList.remove("dci_flash");
					state.flashTimers.delete(bubble);
				}, 1600),
			);
		}

		async function jumpTo(entry) {
			hideTip();
			const id = entry.id;
			if (!id) return;
			let row = rowForId(id);
			if (row && row.isConnected && row.getBoundingClientRect().width > 0) {
				scrollToRow(row);
				return;
			}
			// Outside the loaded window: page in on demand (bounded to this point).
			// Abort any earlier in-flight jump so concurrent clicks don't fight.
			if (state.currentJumpAbort) state.currentJumpAbort.aborted = true;
			const aborted = { aborted: false };
			state.currentJumpAbort = aborted;
			const reached = await loadUntilRendered(id, aborted);
			if (state.currentJumpAbort === aborted) state.currentJumpAbort = null;
			if (reached) {
				const final = rowForId(id);
				if (final && final.isConnected) scrollToRow(final);
			}
		}

		function clearDots() {
			for (const entry of state.dots.values()) entry.el.remove();
			state.dots.clear();
		}

		/**
		 * Recompute the active scrollport, rail geometry, dot set/positions and
		 * the active dot. The dot set comes from the host question index (all
		 * questions, loaded or not); the active dot is derived from which
		 * rendered message row is currently at the reading anchor.
		 */
		function sync() {
			const rail = state.rail;
			if (!rail || !document.contains(rail)) return;

			const scrollEl = pickScrollEl();
			if (!scrollEl) {
				rail.style.display = "none";
				state.ro?.disconnect();
				state.ro = null;
				state.scrollEl = null;
				clearDots();
				return;
			}

			// Rebind observers if the active container changed.
			if (scrollEl !== state.scrollEl) {
				state.ro?.disconnect();
				state.ro = new ResizeObserver(schedule);
				state.ro.observe(scrollEl);
				state.scrollEl = scrollEl;
				clearDots();
			}

			// Learn the current session id and keep the question index fresh.
			const sessions = ctx && ctx.sessions;
			const current = sessions && sessions.list && sessions.list.getSnapshot
				? sessions.list.getSnapshot().current
				: undefined;
			if (current && current !== state.sessionId) {
				state.sessionId = current;
				state.questions = [];
				state.idxById.clear();
				state.questionAt = 0;
				refreshQuestions(current, true);
			} else if (current && renderedMessagesOutdated(scrollEl)) {
				// The log grew since the last fetch — pull an update (TTL throttled).
				refreshQuestions(current, false);
			}

			const srect = scrollEl.getBoundingClientRect();
			const n = state.questions.length;
			if (n < 2) {
				rail.style.display = "none";
				return;
			}

			// Rail hugs the scrollport's right edge, stopping above the sticky composer.
			let bottom = srect.bottom;
			const seat = scrollEl.querySelector("[data-composer-seat]");
			if (seat) {
				const r = seat.getBoundingClientRect();
				if (r.top > srect.top && r.top < srect.bottom + 60) bottom = Math.min(bottom, r.top);
			}
			const height = Math.max(0, bottom - srect.top - 16);
			if (height < 40) {
				rail.style.display = "none";
				return;
			}

			rail.style.visibility = "visible";
			rail.style.display = "block";
			rail.style.top = srect.top + 8 + "px";
			rail.style.left = srect.right - 26 + "px";
			rail.style.height = height + "px";

			// Evenly-spaced, vertically-centered dot cluster. When there are too
			// many questions to fit at the preferred spacing, compress the gap.
			const spacing = Math.min(DOT_SPACING, (height - DOT_SIZE) / Math.max(1, n - 1));
			const blockH = (n - 1) * spacing;
			const startY = Math.max(DOT_HALF, (height - blockH) / 2);

			const anchor = scrollEl.scrollTop + scrollEl.clientHeight * 0.35;
			const seen = new Set();

			// Ensure one dot per question (all of them — cheap, from the index).
			state.questions.forEach((q, idx) => {
				if (!q || q.id == null) return;
				const key = String(q.id);
				seen.add(key);
				let entry = state.dots.get(key);
				if (!entry) {
					const el = document.createElement("button");
					el.type = "button";
					el.className = "dci_dot";
					rail.appendChild(el);
					entry = { el, id: key, text: "", idx, y: 0, contentY: 0 };
					state.dots.set(key, entry);
				}
				entry.idx = idx;
				const text = q.text || "（图片/附件消息）";
				if (text !== entry.text) {
					entry.text = text;
					entry.el.setAttribute(
						"aria-label",
						"跳转到第 " + (idx + 1) + " 条用户消息：" + abbreviate(text),
					);
				}
				const cy = startY + idx * spacing;
				entry.y = cy;
				entry.el.style.top = cy - DOT_HALF + "px";
				entry.el.classList.remove("is-active");
			});

			// Active dot: the most recent rendered message row at/above the anchor.
			// Rows are the loaded tail; older (unloaded) dots simply stay inactive.
			let activeKey = null;
			const rows = scrollEl.querySelectorAll("[" + FLOW_KEY_ATTR + "]");
			for (const row of rows) {
				const id = messageIdFromKey(row.getAttribute(FLOW_KEY_ATTR));
				if (id === null) continue;
				const r = row.getBoundingClientRect();
				if (r.width <= 0 || r.height <= 0) continue;
				const contentY = r.top - srect.top + scrollEl.scrollTop;
				if (contentY <= anchor) {
					const dotKey = String(id);
					if (state.dots.has(dotKey)) activeKey = dotKey;
				}
			}

			for (const [key, entry] of state.dots) {
				if (!seen.has(key)) {
					entry.el.remove();
					state.dots.delete(key);
				} else {
					entry.el.classList.toggle("is-active", key === activeKey);
				}
			}
		}

		// ----- plugin body ----------------------------------------------------
		const inject = ["sessions"];
		let ctx = null;

		function apply(c) {
			ctx = c;
			injectCss();

			// Factories can materialize during <head> parse, before <body> exists;
			// defer the body-touching bootstrap until the document is ready.
			if (!document.body) {
				let disposed = false;
				const onReady = () => {
					if (disposed || document.body) start();
				};
				document.addEventListener("DOMContentLoaded", onReady, { once: true });
				const readyCheck = setInterval(() => {
					if (document.body) { clearInterval(readyCheck); onReady(); }
				}, 50);
				return () => { disposed = true; clearInterval(readyCheck); };
			}
			return start();
		}

		function start() {
			const rail = document.createElement("div");
			rail.className = "dci_rail";
			rail.dataset.plugin = PLUGIN;
			document.body.appendChild(rail);
			const tip = document.createElement("div");
			tip.className = "dci_tip";
			tip.setAttribute("role", "tooltip");
			document.body.appendChild(tip);
			state.rail = rail;
			state.tip = tip;

			// Content / structure changes (messages stream, history pages, view switches).
			const observer = new MutationObserver(schedule);
			observer.observe(document.documentElement, { childList: true, subtree: true });

			// Scrolling inside any scrollport (capture catches non-bubbling scroll events).
			window.addEventListener("scroll", schedule, true);
			window.addEventListener("resize", schedule);

			state.interval = setInterval(schedule, SYNC_INTERVAL_MS);

			rail.addEventListener("mouseover", (e) => {
				const entry = entryFromTarget(e.target);
				if (entry) showTip(entry);
			});
			rail.addEventListener("mouseout", (e) => {
				if (entryFromTarget(e.target)) hideTip();
			});
			rail.addEventListener("click", (e) => {
				const entry = entryFromTarget(e.target);
				if (entry) void jumpTo(entry);
			});

			schedule();

			return () => {
				if (state.currentJumpAbort) state.currentJumpAbort.aborted = true;
				observer.disconnect();
				state.ro?.disconnect();
				window.removeEventListener("scroll", schedule, true);
				window.removeEventListener("resize", schedule);
				clearInterval(state.interval);
				if (state.raf) cancelAnimationFrame(state.raf);
				for (const timer of state.flashTimers.values()) clearTimeout(timer);
				state.flashTimers.clear();
				clearDots();
				rail.remove();
				state.tip?.remove();
				document
					.querySelectorAll('style[data-plugin-css="' + CSS_TAG_ID + '"]')
					.forEach((tag) => tag.remove());
			};
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
