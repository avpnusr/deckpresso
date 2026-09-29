#!/usr/bin/env node
// OpenDeck plugin: pressing a key logs the action on a nespresso-stats
// dashboard, and the key title shows a live number —
//   capsule key      -> remaining capsules in stock
//   maintenance key  -> days until that job is due again
//
// OpenDeck spawns this as `node index.js -port <p> -pluginUUID <u>
// -registerEvent registerPlugin -info <json>` and talks the Stream Deck
// protocol over a local WebSocket (see src-tauri/src/plugins/mod.rs).

const POLL_MS = Number(process.env.NESPRESSO_POLL_MS || 10000);
const DEFAULT_URL = "http://127.0.0.1:8787";
const DAY_MS = 86400000;

const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const port = arg("-port");
const uuid = arg("-pluginUUID");
if (!port || !uuid) {
	console.error("nespresso-deck: missing -port/-pluginUUID, not started by OpenDeck?");
	process.exit(1);
}

// Node 22+ has a global WebSocket; Node 20 ships undici's. `ws` (installed here) wins.
function connect(url) {
	if (globalThis.WebSocket) {
		return new globalThis.WebSocket(url);
	}
	try {
		return new (require("ws"))(url);
	} catch {
		return new (require("undici").WebSocket)(url);
	}
}

const instances = new Map(); // context -> { kind, capsule, task, url }
const lastTitles = new Map(); // context -> title last logged
const ws = connect(`ws://127.0.0.1:${port}`);

const log = (...args) => console.log("nespresso-deck:", ...args);

ws.addEventListener("open", () => {
	log("connected, registering", uuid);
	ws.send(JSON.stringify({ event: "registerPlugin", uuid }));
});
ws.addEventListener("error", (error) => console.error("nespresso-deck: socket error:", error?.message ?? error));
ws.addEventListener("close", () => {
	console.error("nespresso-deck: socket closed");
	process.exit(0);
});

ws.addEventListener("message", (event) => {
	handle(event.data).catch((error) => console.error("nespresso-deck: handler failed:", error));
});

async function handle(raw) {
	let message;
	try {
		message = JSON.parse(typeof raw === "string" ? raw : raw.toString());
	} catch {
		return;
	}
	switch (message.event) {
		case "willAppear":
		case "didReceiveSettings": {
			const settings = message.payload?.settings ?? {};
			instances.set(message.context, {
				kind: String(message.action ?? "").endsWith(".maintenance") ? "maintenance" : "capsule",
				capsule: settings.capsule ?? "",
				task: settings.task ?? "",
				url: (settings.url || DEFAULT_URL).replace(/\/+$/, ""),
			});
			log(message.event, message.context, "kind=", instances.get(message.context).kind);
			await refresh();
			break;
		}
		case "willDisappear":
			instances.delete(message.context);
			lastTitles.delete(message.context);
			break;
		case "keyDown":
			await press(message.context);
			break;
	}
}

// Days left until an ISO timestamp; 0 when overdue or never logged (i.e. due now).
function daysUntil(iso) {
	if (!iso) return 0;
	const remaining = Date.parse(iso) - Date.now();
	return Number.isFinite(remaining) ? Math.max(0, Math.ceil(remaining / DAY_MS)) : 0;
}

async function dashboard(url) {
	const response = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(8000) });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return response.json();
}

async function refresh() {
	for (const url of new Set([...instances.values()].map((i) => i.url))) {
		let state;
		try {
			state = await dashboard(url);
		} catch (error) {
			console.error("nespresso-deck: poll failed:", url, error.message);
			continue;
		}
		const stock = new Map((state.capsules ?? []).map((capsule) => [capsule.name, capsule.count]));
		const ids = new Map((state.capsules ?? []).map((capsule) => [capsule.name, capsule.id]));
		const upkeep = new Map((state.maintenance ?? []).map((entry) => [entry.task, entry.next]));

		for (const [context, instance] of instances) {
			if (instance.url !== url) continue;
			let title;
			if (instance.kind === "maintenance") {
				if (!instance.task) continue;
				title = String(daysUntil(upkeep.get(instance.task)));
			} else {
				if (!instance.capsule) continue;
				// Resolve the capsule id now so a press can log the exact capsule.
				instance.capsuleId = ids.get(instance.capsule);
				const count = stock.get(instance.capsule);
				title = Number.isFinite(count) ? String(count) : "?";
			}
			// Resend every poll, not just on change: OpenDeck no-ops an unchanged
			// title, and this self-heals an update that arrived before the frontend's
			// key was listening (otherwise the value stays blank until a restart).
			setTitle(context, title);
			const label = instance.capsule || instance.task;
			if (lastTitles.get(context) !== title) {
				lastTitles.set(context, title);
				log("title", label, "->", title);
			}
		}
	}
}

function setTitle(context, title) {
	ws.send(JSON.stringify({ event: "setTitle", context, payload: { title, state: 0 } }));
}

async function press(context) {
	const instance = instances.get(context);
	if (!instance) return;
	const upkeep = instance.kind === "maintenance";
	if (upkeep ? !instance.task : !instance.capsule) return;

	// /api/brew-detected only takes a family and would queue a pending brew for
	// any family with several capsules. A Stream Deck key is one capsule, so log
	// it by id (resolved from /api/state in refresh).
	const [path, body] = upkeep
		? ["/api/maintenance", { task: instance.task }]
		: instance.capsuleId == null
			? [null, null]
			: ["/api/brew", { capsule_id: instance.capsuleId, delta: -1, log: true, source: "streamdeck" }];
	if (!path) {
		console.error("nespresso-deck: no capsule id for", instance.capsule, "- is it in nespresso-stats?");
		return;
	}
	try {
		const response = await fetch(`${instance.url}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(8000),
		});
		log("press", instance.capsule || instance.task, response.status, await response.text());
	} catch (error) {
		console.error("nespresso-deck: press failed:", instance.capsule || instance.task, error.message);
	}
	await refresh();
}

setInterval(refresh, POLL_MS);
refresh();
