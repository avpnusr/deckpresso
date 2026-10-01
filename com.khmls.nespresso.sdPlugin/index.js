#!/usr/bin/env node
// OpenDeck plugin for nespresso-stats.
//   capsule key      -> press logs a brew; title shows remaining stock
//   maintenance key  -> press logs clean/descale; title shows days until due
//   stats key        -> renders a live stat tile (SVG image) from /api/state+/api/stats
//
// OpenDeck spawns this as `node index.js -port <p> -pluginUUID <u>
// -registerEvent registerPlugin -info <json>` and talks the Stream Deck
// protocol over a local WebSocket (see src-tauri/src/plugins/mod.rs).

const POLL_MS = Number(process.env.NESPRESSO_POLL_MS || 10000);
const DEFAULT_URL = "http://127.0.0.1:8787";
const DAY_MS = 86400000;
const STATS_MAX_AGE_MS = 20000; // don't refetch /api/stats on every poll
const IMAGE_RESEND_MS = 30000; // re-send an unchanged tile now and then (self-heal)

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

const instances = new Map(); // context -> { kind, capsule, task, metric, url }
const lastTitles = new Map(); // context -> title last logged
const lastImages = new Map(); // context -> { svg, at }
const statsCache = new Map(); // url -> { at, data }
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
			const actionUuid = String(message.action ?? "");
			const kind = actionUuid.endsWith(".maintenance") ? "maintenance" : actionUuid.endsWith(".stats") ? "stats" : "capsule";
			instances.set(message.context, {
				kind,
				capsule: settings.capsule ?? "",
				task: settings.task ?? "",
				metric: settings.metric ?? "",
				url: (settings.url || DEFAULT_URL).replace(/\/+$/, ""),
			});
			lastImages.delete(message.context); // force a repaint on (re)appear
			log(message.event, message.context, "kind=", kind, kind === "stats" ? `metric=${settings.metric ?? ""}` : "");
			await refresh();
			break;
		}
		case "willDisappear":
			instances.delete(message.context);
			lastTitles.delete(message.context);
			lastImages.delete(message.context);
			break;
		case "keyDown":
			await press(message.context);
			break;
	}
}

// ---------------------------------------------------------------- data fetching

// Days left until an ISO timestamp; 0 when overdue or never logged (i.e. due now).
function daysUntil(iso) {
	if (!iso) return 0;
	const remaining = Date.parse(iso) - Date.now();
	return Number.isFinite(remaining) ? Math.max(0, Math.ceil(remaining / DAY_MS)) : 0;
}

async function fetchState(url) {
	const response = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(8000) });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return response.json();
}

async function fetchStats(url) {
	const hit = statsCache.get(url);
	if (hit && Date.now() - hit.at < STATS_MAX_AGE_MS) return hit.data;
	const response = await fetch(`${url}/api/stats`, { signal: AbortSignal.timeout(8000) });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const data = await response.json();
	statsCache.set(url, { at: Date.now(), data });
	return data;
}

// ------------------------------------------------------------------- metrics

function dayKey(d) {
	const x = new Date(d);
	return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}

// Same aggregation the dashboard does client-side, over the raw brew list.
function computeMetrics(state, stats) {
	const now = new Date();
	const dayStart = (n) => {
		const d = new Date(now);
		d.setDate(d.getDate() - n);
		d.setHours(0, 0, 0, 0);
		return d;
	};
	const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
	const brews = (stats?.brews ?? []).filter((b) => b.delta < 0);
	const capsules = state.capsules ?? [];
	const priceOf = new Map(capsules.map((c) => [c.id, c.price || 0]));
	const capsuleOf = (id) => capsules.find((c) => c.id === id);

	const today = brews.filter((b) => dayKey(b.ts) === dayKey(now)).length;
	const week = brews.filter((b) => new Date(b.ts) >= dayStart(6)).length;
	const recent = brews.filter((b) => new Date(b.ts) >= dayStart(13));
	const avg = recent.length / 14;
	const spend = brews
		.filter((b) => new Date(b.ts) >= monthStart)
		.reduce((sum, b) => sum + (priceOf.get(b.capsule_id) || 0), 0);

	const totalCount = capsules.reduce((sum, c) => sum + (c.count || 0), 0);
	const stockDays = avg > 0 ? Math.floor(totalCount / avg) : null;
	const lowCount = capsules.filter((c) => c.count <= (c.threshold ?? 2)).length;
	const upkeepDays = (task) => daysUntil((state.maintenance ?? []).find((m) => m.task === task)?.next);

	const rank = (keyOf) => {
		const counts = new Map();
		for (const b of brews) {
			const key = keyOf(b);
			if (key) counts.set(key, (counts.get(key) || 0) + 1);
		}
		return [...counts.entries()].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n);
	};
	const byName = rank((b) => capsuleOf(b.capsule_id)?.name);
	const byFamily = rank((b) => capsuleOf(b.capsule_id)?.family);
	const ranked = byName.reduce((sum, r) => sum + r.n, 0);
	const topFamily = byFamily[0] ? { ...byFamily[0], pct: Math.round((100 * byFamily[0].n) / Math.max(1, ranked)) } : null;

	// 12-week heatmap, Monday-aligned, weeks as columns and days as rows.
	const counts = new Map();
	for (const b of brews) {
		const key = dayKey(b.ts);
		counts.set(key, (counts.get(key) || 0) + 1);
	}
	const todayMid = new Date(now);
	todayMid.setHours(0, 0, 0, 0);
	const start = new Date(todayMid);
	start.setDate(todayMid.getDate() - ((todayMid.getDay() + 6) % 7) - 7 * 11);
	const heat = [];
	for (let w = 0; w < 12; w++) {
		const col = [];
		for (let d = 0; d < 7; d++) {
			const day = new Date(start);
			day.setDate(start.getDate() + w * 7 + d);
			col.push(counts.get(dayKey(day)) || 0);
		}
		heat.push(col);
	}
	const weekDays = [];
	for (let i = 6; i >= 0; i--) {
		const d = new Date(now);
		d.setDate(d.getDate() - i);
		weekDays.push(counts.get(dayKey(d)) || 0);
	}

	return {
		today, week, avg, spend, stockDays, lowCount,
		cleanDays: upkeepDays("clean"), descaleDays: upkeepDays("descale"),
		most: byName[0] ?? null, topFamily,
		families: byFamily.slice(0, 4), capsules: byName.slice(0, 4),
		heat, weekDays,
	};
}

// -------------------------------------------------------------------- drawing

const COL = {
	label: "#8b8b97", muted: "#6e6e7a", value: "#f5f5f7",
	gold: "#d4a24e", green: "#7bd88f", amber: "#f5b942", red: "#ff6b6b", blue: "#6bb8ff",
};
const HEAT = ["#2a2a32", "#4a3a20", "#80602f", "#b08842", "#d4a24e"];
const FONT = "Arial,Helvetica,sans-serif";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function svgTile({ label, value = "", sub = "", accent, size, body = "" }) {
	const px = size ?? (value.length <= 2 ? 44 : value.length <= 4 ? 36 : value.length <= 7 ? 28 : 22);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a2a32"/><stop offset="1" stop-color="#1e1e24"/></linearGradient></defs>
<rect width="144" height="144" rx="18" fill="url(#g)"/>
<rect width="144" height="3" rx="1.5" fill="${accent}"/>${body}
<text x="72" y="25" text-anchor="middle" font-family="${FONT}" font-size="10.5" font-weight="bold" letter-spacing="0.5" fill="${COL.label}">${esc(label)}</text>
${value ? `<text x="72" y="82" text-anchor="middle" font-family="${FONT}" font-size="${px}" font-weight="bold" fill="${accent}">${esc(value)}</text>` : ""}
${sub ? `<text x="72" y="130" text-anchor="middle" font-family="${FONT}" font-size="10.5" fill="${COL.muted}">${esc(sub)}</text>` : ""}
</svg>`;
}

function barsBody(rows, accent) {
	const max = Math.max(1, ...rows.map((r) => r.n));
	return rows
		.map((r, i) => {
			const y = 42 + i * 19;
			const w = Math.round(120 * (r.n / max));
			return `<text x="12" y="${y}" font-family="${FONT}" font-size="10" fill="${COL.value}">${esc(r.label)}</text>` +
				`<text x="132" y="${y}" text-anchor="end" font-family="${FONT}" font-size="10" fill="${COL.muted}">${r.n}</text>` +
				`<rect x="12" y="${y + 3}" width="${w}" height="5" rx="2.5" fill="${accent}"/>`;
		})
		.join("");
}

function dayBarsBody(days, accent) {
	const max = Math.max(1, ...days);
	const base = 106, bw = 12, gap = 4, total = days.length * bw + (days.length - 1) * gap;
	const gx = (144 - total) / 2;
	return days
		.map((v, i) => {
			const h = Math.round(58 * (v / max));
			const x = gx + i * (bw + gap);
			return `<rect x="${x}" y="${base - h}" width="${bw}" height="${h}" rx="3" fill="${accent}"/>` +
				`<text x="${x + bw / 2}" y="${base + 13}" text-anchor="middle" font-family="${FONT}" font-size="8.5" fill="${COL.muted}">${"MTWTFSS"[i]}</text>`;
		})
		.join("");
}

function heatmapBody(cells, _accent) {
	const cw = 8, ch = 8, gap = 1, gx = 18.5, gy = 40;
	let out = "";
	for (let w = 0; w < cells.length; w++) {
		for (let d = 0; d < cells[w].length; d++) {
			const n = cells[w][d];
			const lvl = n === 0 ? 0 : n === 1 ? 1 : n === 2 ? 2 : n === 3 ? 3 : 4;
			out += `<rect x="${gx + w * (cw + gap)}" y="${gy + d * (ch + gap)}" width="${cw}" height="${ch}" rx="1.5" fill="${HEAT[lvl]}"/>`;
		}
	}
	return out;
}

function renderTile(metric, m) {
	switch (metric) {
		case "today":
			return svgTile({ label: "TODAY", value: String(m.today), sub: m.today === 1 ? "brew" : "brews", accent: COL.gold });
		case "week":
			return svgTile({ label: "LAST 7 DAYS", value: String(m.week), sub: "brews", accent: COL.value });
		case "avg":
			return svgTile({ label: "AVG / DAY", value: m.avg.toFixed(1), sub: "14-day average", accent: COL.value });
		case "month":
			return svgTile({ label: "THIS MONTH", value: "€" + m.spend.toFixed(2), sub: "spend", accent: COL.value, size: 30 });
		case "stock_left":
			return svgTile({ label: "STOCK LEFT", value: m.stockDays == null ? "—" : `~${m.stockDays}d`, sub: "at this rate", accent: COL.green, size: 38 });
		case "most_brewed":
			return svgTile({ label: "MOST BREWED", value: m.most ? m.most.label : "—", sub: m.most ? `${m.most.n} brews` : "no brews", accent: COL.gold, size: 24 });
		case "running_low":
			return svgTile({ label: "RUNNING LOW", value: String(m.lowCount), sub: m.lowCount === 1 ? "capsule" : "capsules", accent: COL.red });
		case "next_clean":
			return svgTile({ label: "NEXT CLEAN", value: `${m.cleanDays}d`, sub: "cleaning due", accent: COL.amber, size: 40 });
		case "next_descaled":
			return svgTile({ label: "NEXT DESCALE", value: `${m.descaleDays}d`, sub: "descaling due", accent: COL.green, size: 40 });
		case "top_family":
			return svgTile({ label: "TOP FAMILY", value: m.topFamily ? m.topFamily.label : "—", sub: m.topFamily ? `${m.topFamily.pct}% of brews` : "", accent: COL.gold, size: 30 });
		case "heatmap":
			return svgTile({ label: "12 WEEKS", sub: "daily brews", accent: COL.gold, body: heatmapBody(m.heat) });
		case "week_bars":
			return svgTile({ label: "LAST 7 DAYS", sub: "", accent: COL.gold, body: dayBarsBody(m.weekDays, COL.gold) });
		case "by_family":
			return svgTile({ label: "BY FAMILY", sub: "", accent: COL.gold, body: barsBody(m.families, COL.gold) });
		case "top_capsules":
			return svgTile({ label: "TOP CAPSULES", sub: "", accent: COL.gold, body: barsBody(m.capsules, COL.gold) });
		default:
			return svgTile({ label: (metric || "STAT").toUpperCase(), value: "—", accent: COL.blue });
	}
}

// ------------------------------------------------------------------- refresh

async function refresh() {
	const urls = new Set([...instances.values()].map((i) => i.url));
	for (const url of urls) {
		let state;
		try {
			state = await fetchState(url);
		} catch (error) {
			console.error("nespresso-deck: poll failed:", url, error.message);
			continue;
		}
		const stock = new Map((state.capsules ?? []).map((capsule) => [capsule.name, capsule.count]));
		const ids = new Map((state.capsules ?? []).map((capsule) => [capsule.name, capsule.id]));
		const upkeep = new Map((state.maintenance ?? []).map((entry) => [entry.task, entry.next]));

		let metrics = null;
		const wantsStats = [...instances.values()].some((i) => i.url === url && i.kind === "stats");
		if (wantsStats) {
			try {
				metrics = computeMetrics(state, await fetchStats(url));
			} catch (error) {
				console.error("nespresso-deck: stats fetch failed:", url, error.message);
			}
		}

		for (const [context, instance] of instances) {
			if (instance.url !== url) continue;
			if (instance.kind === "stats") {
				if (instance.metric && metrics) setImage(context, renderTile(instance.metric, metrics));
				continue;
			}
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

function setImage(context, svg) {
	const previous = lastImages.get(context);
	// OpenDeck always repaints a setImage (unlike setTitle), so skip unchanged
	// tiles but refresh them occasionally in case an early update was missed.
	if (previous && previous.svg === svg && Date.now() - previous.at < IMAGE_RESEND_MS) return;
	lastImages.set(context, { svg, at: Date.now() });
	const image = "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
	ws.send(JSON.stringify({ event: "setImage", context, payload: { image, state: 0 } }));
}

async function press(context) {
	const instance = instances.get(context);
	if (!instance || instance.kind === "stats") return;
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
	statsCache.delete(instance.url); // a press changes the stats
	await refresh();
}

setInterval(refresh, POLL_MS);
refresh();
