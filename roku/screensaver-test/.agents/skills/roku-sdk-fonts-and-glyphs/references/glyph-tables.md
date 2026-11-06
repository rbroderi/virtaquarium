<!-- @roku-sdk/ai managed v=1 hash=adc2fae93e3f65cec1e136acf2d7d3e8392ffa8be85413aade53d801f8e327d2 skills=1 do-not-edit -->

# Glyph tables

45 constants, from `@roku-sdk/components/glyphs`. They are split into three tables here for the
one reason that matters at runtime — **which font supplies the character** — because that, not the
codepoint, decides whether a symbol survives a custom app typeface.

| Group | Count | Under a system font | Under a custom app font |
|---|---|---|---|
| RokuFont01 private-use glyphs | 32 | renders | renders — firmware fallback applies |
| Unicode characters RokuFont01 backs | 3 | renders | renders — same fallback |
| RokuUI-Regular symbols | 10 | renders | **tofu**, unless the custom font supplies them |

35 of the 45 are safe under a custom typeface. The ten that are not are the ones that look most
ordinary, which is why this split is worth carrying.

Verified on device twice, on different hardware and different firmware, by rendering the
constants in a label with a custom TrueType font.

- Roku Express 4K+, firmware 15.3.5: the private-use glyphs and the stars came through; `←` `↑`
  `→` `↓` `✓` `✗` were empty boxes. `•` `…` `–` `—` rendered only because that particular font
  happened to contain them — do not read that as a guarantee.
- Roku Native (2910X), firmware 16.0.4, 1080p: same split. Under the system font every constant
  rendered; under a custom TrueType the button glyphs and `★` `☆` rendered and `←` `→` `✓` were
  boxes. The same run also showed a `Font` with a `uri` and no `size` drawing a speck, and
  `fallbackGlyph` — as `u25CF` and as a literal `●` — leaving every box exactly as it was, both
  for a RokuUI-only symbol and for a codepoint (`U+0E5B`, `U+A64B`) that no font on the device
  has.

The two runs agree, which is the point of having both: this split is a property of the firmware's
font chain, not of one box.

## 1. RokuFont01 — private-use glyphs (safe under a custom font)

RokuFont01 is wired in as the system-wide fallback font in firmware, so these resolve wherever
they appear.

| Constant | Codepoint | Placeholder | Description |
|---|---|---|---|
| `OPTIONS_GLYPH` | `U+E000` | `{OPTIONS_GLYPH}` | Options / star (no border) |
| `OK_BUTTON_GLYPH` | `U+E001` | `{OK_BUTTON_GLYPH}` | OK in circle |
| `OPTIONS_BUTTON_GLYPH` | `U+E002` | `{OPTIONS_BUTTON_GLYPH}` | Options / star (with border) |
| `MICROPHONE_GLYPH` | `U+E003` | `{MICROPHONE_GLYPH}` | Microphone (no border) |
| `PLAY_PAUSE_BUTTON_GLYPH` | `U+E004` | `{PLAY_PAUSE_BUTTON_GLYPH}` | Play/pause (with border) |
| `PLAY_PAUSE_GLYPH` | `U+E005` | `{PLAY_PAUSE_GLYPH}` | Play/pause (no border) |
| `DOT_GLYPH` | `U+E006` | `{DOT_GLYPH}` | Baseline-aligned dot (icon-row form) |
| `HOME_GLYPH` | `U+E007` | `{HOME_GLYPH}` | Home (no border) |
| `SEARCH_GLYPH` | `U+E008` | `{SEARCH_GLYPH}` | Search / magnifying glass |
| `REMOTE_GLYPH` | `U+E009` | `{REMOTE_GLYPH}` | Remote control |
| `REPLAY_GLYPH` | `U+E010` | `{REPLAY_GLYPH}` | Instant replay |
| `MICROPHONE_BUTTON_GLYPH` | `U+E011` | `{MICROPHONE_BUTTON_GLYPH}` | Microphone (with border) |
| `SEARCH_BUTTON_GLYPH` | `U+E012` | `{SEARCH_BUTTON_GLYPH}` | Search (with border) |
| `FAST_FORWARD_GLYPH` | `U+E013` | `{FAST_FORWARD_GLYPH}` | Fast forward |
| `REWIND_GLYPH` | `U+E014` | `{REWIND_GLYPH}` | Rewind |
| `SHORTCUT_ONE_BUTTON_GLYPH` | `U+E015` | `{SHORTCUT_ONE_BUTTON_GLYPH}` | Shortcut 1 |
| `SHORTCUT_TWO_BUTTON_GLYPH` | `U+E016` | `{SHORTCUT_TWO_BUTTON_GLYPH}` | Shortcut 2 |
| `CLOSED_CAPTIONS_GLYPH` | `U+E017` | `{CLOSED_CAPTIONS_GLYPH}` | Closed captions |
| `LIVE_TV_GLYPH` | `U+E018` | `{LIVE_TV_GLYPH}` | Live TV |
| `SLEEP_TIMER_GLYPH` | `U+E019` | `{SLEEP_TIMER_GLYPH}` | Sleep timer |
| `GENERAL_APP_GLYPH` | `U+E020` | `{GENERAL_APP_GLYPH}` | General app icon |
| `BACK_BUTTON_GLYPH` | `U+E021` | `{BACK_BUTTON_GLYPH}` | Back |
| `HOME_BUTTON_GLYPH` | `U+E022` | `{HOME_BUTTON_GLYPH}` | Home button |
| `QUICK_LAUNCH_BUTTON_GLYPH` | `U+E023` | `{QUICK_LAUNCH_BUTTON_GLYPH}` | Quick launch / rocket |
| `DOWN_BUTTON_GLYPH` | `U+E024` | `{DOWN_BUTTON_GLYPH}` | Down |
| `LEFT_BUTTON_GLYPH` | `U+E025` | `{LEFT_BUTTON_GLYPH}` | Left |
| `RIGHT_BUTTON_GLYPH` | `U+E026` | `{RIGHT_BUTTON_GLYPH}` | Right |
| `KIDS_PROFILE_GLYPH` | `U+E027` | `{KIDS_PROFILE_GLYPH}` | Kids profile |
| `UP_BUTTON_GLYPH` | `U+E028` | `{UP_BUTTON_GLYPH}` | Up |
| `POWER_BUTTON_GLYPH` | `U+E029` | `{POWER_BUTTON_GLYPH}` | Power |
| `THUMBS_UP_GLYPH` | `U+E030` | `{THUMBS_UP_GLYPH}` | Thumbs up |
| `THUMBS_DOWN_GLYPH` | `U+E031` | `{THUMBS_DOWN_GLYPH}` | Thumbs down |

The numbering is decimal-style: the A–F slots in each decade (`U+E00A`–`U+E00F`, `U+E01A`–`U+E01F`,
`U+E02A`–`U+E02F`) are unassigned. The font defines 32 private-use codepoints and the table lists
all of them.

`DOT_GLYPH` (`U+E006`) and `BLACK_CIRCLE` (`U+25CF`) are the same outline at two vertical
positions — `DOT_GLYPH` sits on the baseline to line up with the other icon glyphs, `BLACK_CIRCLE`
is raised to text centre for use inside a run of text. Both have full outline data; neither is
reserved.

## 2. Unicode characters RokuFont01 backs (safe under a custom font)

Real Unicode codepoints, but RokuUI-Regular does not contain them — they resolve through the same
RokuFont01 fallback as the private-use glyphs above. That makes them the *safe* shapes to use in
custom-font text.

| Constant | Codepoint | Char | Description |
|---|---|---|---|
| `BLACK_CIRCLE` | `U+25CF` | ● | Dot raised to text centre, for use inside a text run |
| `BLACK_STAR` | `U+2605` | ★ | Filled star |
| `WHITE_STAR` | `U+2606` | ☆ | Outlined star |

## 3. RokuUI-Regular symbols (no backstop under a custom font)

Part of the default UI font, so they need no fallback under a system font. Under a custom app font
there is no RokuFont01 backstop for them either. **These are the ten constants to audit if your
app ships its own typeface.**

| Constant | Codepoint | Char | Description |
|---|---|---|---|
| `BULLET` | `U+2022` | • | Bullet |
| `ELLIPSIS` | `U+2026` | … | Horizontal ellipsis |
| `EN_DASH` | `U+2013` | – | En dash |
| `EM_DASH` | `U+2014` | — | Em dash |
| `LEFT_ARROW` | `U+2190` | ← | Leftwards arrow |
| `UP_ARROW` | `U+2191` | ↑ | Upwards arrow |
| `RIGHT_ARROW` | `U+2192` | → | Rightwards arrow |
| `DOWN_ARROW` | `U+2193` | ↓ | Downwards arrow |
| `CHECK_MARK` | `U+2713` | ✓ | Check mark |
| `BALLOT_X` | `U+2717` | ✗ | Ballot X |

## What has no constant, on purpose

Characters you can type directly get none: `·` middle dot, `°` degree, currency signs, maths
operators, quotation marks. Type them. A constant would add a name to look up without adding
anything the compiler or the device cares about.

Geometric arrows `◀` and `▶` are in **neither** font and have no constants because they do not
render. Reach for `LEFT_ARROW` / `RIGHT_ARROW`, or the bordered `LEFT_BUTTON_GLYPH` /
`RIGHT_BUTTON_GLYPH` when you want the remote-button look.

## Firmware placeholders

The `{CONSTANT_NAME}` column above is the firmware's own placeholder syntax, used in translated
firmware strings and resolved by the firmware's string layer. It is not a TypeScript symbol and it
is not template syntax: putting `{BACK_BUTTON_GLYPH}` in a label renders those braces literally.
Use the placeholder form only where you are explicitly producing text for something that resolves
firmware placeholders, and interpolate the imported constant everywhere else.
