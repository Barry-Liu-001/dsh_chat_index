/**
 * dsh-chat-index — host (Node) entry.
 *
 * Client-only plugin: every piece of behavior lives in ./client.js (the
 * browser dot-rail over the conversation scrollport). The host entry exists
 * so the bundle can be inserted into the Loader tree via cordis.patch.yml;
 * it has no server-side behavior of its own.
 *
 * @module dsh-chat-index
 */

export const name = "dsh-chat-index";
export const inject = [];

export function apply() {
	// no host-side behavior — the browser half is fully self-contained DOM UI
}

export default { name, inject, apply };
