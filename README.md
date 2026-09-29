# deckpresso

An [OpenDeck](https://github.com/nekename/OpenDeck) profile generator plus a small
custom plugin that puts your [Nespresso Stats](https://github.com/avpnusr/nespresso-stats)
dashboard on a Stream Deck. Each capsule key logs a brew on press and shows that
capsule's live remaining stock; two upkeep keys log cleaning / descaling and show
the days until they are due again.

![A 5×3 OpenDeck profile: eight Nespresso capsule keys with art and live stock
counts (Melozio 11, Intenso 14, Fortado 8, Mexico 10, Stormio 10, Maple Pecan 25,
Cinnamon Apple Crisp 18, Pumpkin Spice Cake 25), plus Cleaned and Descaled keys
showing days until due](screenshot.jpg)

The deck in the picture: the top two rows are capsule keys (artwork + remaining
stock), the bottom-right pair are the upkeep keys. Any key can point at a
different capsule, so the layout is just a starting point.

```
 Stream Deck key press ──HTTP──▶ nespresso-stats
        ▲                              │
        └──────── GET /api/state ──────┘   (key titles refresh every 10 s)
```

## What you need

- [OpenDeck](https://github.com/nekename/OpenDeck) running where the Stream Deck is.
- Node.js (OpenDeck ships its own; `ws` below is only needed on Node 20).
- A reachable [nespresso-stats](https://github.com/avpnusr/nespresso-stats) instance.
- Python 3 to run `install.py`.

A great setup is a Stream Deck plugged into a Raspberry Pi running OpenDeck:
the Pi is a cheap, always-on host that the deck and nespresso-stats share a box
with. See [Headless / service deployments](#headless--service-deployments) for
the Xvfb and HID bits that setup needs.

## Setup

1. **Clone and edit the deck.** `CAPSULES` and `MAINTENANCE` at the top of
   `install.py` define the keys. Capsule names must match the names in your
   nespresso-stats dashboard exactly. The second tuple field is the artwork file
   name from `artwork/`; set it to `None` to use the default icon.

2. **Install the plugin.** Copy the bundled plugin folder into OpenDeck's
   `plugins/` directory:

   | OS | OpenDeck config dir |
   | --- | --- |
   | Linux | `~/.config/opendeck` |
   | macOS | `~/Library/Application Support/opendeck` |
   | Windows | `%APPDATA%\opendeck` |

   ```bash
   CONFIG=~/.config/opendeck
   cp -r com.khmls.nespresso.sdPlugin "$CONFIG/plugins/"
   ( cd "$CONFIG/plugins/com.khmls.nespresso.sdPlugin" && npm install )   # Node 20 only
   ```

3. **Generate and install the profile.** Point `--url` at your dashboard:

   ```bash
   python3 install.py --url http://127.0.0.1:8787 --fill-titles
   ```

   This writes `profiles/<device>/nespresso.json` under the OpenDeck config dir.
   Select the **nespresso** profile in OpenDeck.

If OpenDeck runs on another machine, pass `--config-dir` and `--device` (the
folder under `profiles/`) instead of relying on auto-detection.

### Artwork

The repo ships `artwork/`: one 176×176 PNG for every capsule in the
nespresso-stats catalogue (plus the `cleaned` / `descaled` upkeep keys), named
after the capsule — lower-case, spaces replaced by hyphens (`Double Espresso
Scuro` → `double-espresso-scuro.png`). This is the default `--images-dir`, and
`install.py` copies every PNG in it into `<config>/images/nespresso/`, so the
whole pod-type library is available to add to keys later.

To use your own pictures instead, point `--images-dir` at a folder of PNGs:

```bash
python3 install.py --url http://127.0.0.1:8787 --images-dir ./my-art --fill-titles
```

Keys whose file is missing fall back to the plugin icon. The bundled artwork is
AI-generated placeholder art (see [Disclaimer](#disclaimer)).

## How it works

- On `willAppear` / settings change the plugin polls `GET /api/state` every 10 s
  and writes each key's number with `setTitle` — stock count, or days until
  upkeep is due (`ceil(next - now)`, `0` when overdue or never logged).
- A capsule press resolves the capsule id from the last poll and posts
  `POST /api/brew` `{"capsule_id": <id>, "delta": -1, "log": true, "source": "streamdeck"}`,
  then refreshes immediately. If the name isn't in the dashboard it skips the
  press rather than logging an unattributed brew.
- An upkeep press posts `POST /api/maintenance` `{"task": "clean"|"descale"}`.
- Per-key settings: capsule key `{"capsule": "<name>", "url": "<base>"}`, upkeep
  key `{"task": "clean"|"descale", "url": "<base>"}`. `NESPRESSO_POLL_MS`
  overrides the poll interval.

Titles are re-sent every poll, not just on change: OpenDeck ignores an unchanged
title, and re-sending self-heals an update that arrived before the frontend's key
was listening. Only changes are logged. `npm install` is only needed for the `ws`
WebSocket client that Node 20 lacks (Node 22+ uses the built-in one).

## install.py options

```
--url URL          nespresso-stats base URL (default http://127.0.0.1:8787)
--fill-titles      stamp current stock / days-until-due into the profile
                   (reads GET /api/state) -- recommended
--images-dir DIR   folder of key artwork to copy (default: bundled artwork/)
--out FILE         write the profile JSON here instead of installing
--print            print the profile instead of installing
--config-dir DIR   OpenDeck config directory (skips auto-detection)
--device ID        device folder under profiles/ (skips auto-detection)
--selftest         check the profile builder
```

**Always deploy with `--fill-titles`.** The key renders whatever the profile
holds when it loads; the plugin's first `setTitle` can land before the frontend's
key is listening and OpenDeck ignores an unchanged title, so a profile with empty
titles can stay blank until something else changes. Baking the numbers in removes
that dependency; live updates keep working afterwards.

## Headless / service deployments

OpenDeck can run headless under Xvfb (e.g. on a Raspberry Pi), with the Stream
Deck attached to that machine. The service needs HID access as the user it runs
as. The vendor `40-streamdeck.rules` relies on `TAG+="uaccess"` (which needs a
logind session); on a headless box add a rule granting the `plugdev` group, for
example `/etc/udev/rules.d/99-streamdeck-plugdev.rules`.

Deploy steps are the same three above: copy the plugin (`npm install` on Node 20),
copy the artwork, install the profile, then restart OpenDeck. OpenDeck rewrites
the profile in its canonical form on load and persists the live counts back into
`states[].text`, so the on-disk profile can lag the deck by a save cycle — the key
itself updates within one poll.

## Troubleshooting

- **Key shows `?`** — the capsule name in `install.py` doesn't match any capsule
  in nespresso-stats, or the dashboard isn't reachable from the deck machine.
- **Press does nothing and the log says "no capsule id"** — same name mismatch.
- **Blank titles right after loading** — deploy with `--fill-titles`.
- **Plugin doesn't start** — check OpenDeck's plugin log; on Node 20 run
  `npm install` in the plugin folder.

## Disclaimer

This repository is built and maintained with the help of AI agents. All key
artwork in `artwork/` is AI-generated placeholder art — none of it is official
Nespresso imagery, and it is not affiliated with or endorsed by Nespresso.
