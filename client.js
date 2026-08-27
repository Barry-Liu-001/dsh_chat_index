/**
 * dsh-chat-index — browser (client) bundle.
 *
 * Hand-written in the DSH client module factory format (classic script that
 * registers a CJS factory via window.__ModuleLoader__): the node half scans
 * enabled Loader entries for `dsh.client` packages and serves this file under
 * /plugins. The factory uses no require() at all — the whole feature is plain
 * DOM/CSS glued to stable, data-attribute seams of the conversation shell:
 *
 *   - [data-conversation-scroll]      the chat scrollport (one active per shell)
 *   - [data-chat-flow-kind="user"]    a user message flow row
 *   - [data-chat-flow-key]            stable per-message key
 *   - [data-time-hover-root]          the user bubble row inside a flow row
 *   - [data-composer-seat]            the sticky composer (rail bottom inset)
 *
 * It renders a single fixed dot-rail over the right edge of whichever
 * conversation scrollport is currently on screen (the shell can mount/replace
 * containers during boot and session transitions, so the active container is
 * re-picked on every sync rather than bound once). Each dot is one user
 * message; the dots form a compact, evenly-spaced column centered vertically
 * in the chat viewport (the blue dot marks the current reading position).
 * Hovering a dot shows an abbreviation tooltip; clicking smooth-scrolls to
 * the message and flashes its bubble.
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
		const USER_SEL = '[data-chat-flow-kind="user"]';
		const FLOW_KEY_ATTR = "data-chat-flow-key";
		const SYNC_INTERVAL_MS = 5000;
		const ABBREV_LIMIT = 100;
		const DOT_SIZE = 8; // match .dci_dot width/height
		const DOT_HALF = DOT_SIZE / 2;
		const DOT_SPACING = 14; // preferred center-to-center gap, px
		const AUTO_LOAD_OLDER = true; // auto-click "load older" so all history is indexed
		const OLDER_CLICK_PACE_MS = 500; // min interval between paging clicks
		const OLDER_MAX_CLICKS = 1000; // safety valve against a never-ending pager
		const OLDER_IDLE_STOP = 3; // consecutive syncs without a clickable button → consider fully loaded

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

		/**
		 * Extract the user's prose from a `[data-chat-flow-kind="user"]` row.
		 * The row also holds icon-only action buttons (copy/clock), images and
		 * an optional reference summary; clone and strip everything non-prose.
		 */
		function extractText(item) {
			const row = item.querySelector("[data-time-hover-root]") || item;
			const clone = row.cloneNode(true);
			clone.querySelectorAll("button, svg, img, input, textarea").forEach((el) => el.remove());
			return normalize(clone.textContent);
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
				const userCount = el.querySelectorAll(USER_SEL).length;
				const area = visibleArea(el);
				// weight: each rendered user message matters far more than area
				const score = userCount * 1e9 + area;
				if (score > bestScore) {
					bestScore = score;
					best = el;
				}
			}
			return best;
		}

		/**
		 * Find the "load older messages" paging button inside a scrollport.
		 * Structural heuristic: the first visible button inside the flow column
		 * that is NOT inside a chat flow row, has text content, and sits in the
		 * top portion of the scrollport. Returns null when history is fully loaded.
		 */
		function findOlderButton(scrollEl) {
			const column = scrollEl.querySelector("[data-chat-flow]") || scrollEl;
			const buttons = column.querySelectorAll("button");
			const scrollTop = scrollEl.scrollTop;
			const viewTop = scrollEl.getBoundingClientRect().top;
			let best = null;
			let bestY = Infinity;
			for (const btn of buttons) {
				if (btn.closest(USER_SEL)) continue; // message copy/clock/etc.
				if (btn.closest(".dci_rail")) continue; // our own dots (defensive)
				const text = (btn.textContent || "").trim();
				if (!text) continue; // icon-only buttons (back-to-bottom, etc.)
				const r = btn.getBoundingClientRect();
				if (r.width <= 0 || r.height <= 0) continue; // hidden
				// The pager is in the upper part of the scrollport (above messages).
				const yInScroll = r.top - viewTop + scrollTop;
				if (yInScroll < 0 || yInScroll > scrollEl.clientHeight * 0.5) continue;
				if (yInScroll < bestY) {
					bestY = yInScroll;
					best = btn;
				}
			}
			return best;
		}

		/**
		 * Collapse the transcript's paging: click "load older" whenever it is
		 * available and idle, so every message (including older history) is
		 * rendered and indexed. The shell anchors scroll on prepend, so this
		 * does not yank the reader's position. Paced by a min interval and a
		 * high safety cap; React disables the button while a page loads.
		 *
		 * Stops permanently once the button is absent for OLDER_IDLE_STOP
		 * consecutive syncs — no more "endless clicking" when history ends.
		 */
		function maybeAutoLoadOlder(scrollEl) {
			if (!AUTO_LOAD_OLDER) return;
			if (state.olderFullyLoaded) return;
			if (state.olderClicks >= OLDER_MAX_CLICKS) return;
			const btn = findOlderButton(scrollEl);
			if (!btn || btn.disabled) {
				state.olderIdleSyncs = (state.olderIdleSyncs || 0) + 1;
				if (state.olderIdleSyncs >= OLDER_IDLE_STOP) {
					state.olderFullyLoaded = true;
				}
				return;
			}
			state.olderIdleSyncs = 0;
			const now = Date.now();
			if (now - state.olderLastClickAt < OLDER_CLICK_PACE_MS) return;
			state.olderLastClickAt = now;
			state.olderClicks += 1;
			try {
				btn.click();
			} catch {
				// a detached/odd button — ignore; next sync retries
			}
		}

		// ----- plugin state (single rail, rebound active scroll) -------------
		const state = {
			rail: null,
			tip: null,
			scrollEl: null,
			dots: new Map(), // key -> { el, item, key, text, idx, y, contentY }
			raf: 0,
			ro: null,
			interval: 0,
			flashTimers: new Map(),
			olderLastClickAt: 0,
			olderClicks: 0,
			olderIdleSyncs: 0, // consecutive syncs without a clickable "load older"
			olderFullyLoaded: false, // set once history is fully expanded
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
			// Position to the left of the hovered dot (fixed, in viewport coords),
			// flipping to the right if there is no room; clamp to viewport edges.
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

		function jumpTo(entry) {
			hideTip();
			const scrollEl = state.scrollEl;
			if (!scrollEl) return;
			const item = entry.item;
			if (!item || !item.isConnected) return;

			// Re-measure at click time — cached contentY may be stale after
			// streaming output, layout shifts, or virtualized re-mounts.
			const srect = scrollEl.getBoundingClientRect();
			const r = item.getBoundingClientRect();
			const contentY = r.top - srect.top + scrollEl.scrollTop;
			const target = Math.max(0, contentY - scrollEl.clientHeight * 0.25);

			// Use instant scroll for precision; smooth scroll drifts when content
			// is still being rendered around the target.
			scrollEl.scrollTo({ top: target, behavior: "auto" });

			// Second pass: after the scroll settles, re-check and nudge if the
			// target moved (e.g. lazy-loaded images, expanding code blocks).
			requestAnimationFrame(() => {
				if (!item.isConnected) return;
				const srect2 = scrollEl.getBoundingClientRect();
				const r2 = item.getBoundingClientRect();
				const contentY2 = r2.top - srect2.top + scrollEl.scrollTop;
				const target2 = Math.max(0, contentY2 - scrollEl.clientHeight * 0.25);
				if (Math.abs(target2 - scrollEl.scrollTop) > 4) {
					scrollEl.scrollTo({ top: target2, behavior: "auto" });
				}
			});

			const bubble = bubbleOf(item);
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

		function clearDots() {
			for (const entry of state.dots.values()) entry.el.remove();
			state.dots.clear();
		}

		/**
		 * Recompute the active scrollport, rail geometry, dot set/positions and
		 * the active dot. Runs on rAF; cheap because user messages are few.
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
				state.olderLastClickAt = 0;
				state.olderClicks = 0;
				state.olderIdleSyncs = 0;
				state.olderFullyLoaded = false;
			}

			// Expand any paged-away older history so every user message is
			// rendered and indexable (runs even when the rail itself is hidden).
			maybeAutoLoadOlder(scrollEl);

			const srect = scrollEl.getBoundingClientRect();
			const items = Array.from(scrollEl.querySelectorAll(USER_SEL)).filter((el) => {
				const r = el.getBoundingClientRect();
				return r.width > 0 && r.height > 0;
			});
			if (items.length < 2) {
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
			// The class ships display:none as the pre-JS hidden state; the show
			// branch must set an explicit value (clearing the inline style would
			// fall back to the stylesheet's none and keep the rail invisible).
			rail.style.display = "block";
			rail.style.top = srect.top + 8 + "px";
			rail.style.left = srect.right - 26 + "px";
			rail.style.height = height + "px";

			// Evenly-spaced, vertically-centered dot cluster (NOT a proportional
			// minimap): equal small gaps, whole column centered in the rail. When
			// there are too many messages to fit at the preferred spacing, compress
			// the gap so the cluster still fits.
			const n = items.length;
			const spacing = Math.min(DOT_SPACING, (height - DOT_SIZE) / Math.max(1, n - 1));
			const blockH = (n - 1) * spacing;
			const startY = Math.max(DOT_HALF, (height - blockH) / 2);

			const anchor = scrollEl.scrollTop + scrollEl.clientHeight * 0.35;
			const seen = new Set();
			let activeKey = null;

			items.forEach((item, idx) => {
				const key = item.getAttribute(FLOW_KEY_ATTR) || "idx-" + idx;
				seen.add(key);
				let entry = state.dots.get(key);
				if (!entry) {
					const el = document.createElement("button");
					el.type = "button";
					el.className = "dci_dot";
					rail.appendChild(el);
					entry = { el, item, key, text: "", idx, y: 0, contentY: 0 };
					state.dots.set(key, entry);
				}
				entry.item = item;
				entry.idx = idx;
				const rawText = extractText(item);
				const text = rawText || "（图片/附件消息）";
				if (text !== entry.text) {
					entry.text = text;
					entry.el.setAttribute("aria-label", "跳转到第 " + (idx + 1) + " 条用户消息：" + abbreviate(text));
				}
				// contentY (message position in the scrollport) is kept only for
				// click-to-scroll; the dot itself sits in the even centered layout.
				const r = item.getBoundingClientRect();
				const contentY = r.top - srect.top + scrollEl.scrollTop;
				entry.contentY = contentY;
				const cy = startY + idx * spacing; // dot center within the rail
				entry.y = cy;
				entry.el.style.top = cy - DOT_HALF + "px";
				if (contentY <= anchor) activeKey = key;
			});

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
		const inject = [];

		function apply() {
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
				if (entry) jumpTo(entry);
			});

			schedule();

			return () => {
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
