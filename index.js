/**
 * dsh-chat-index — host (Node) entry.
 *
 * Exposes a lightweight "all user questions" endpoint to the browser half, so
 * the dot-rail can index every user question WITHOUT expanding the 50-message
 * history window into the client (expanding costs memory; the endpoint keeps
 * the client window small while the rail still knows every question).
 *
 * The browser half fetches
 *   GET /chat-index.questions?session=<sessionId>
 * and receives `{ items, total }` where each item is
 *   { seq, time, id, text }
 * — one entry per user-typed message (source.kind === 'user'), in ascending
 * seq order. `id` is the message id (matches the DOM `data-chat-flow-key`
 * suffix) so the client can map a dot to a rendered bubble; `text` is the
 * message prose for tooltips.
 *
 * The route is registered as an exact route on `ctx.webServer` (a node:http
 * handler). This is the one endpoint hook available across DSH versions —
 * `ctx.connection.fetch.register` only exists in newer releases, while
 * `webServer.register` is the underlying registry every version exposes.
 *
 * Reads go through `ctx.sessionQuery.readSession` (a documented seam; works in
 * the web profile even though content search is disabled). The result is
 * cached per session for a short TTL because the log only grows.
 *
 * @module dsh-chat-index
 */

export const name = "dsh-chat-index";
export const inject = ["webServer", "sessionQuery"];

/** Stable browser route for the question index (exact path under the web root). */
export const QUESTIONS_PATH = "/chat-index.questions";
const CACHE_TTL_MS = 10_000;
const cache = new Map(); // sessionId -> { at, items }

/** Join the text blocks of a user message into one normalized string. */
function contentText(blocks) {
	if (!Array.isArray(blocks)) return "";
	const parts = [];
	for (const block of blocks) {
		if (block && block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join(" ").replace(/\s+/g, " ").trim();
}

function writeJson(res, body, status = 200) {
	const text = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(text);
}

/** Handle GET /chat-index.questions?session=<id> → { items, total }. */
async function handleQuestions(ctx, req, res) {
	const url = new URL(req.url, "http://localhost");
	const sessionId = url.searchParams.get("session");
	if (!sessionId) return writeJson(res, { error: "missing session" }, 400);

	const cached = cache.get(sessionId);
	if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) {
		return writeJson(res, { items: cached.items, total: cached.items.length });
	}

	const sessionQuery = Reflect.get(ctx, "sessionQuery");
	if (!sessionQuery || typeof sessionQuery.readSession !== "function") {
		return writeJson(res, { error: "sessionQuery unavailable" }, 500);
	}

	const items = [];
	try {
		const { events } = await sessionQuery.readSession(sessionId);
		for (const event of events) {
			if (event.type !== "user/message") continue;
			const data = event.data;
			if (!data || !data.source || data.source.kind !== "user") continue;
			items.push({
				seq: event.seq,
				time: event.time,
				id: data.id,
				text: contentText(data.content),
			});
		}
	} catch (error) {
		return writeJson(res, { error: String((error && error.message) || error) }, 500);
	}

	cache.set(sessionId, { at: Date.now(), items });
	return writeJson(res, { items, total: items.length });
}

export function apply(ctx) {
	const webServer = Reflect.get(ctx, "webServer");
	if (!webServer || typeof webServer.register !== "function") {
		// No HTTP server in this composition — the browser half simply cannot
		// fetch; the host entry still mounts without failing.
		return;
	}
	return webServer.register({
		kind: "exact",
		path: QUESTIONS_PATH,
		handler: (req, res) => {
			handleQuestions(ctx, req, res).catch((error) => {
				try {
					writeJson(res, { error: String((error && error.message) || error) }, 500);
				} catch {
					// response already written / socket gone — nothing left to do
				}
			});
		},
	});
}

export default { name, inject, apply };
