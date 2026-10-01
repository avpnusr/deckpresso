#!/usr/bin/env python3
"""Generate an OpenDeck profile whose keys drive a nespresso-stats instance.

Every key uses the bundled `com.khmls.nespresso.sdPlugin`, which on a press logs
the action and keeps the key title showing a live number:

  * capsule key (`com.khmls.nespresso.capsule`)     -> capsules left in stock
  * upkeep key  (`com.khmls.nespresso.maintenance`) -> days until due again

    python3 install.py --url http://127.0.0.1:8787                # install
    python3 install.py --url ... --fill-titles --out nespresso.json
    python3 install.py --url ... --print                           # dump the JSON
    python3 install.py --url ... --images-dir <dir>                # another artwork folder
    python3 install.py --selftest

Always deploy with --fill-titles: it stamps the current numbers into the profile
so a freshly loaded deck shows them straight away (see fill_titles below).

The deck lives in CAPSULES / MAINTENANCE below; the second CAPSULES field is the
artwork file name, resolved against --images-dir (default: the bundled artwork/,
which has a 176x176 PNG for every capsule in the nespresso-stats catalogue).
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import math
import os
import shutil
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

# One key per capsule. The name must match a capsule in nespresso-stats exactly
# (the plugin resolves it by name from /api/state). The second field is the art
# file in --images-dir; set it to None to fall back to the plugin icon.
CAPSULES: list[tuple[str, str | None]] = [
    ("Melozio", "melozio.png"),
    ("Intenso", "intenso.png"),
    ("Fortado", "fortado.png"),
    ("Mexico", "mexico.png"),
    ("Stormio", "stormio.png"),
    ("Maple Pecan", "maple-pecan.png"),
    ("Cinnamon Apple Crisp", "cinnamon-apple-crisp.png"),
    ("Pumpkin Spice Cake", "pumpkin-spice-cake.png"),
]

# Where the copied artwork lives, relative to OpenDeck's config dir.
IMAGE_PREFIX = "images/nespresso"

# Bundled artwork library: one 176x176 PNG per known capsule plus the upkeep keys,
# named after the capsule (lower-case, spaces -> hyphens). Used as the default for
# --images-dir, so the base works out of the box.
ARTWORK_DIR = Path(__file__).resolve().parent / "artwork"

# Upkeep keys: (label, task, image, key position). Positions are explicit — the
# bottom row is Descaled, Cleaned, then the Stats button in the bottom-right
# slot. The task name must match the server's MAINTENANCE keys ("clean" /
# "descale"); the image is the art file in --images-dir.
MAINTENANCE = [
    ("Descaled", "descale", "descaled.png", 12),
    ("Cleaned", "clean", "cleaned.png", 13),
]

# Plugin ids. Paths are relative to OpenDeck's config dir — it resolves them on
# load, so the same profile works on any machine.
NESPRESSO_PLUGIN = "com.khmls.nespresso.sdPlugin"
CAPSULE_UUID = "com.khmls.nespresso.capsule"
MAINTENANCE_UUID = "com.khmls.nespresso.maintenance"
STATS_UUID = "com.khmls.nespresso.stats"

# Profile switching uses OpenDeck's bundled starter-pack action (only that plugin
# is allowed to send switchProfile). The bottom-right key of the main deck opens
# the stats page; the top-left key of the stats page comes back.
STARTERPACK_PLUGIN = "com.amansprojects.starterpack.sdPlugin"
SWITCH_PROFILE_UUID = "com.amansprojects.starterpack.switchprofile"
STARTERPACK_ICON = f"plugins/{STARTERPACK_PLUGIN}/icons/switchProfile.png"
PROFILE_ID = "nespresso"
STATS_PROFILE_ID = "nespresso-stats"

# Stats page layout: key position -> metric id understood by the plugin.
STATS_LAYOUT = [
    (1, "today"), (2, "week"), (3, "avg"), (4, "month"),
    (5, "stock_left"), (6, "most_brewed"), (7, "running_low"),
    (8, "next_clean"), (9, "next_descaled"),
    (10, "heatmap"), (11, "week_bars"), (12, "by_family"),
    (13, "top_capsules"), (14, "top_family"),
]

# Style of the number the plugin writes into a key title: white, bold,
# bottom-middle over the artwork.
STOCK_TEXT = {
    "show": True,
    "alignment": "bottom",
    "size": 30,
    "colour": "#FFFFFF",
    "style": "Bold",
}
# Stats and navigation keys carry their own SVG image, so OpenDeck draws no title.
IMAGE_TEXT = {"show": False, "alignment": "bottom", "size": 30, "colour": "#FFFFFF", "style": "Bold"}


def plugin_action(uuid: str, name: str, tooltip: str, *, plugin: str = NESPRESSO_PLUGIN,
                  icon: str | None = None, state: dict | None = None, multi: bool = False) -> dict:
    icon = icon or f"plugins/{plugin}/icon.png"
    return {
        "name": name,
        "uuid": uuid,
        "plugin": plugin,
        "tooltip": tooltip,
        "icon": icon,
        "disable_automatic_states": False,
        "visible_in_action_list": True,
        "supported_in_multi_actions": multi,
        "property_inspector": "",
        "controllers": ["Keypad"],
        "encoder": None,
        # The plugin writes the number into the state title.
        "states": [state or {"image": icon, **STOCK_TEXT}],
    }


def switch_profile_action() -> dict:
    return plugin_action(SWITCH_PROFILE_UUID, "Switch Profile", "Switch the selected profile",
                         plugin=STARTERPACK_PLUGIN, icon=STARTERPACK_ICON,
                         state={"image": STARTERPACK_ICON, **IMAGE_TEXT}, multi=True)


def instance(action: dict, position: int, settings: dict, state: dict) -> dict:
    return {
        "action": action,
        "context": f"Keypad.{position}.0",
        "states": [dict(state)],
        "current_state": 0,
        "settings": settings,
        "children": None,
    }


def _svg_tile(label: str, sub: str, body: str, accent: str) -> str:
    font = "Arial,Helvetica,sans-serif"
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">'
        '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">'
        '<stop offset="0" stop-color="#2a2a32"/><stop offset="1" stop-color="#1e1e24"/>'
        '</linearGradient></defs>'
        '<rect width="144" height="144" rx="18" fill="url(#g)"/>'
        f'<rect width="144" height="3" rx="1.5" fill="{accent}"/>'
        f'{body}'
        f'<text x="72" y="25" text-anchor="middle" font-family="{font}" font-size="10.5" '
        f'font-weight="bold" letter-spacing="0.5" fill="#8b8b97">{label}</text>'
        f'<text x="72" y="130" text-anchor="middle" font-family="{font}" font-size="10.5" '
        f'fill="#6e6e7a">{sub}</text>'
        '</svg>'
    )


def _svg_data(svg: str) -> str:
    return "data:image/svg+xml;base64," + base64.b64encode(svg.encode("utf-8")).decode("ascii")


def nav_image(kind: str) -> str:
    """Inline SVG for a navigation key: 'stats' (bar chart) or 'coffee' (back arrow)."""
    blue = "#6bb8ff"
    if kind == "stats":
        body = (f'<rect x="50" y="66" width="10" height="20" rx="2" fill="{blue}"/>'
                f'<rect x="66" y="54" width="10" height="32" rx="2" fill="{blue}"/>'
                f'<rect x="82" y="60" width="10" height="26" rx="2" fill="{blue}"/>')
        label, sub = "STATS", "coffee stats"
    else:
        body = (f'<line x1="88" y1="76" x2="60" y2="76" stroke="{blue}" stroke-width="6"/>'
                f'<polygon points="46,76 64,64 64,88" fill="{blue}"/>')
        label, sub = "COFFEE", "back to selection"
    return _svg_data(_svg_tile(label, sub, body, blue))


def placeholder_image(metric: str) -> str:
    """Blank tile the plugin overwrites with the live stat on its first poll."""
    return _svg_data(_svg_tile(metric.replace("_", " ").upper(), "", "", "#6bb8ff"))


def build_profile(url: str, stats_profile: str = STATS_PROFILE_ID) -> dict:
    size = max(15, len(CAPSULES), max(position for *_, position in MAINTENANCE) + 1, 15)
    keys: list[dict | None] = [None] * size

    capsule = plugin_action(CAPSULE_UUID, "Capsule", "Brew this capsule and show its remaining stock")
    for position, (name, image) in enumerate(CAPSULES):
        state = {"image": f"{IMAGE_PREFIX}/{image}" if image else capsule["icon"], **STOCK_TEXT}
        keys[position] = instance(capsule, position, {"capsule": name, "url": url}, state)

    upkeep = plugin_action(MAINTENANCE_UUID, "Upkeep", "Log this job and show the days until it is due again")
    for label, task, image, position in MAINTENANCE:
        state = {"image": f"{IMAGE_PREFIX}/{image}" if image else upkeep["icon"], **STOCK_TEXT}
        keys[position] = instance(upkeep, position, {"task": task, "url": url}, state)

    # Bottom-right opens the stats page.
    keys[14] = instance(switch_profile_action(), 14, {"profile": stats_profile},
                        {"image": nav_image("stats"), **IMAGE_TEXT})

    return {"keys": keys, "sliders": [], "infobars": []}


def build_stats_profile(url: str, profile_id: str = PROFILE_ID) -> dict:
    size = 15
    keys: list[dict | None] = [None] * size

    # Top-left returns to the coffee selection.
    keys[0] = instance(switch_profile_action(), 0, {"profile": profile_id},
                       {"image": nav_image("coffee"), **IMAGE_TEXT})

    stats = plugin_action(STATS_UUID, "Stats", "Show a live coffee stat",
                          state={"image": f"plugins/{NESPRESSO_PLUGIN}/icon.png", **IMAGE_TEXT})
    for position, metric in STATS_LAYOUT:
        state = {"image": placeholder_image(metric), **IMAGE_TEXT}
        keys[position] = instance(stats, position, {"metric": metric, "url": url}, state)

    return {"keys": keys, "sliders": [], "infobars": []}


def days_until(next_iso: str | None, now: datetime | None = None) -> int:
    """Whole days left until an ISO timestamp; 0 when overdue or never done."""
    if not next_iso:
        return 0
    now = now or datetime.now(timezone.utc)
    return max(0, math.ceil((datetime.fromisoformat(next_iso) - now).total_seconds() / 86400))


def fill_titles(profile: dict, url: str, timeout: float = 10.0) -> int:
    """Stamp the current stock / days-until-due into the profile.

    The key renders whatever the profile holds at load time. The plugin's first
    setTitle can land before the frontend's key is listening, and OpenDeck no-ops
    an unchanged title — so a profile pushed with empty titles can stay blank
    until some later change. Baking the numbers in removes that dependency; live
    updates keep working afterwards.
    """
    with urllib.request.urlopen(f"{url.rstrip('/')}/api/state", timeout=timeout) as response:
        state = json.load(response)
    stock = {capsule["name"]: capsule["count"] for capsule in state.get("capsules", [])}
    upkeep = {entry["task"]: entry.get("next") for entry in state.get("maintenance", [])}

    filled = 0
    for key in profile["keys"]:
        if not key:
            continue
        if key["action"]["uuid"] == CAPSULE_UUID:
            count = stock.get(key["settings"]["capsule"])
            if count is not None:
                key["states"][0]["text"] = str(count)
                filled += 1
        elif key["action"]["uuid"] == MAINTENANCE_UUID:
            key["states"][0]["text"] = str(days_until(upkeep.get(key["settings"]["task"])))
            filled += 1
    return filled


def config_dir() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "opendeck"
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", Path.home() / "AppData/Roaming")) / "opendeck"
    return Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "opendeck"


def find_device(config: Path, requested: str | None) -> str:
    if requested:
        return requested
    profiles = config / "profiles"
    devices = sorted(d.name for d in profiles.iterdir() if d.is_dir()) if profiles.is_dir() else []
    if len(devices) == 1:
        return devices[0]
    if not devices:
        sys.exit(f"No device found under {profiles}. Run OpenDeck once, or pass --device <id>.")
    sys.exit(f"Several devices found ({', '.join(devices)}); pass --device <id>.")


def _texts(profile: dict, uuid: str) -> dict[int, str]:
    return {position: key["states"][0].get("text")
            for position, key in enumerate(profile["keys"]) if key and key["action"]["uuid"] == uuid}


def selftest() -> None:
    profile = build_profile("https://deck.test/")
    keys = [k for k in profile["keys"] if k]
    assert len(profile["keys"]) >= 15, "slots too few"
    assert len(keys) == len(CAPSULES) + len(MAINTENANCE) + 1
    for position, key in enumerate(profile["keys"]):
        if not key:
            continue
        assert key["context"] == f"Keypad.{position}.0", key["context"]
        state = key["states"][0]
        if key["action"]["uuid"] == SWITCH_PROFILE_UUID:
            assert key["settings"] == {"profile": STATS_PROFILE_ID}, key["settings"]
            assert state["show"] is False and state["image"].startswith("data:image/svg+xml"), state
            continue
        assert key["action"]["plugin"] == NESPRESSO_PLUGIN
        assert key["settings"]["url"] == "https://deck.test/"
        assert state["show"] is True and state["alignment"] == "bottom", state
        assert state["colour"] == STOCK_TEXT["colour"] and state["style"] == "Bold", state
        assert state["image"].startswith(IMAGE_PREFIX), state["image"]
    assert json.loads(json.dumps(profile)) == profile, "not JSON round-trippable"

    # one key per capsule, and every capsule carries its name
    assert sorted(k["settings"]["capsule"] for k in keys
                  if k["action"]["uuid"] == CAPSULE_UUID) == sorted(n for n, _ in CAPSULES)
    # upkeep keys, then the stats button, across the bottom row
    tasks = {k["settings"]["task"]: p for p, k in enumerate(profile["keys"])
             if k and k["action"]["uuid"] == MAINTENANCE_UUID}
    assert tasks == {"clean": 13, "descale": 12}, tasks
    assert profile["keys"][14]["action"]["uuid"] == SWITCH_PROFILE_UUID, "stats button bottom-right"

    # the stats page: back button top-left + 14 metric tiles
    page = build_stats_profile("https://deck.test/")
    assert len(page["keys"]) == 15 and all(page["keys"]), "stats page must fill all keys"
    back = page["keys"][0]
    assert back["action"]["uuid"] == SWITCH_PROFILE_UUID and back["settings"] == {"profile": PROFILE_ID}, back
    assert back["states"][0]["image"].startswith("data:image/svg+xml"), back
    metrics = {k["settings"]["metric"]: p for p, k in enumerate(page["keys"])
               if k["action"]["uuid"] == STATS_UUID}
    assert sorted(metrics) == sorted(m for _, m in STATS_LAYOUT), metrics
    for key in (k for k in page["keys"] if k["action"]["uuid"] == STATS_UUID):
        assert key["settings"]["url"] == "https://deck.test/"
        assert key["states"][0]["show"] is False
        assert key["states"][0]["image"].startswith("data:image/svg+xml"), key["states"][0]["image"]
    assert json.loads(json.dumps(page)) == page, "stats page not JSON round-trippable"

    # days_until: overdue / never done -> 0, future rounds up
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    assert days_until(None, now) == 0
    assert days_until((now - timedelta(hours=1)).isoformat(), now) == 0
    assert days_until((now + timedelta(days=3)).isoformat(), now) == 3
    assert days_until((now + timedelta(days=2, hours=1)).isoformat(), now) == 3, "rounds up"

    # --fill-titles stamps stock and days so a fresh profile renders numbers
    class FakeResponse(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

    body = json.dumps({
        "capsules": [{"name": name, "count": i} for i, (name, _) in enumerate(CAPSULES)],
        "maintenance": [{"task": "clean", "next": (now + timedelta(days=4)).isoformat()},
                        {"task": "descale", "next": None}],
    }).encode()
    original, urllib.request.urlopen = urllib.request.urlopen, lambda url, timeout=0: FakeResponse(body)
    try:
        assert fill_titles(profile, "https://deck.test/") == len(CAPSULES) + len(MAINTENANCE)
    finally:
        urllib.request.urlopen = original
    assert _texts(profile, CAPSULE_UUID)[0] == "0", _texts(profile, CAPSULE_UUID)
    assert _texts(profile, MAINTENANCE_UUID)[12] == "0", "never logged -> due -> 0"
    assert _texts(profile, MAINTENANCE_UUID)[13].isdigit(), "clean shows days left"
    print("selftest ok")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", default="http://127.0.0.1:8787", help="nespresso-stats base URL")
    parser.add_argument("--config-dir", type=Path, default=None, help="OpenDeck config directory")
    parser.add_argument("--device", default=None, help="device id (the folder under profiles/)")
    parser.add_argument("--images-dir", type=Path, default=ARTWORK_DIR,
                        help=f"folder of key artwork, *.png (default: bundled {ARTWORK_DIR.name}/)")
    parser.add_argument("--profile-id", default="nespresso", help="profile file name (default: nespresso)")
    parser.add_argument("--fill-titles", action="store_true",
                        help="stamp current stock and days-until-due into the profile (GET --url/api/state)")
    parser.add_argument("--out", type=Path, default=None, help="write the profile here instead")
    parser.add_argument("--stats", action="store_true", help="with --print/--out, use the stats page instead")
    parser.add_argument("--print", action="store_true", help="print the profile instead of installing")
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()

    if args.selftest:
        selftest()
        return

    config = args.config_dir or config_dir()
    stats_profile_id = f"{args.profile_id}-stats"
    main_profile = build_profile(args.url, stats_profile_id)
    page_profile = build_stats_profile(args.url, args.profile_id)
    if args.fill_titles:
        try:
            print(f"stamped {fill_titles(main_profile, args.url)} titles from {args.url}")
        except Exception as error:  # noqa: BLE001 - a deploy without numbers still beats failing
            print(f"warning: could not fetch state from {args.url}: {error}", file=sys.stderr)

    if args.print:
        print(json.dumps(page_profile if args.stats else main_profile, indent="\t"))
        return
    if args.out:
        chosen = page_profile if args.stats else main_profile
        args.out.write_text(json.dumps(chosen, indent="\t") + "\n")
        print(f"wrote {args.out}")
        return

    if args.images_dir:
        images = sorted(args.images_dir.glob("*.png"))
        target_dir = config / IMAGE_PREFIX
        target_dir.mkdir(parents=True, exist_ok=True)
        for source in images:
            shutil.copyfile(source, target_dir / source.name)
        print(f"copied {len(images)} artwork files to {target_dir}")
    device = find_device(config, args.device)
    target_dir = config / "profiles" / device
    target_dir.mkdir(parents=True, exist_ok=True)
    for name, prof in ((args.profile_id, main_profile), (stats_profile_id, page_profile)):
        (target_dir / f"{name}.json").write_text(json.dumps(prof, indent="\t") + "\n")
        print(f"wrote {target_dir / f'{name}.json'}")
    print(f"Select the '{args.profile_id}' profile for device {device} in OpenDeck.")


if __name__ == "__main__":
    main()
