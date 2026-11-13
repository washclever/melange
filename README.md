# Melange

A schematic editor + SPICE simulator (transient · DC operating point · DC sweep · AC · noise · transfer function) that runs in the browser, with a calculator that turns the results into the numbers a designer asks for — gain, bandwidth, phase margin, gm/ID, noise, THD. No server — it works as plain static hosting.

This is an independent implementation with no connection to EasyEDA or LCSC. Trademarks belong to their owners.
The interaction model follows the public documentation of EasyEDA and KiCad; no code, icons or part data from them is used.

Below, "the design doc" means the **private design document** written when this project started. It is not in the repository — it records the reasoning behind the decisions, and this README is enough to read the implementation.

## Where it stands — M1-thin passed

The vertical slice from drawing a schematic to seeing a waveform is open. The RC low-pass demo runs end to end.

```
place parts → wire → extract nets → netlist → ngspice → waveform
```

**What is in** — **33 part types in a component library** (Passive · Analog · SKY130 · ground — see "The component library" below) and **11 demo circuits** · placement (automatic designators) · wiring (corner hysteresis) · net labels · GND ·
select/move/rotate/delete · value editing · net extraction · netlist · pre-run checks · simulation · waveforms ·
**command-pattern undo/redo** · **voltage probes** · `.sp` export/import · running an external `.sp` directly ·
**a calculator that post-processes the results** (97 functions, device values such as gm by part name, 94 textbook metrics — see "The calculator" below) ·
**an assistant on OpenRouter with your own key** that draws, wires, simulates and fixes circuits, and **simple and edit modes** (see "The assistant" below)

**M1b editing** — multi-select (click · Shift+click · box · Ctrl+A) · delete across kinds ·
multi-move (drag · arrow keys) · rotate · X/Y mirror · copy/cut/paste · manual junctions (Alt+J) ·
wires follow moved and rotated parts · no-connect marks (Q) · supply symbols (Shift+G) · editing several properties at once ·
part text placement · IndexedDB autosave (Ctrl+S) · **double-click value editing** ·
**rotate/mirror while placing** · **Shift for straight runs while wiring** · **net highlight (H)** ·
**waveform cursors A·B** · **six analyses (transient · DC op · DC sweep · AC · noise · transfer function)** · **automatic measurements (`.meas`)** · **semiconductors (D · Q · M) with .model** ·
**wire segment selection and corner dragging** · **right-click menu** · **component library window (Shift+F)** · **drag-and-drop placement** ·
**SPICE directive blocks (D)** · **external .sp into a schematic (E34)** ·
**find/replace (Ctrl+F)** · **align/distribute** · **renumber designators** · **text · line · rectangle (T · Alt+L · R)** · **PNG export** ·
**inserting a part onto a wire** · **duplicate designators marked red** · **parallel voltage source check** · **resizable panels**

**The first pass (M1–M4) is done.** All 48 first-pass items of the design doc's EasyEDA comparison table are **in**.
The remaining 79 are classified "later" (56) · "excluded" (18) · "not applicable" (5) —
multiple sheets · waveform zoom/pan · noise/distortion analysis · symbol editor · part search database · panel docking ·
and all of PCB. (Noise analysis has since come in, together with the calculator that integrates it.)

### The screen — glass surfaces and an icon toolbar

Colors and surfaces follow the design tokens of morglay.
Translucent glass cards float over a dark violet backdrop, and **blur is applied only to the floating layer** (menus · the finder · mobile drawers). Putting `backdrop-filter` on fixed panels costs something and changes nothing visible — what is behind them does not move.

**The toolbar is groups of icons.** The icons are hand-drawn 16×16 stroke icons (`src/ui/icons.ts`); no external icon set is pulled in — not using another EDA's icons is a premise of this project. **The run button sits where it cannot be pushed off.** Tool groups scroll sideways when they overflow, but the most-pressed button must never leave the screen.

### Layout — menu bar · toolbar · panels you can turn off

Nailing every command into the toolbar buries the ones you actually use. **Modes go in the toolbar, commands go in the menus** — a toolbar button answers "what am I drawing right now", and anything that happens once per press goes to a menu.

```
melange  File  Edit  Arrange  View  Simulation        ← 30 px menu bar
[tool groups]                      Saved · status  ▶Run  ← 40 px toolbar
```

| Menu | What is in it |
| --- | --- |
| File | New project · Open · **component library** · export `.sp` / `.json` / `.png` |
| Edit | Undo/redo · copy/cut/paste/delete · select all · find & replace · delete by kind · renumber designators |
| Arrange | Rotate · flip horizontal/vertical · 6 alignments · 2 distributions |
| View | Zoom to fit/selection · **simple mode** · **the assistant panel** (Shift+A) · **turn the parts, properties and bottom panels on and off** · light/dark · glass effect |
| Examples | **11 demo circuits** |
| Simulation | Run · result tabs (waveform · netlist · log · issues · measure · calculator) |

Menus print the shortcut next to each item. There has to be a path where you press it, see the key, and remember it. Items that cannot act right now ("zoom to selection" with nothing selected) are dimmed and do nothing. Checkable items apply **with the menu still open** — you can toggle all three panels in a row.

**All three panels can be turned off.** The middle is flex, not grid, so the space goes away with the panel. Panel sizes, theme and the glass effect are kept in `localStorage`.

### Light · dark

It follows the desktop setting, but picking one in the View menu wins. Both themes have the **same glassiness** and only flip the plate — dark is dark glass with a white highlight, light is white glass with light coming from above. Canvas colors are separate per theme too (wires #2563eb light, #4a8dff dark). Changing the theme redraws the whole canvas — the colors are read from CSS variables.

On a device that cannot blur, or with "reduce transparency" on, **the glass effect turns itself off** (`:root.solid`, the same way morglay does it). You can also turn it off by hand in the View menu.

### Two reasons the glass did not look like glass

**Menus** — however empty the plate got, they looked opaque. The blur carried `brightness(.58)`, which crushed whatever was behind it to 58% and made it dark. Put a glass film (a white gradient) on top of that and the result is just a black plate. **Dropping the darkening** let the plate go down to .46 — text reads because the blur smears what is behind it, not because the plate is heavy.

**Background lights** — in CSS backgrounds, **what you list first is on top**. The vignette was listed before the lights, so it painted black right over the lights at the corners. Moving the vignette below them and weakening it finally let the light show. The lights were also pulled in from the corners so they land inside the viewport.

Each surface is emptied by a different amount — **window frame .34 · menus .46 · canvas .56**. The canvas has to be the calmest one. It lets through just enough for the backdrop to tint it; any more and it gets in the way of reading the schematic.

### A trap in the theme rules

`:root:not(.dark)` is **true when no class is set at all.** In the common case of a dark desktop running dark with no class, the light-theme rules apply — the wordmark got a deep violet gradient and **disappeared entirely** against the dark bar. The tokens were written in two halves from the start (`:root.light` and `@media (prefers-color-scheme: light) { :root:not(.dark) }`), but two rules added later missed that second layer.

### Glass on the frame only

Putting `backdrop-filter` on a surface whose contents keep changing means **re-filtering what is behind it every time the inside changes.** That happens the whole time the mouse moves, so input feels like it lags. Measured: frames were **18.0 ms** while moving the pointer, and **6.1 ms** once the glass came off the canvas (zero long tasks — the cost was compositing, not the main thread).

So glass lives on the **frame** (toolbar · parts · properties · bottom panel · menus · dialogs), and the drawing surface is left as one faint plate. The menu bar at the very top is not a floating card but a bar **attached** to the window — square corners, edge to edge, one line underneath. Rounding and floating that too makes the whole window look flimsy.

### Glass — refraction, not blur

`backdrop-filter: blur()` on its own is **frosted glass**, not glass. Blur fogs pixels but does not **move** them, so you never get the edge refraction (lensing) that makes glass look like glass. Refraction only comes from SVG's `feDisplacementMap` — the R and G channels of a displacement map push backdrop pixels horizontally and vertically.

The map is **the surface normal taken from the signed distance field of a rounded rectangle** (`src/ui/glass.ts`). The middle is (128,128), so nothing happens there; toward the border the outward slope grows — the middle, where the schematic is, stays straight and only the edges bend. The map is rebuilt when the element resizes.

The traps found while researching this, all of them stepped in and fixed:

| Trap | Symptom | What we do |
| --- | --- | --- |
| Map alpha of 0 | Chromium decodes RGB premultiplied by alpha → **everything reads as 0 and the whole screen shifts** | Fill alpha with 255 and emit only the result through `feMerge` |
| Filter region equal to the element | Displaced pixels get clipped | Grow the region outward by twice the strength |
| Chromium's id cache | Changing the contents under the same id still shows the old filter | Build a **new id** on resize and update `--lens` |
| Percentage units on `feImage` | Refraction appears only on the right and bottom | `userSpaceOnUse` with pixel sizes as they are |
| Thin bars | A band over half the height turns the whole surface into a slope and bends the text | Clamp the band to ⅓ of the height |
| Safari · Firefox | They do not know `backdrop-filter: url()` | Fall back to blur and rim only (checked with `CSS.supports`) |

**Glass needs something behind it to look at.** Against a near-flat backdrop, refraction happens but there is no pattern to bend, so it looks like nothing happened. So the backdrop became four distinct gradient blobs with a very faint 22 px dot pattern over it — that pattern bending at the edges is the evidence of glass.

The rim specular is two inset shadows in opposite directions — light from the top left, dark from the bottom right. That is where the thickness comes from. It is applied to all six surfaces (menu bar · toolbar · parts · properties · canvas · bottom panel) and to the floating layer (menus · dialogs). **Glass is never stacked on glass** — doubling it hides what is behind and only costs more.

With six refracting surfaces up, it runs at **167 fps**.

### Help and key bindings

How-to and shortcuts are not scattered in a corner of the screen; they live in the **Help menu**.

- **How to use** — wiring, moving, the view and the cursors in one table.
- **Shortcuts** — the keys for 35 commands are **rebindable.** Click a row and press the new key. Esc cancels, Del restores the default. Only what you changed is kept in `localStorage`.
- **Calculator reference** — the expression syntax and every function, built from the same table the calculator runs on, so it cannot drift from what the functions do.
- **Melange on GitHub** — opens this repository in a new tab, so the circuit you are drawing stays put. The How-to sheet ends with the same link.
- **Licenses** — the third-party notices are read inside the app (they used to be a link to a `.md` file, which looked broken).

Key handling moved from an if-chain to a **table**. Before, you had to read the code to learn which key did what, and the user had no way to change it. With a table, the help dialog, the settings dialog and the actual handling all read the same data. Keys whose meaning depends on context (Space while placing, Backspace while wiring, Esc, the arrow keys) are intercepted before the table. Keys are physical (`KeyboardEvent.code`), so they work with a Korean IME active, and input that is mid-composition (`isComposing`) is let through.

### Mobile

| | |
| --- | --- |
| Viewport | `100dvh` and `env(safe-area-inset-*)` — the height stays right when the address bar collapses |
| Under 900 px | The side panels become **drawers**, opened by toolbar buttons and closed by tapping the canvas. The assistant's drawer runs from below the toolbar to the bottom of the screen, over the bottom panel — in the middle band alone a phone shows only a few lines of conversation |
| Under 520 px | The mode switch shows one button, the mode it switches to — the same idea as the theme button. The AI button in the menu bar gets tighter |
| Under 760 px | The waveform and the cursor table stack vertically. Side by side, the graph becomes a thread |
| Touch | Buttons grow to 34 px under `pointer: coarse` |
| Gestures | **Pinch to zoom, two-finger drag to pan.** The moment a second finger lands, whatever one-finger drag or wire was in progress is undone |
| Scrolling | `touch-action: none` on the canvas — dragging the schematic does not drag the page |

### The command pattern (E12)

The document changes only through commands. A command knows its change and its inverse, and undo applies the inverse. Nowhere in the app does code touch `sheet` directly.

**The previous value is read at `apply` time, not passed in by the caller.** The first version took `from` as an argument and the tests caught it — if the caller passes a stale value, undo quietly corrupts the document. You undo, you get the wrong value, and by then the cause is unfindable.

The size of one step is what the design doc specifies. One drag is one step: while dragging, the parts move directly for the screen, and at the end they are put back to the start position and applied once as a command. Undo restores the selection of that moment too.

### Selection and transforms (E08 · E09 · E10 · E13)

The selection holds not only parts but wires, labels and probes. Keys are `"kind:id"`, so they go straight into the undo record, and undoing brings the selection back with it.

Rotation and mirroring have to **move the coordinates and the drawing together.** If they drift apart, the screen looks fine while the connections quietly change. Pin coordinates come from `transform(local, rot, mirror) = R_rot(S_mirror(local))`, so a vertical mirror has to be

```
mirror' = !mirror,   rot' = (360 - rot) % 360
```

for the resulting x to flip. A horizontal mirror is that plus 180°. Tests cover all 8 built-in parts × 5 transforms: that every pin stays on the grid, and that the renderer's transform and the pin coordinates produce the same values. Per design doc 12-1, **a selection with wires in it still rotates** (Pro cannot).

Dragging moves things directly for the screen while in progress, then puts them back to the start and applies one command at the end — one drag is one undo step.

### Deliberate differences from EasyEDA (spec 12)

These are the items the design doc lists as "this is where we beat EasyEDA". They answer forum complaints (FR1 · FR2), so dropping them leaves nothing distinctive.

| | How |
| --- | --- |
| **Unfinished spots are marked** | ○ on an unattached pin, □ on a wire end that goes nowhere. They disappear once connected — and a net label on the end counts as connected (it joins its net by name), so short stubs ending in `clk` or `vdd` are not flagged |
| **Preview of the connection you are about to make** | While dragging, a green mark where it would attach if you dropped now. So you do not find out after dropping |
| **Junctions clean themselves up** | When a crossing goes away it is removed in the same step. Undo brings it back with it |
| **Key hints in the status bar** | The keys available in the current tool are always shown under the canvas |
| Rotating a selection with wires in it | Pro cannot |
| No way to turn grid snap off | Pins are always on the grid, so connection tests are integer comparisons |
| Net names ignore case | SPICE does not distinguish them |

Pins that touch are connected even without a wire (rule 6), so they do not count as floating. Miss this and a perfectly good circuit fills up with ○.

### How ngspice messages are sorted

Despite the name, `getError()` also returns **non-fatal notices.** Leave the DC value off a voltage source and the result comes out fine, but this line comes with it:

```
Note: v1: has no value, DC 0 assumed
```

Treat that as failure and a simulation that ran fine reports as failed. So two things are looked at together (`src/sim-log.ts`):

| Message | Result | Verdict |
| --- | --- | --- |
| Only `Note:` / `Warning:` | present | **success** — the notice goes to the log tab |
| Only `Note:` / `Warning:` | absent | failure — this is how a floating node arrives |
| Anything else | either way | failure |

Look only at the kind and you miss "only warnings but the result is empty"; look only at the result and you miss parse errors. When ngspice recovers with gmin stepping and produces a result, the warning goes to the log and it counts as success — it actually solved. The pre-run check (E26) warns about floating pins beforehand, so the user knows.

### Finishing the first pass — the last eight

| Interaction | Design doc | Where |
| --- | --- | --- |
| **Inserting a part onto a wire** | connection rule 4 | automatic when dropped on a wire |
| Backspace to undo a corner while wiring | §4 | wire tool |
| Starting a wire from a floating pin | §4 | click a pin end with the select tool |
| Delete by kind · clear everything | E11 · §8 | right-click menu |
| Label numbers auto-increment | E06 · §6 | net label tool |
| **Duplicate designators marked red** | E18 | schematic |
| **Direct-parallel voltage source check** | E26 | pre-run check |
| Resizable panels · new project (Shift+N) · project name | comparison table 17 · 102 · 105 | drag a splitter · right panel |

**Dropping a part on a wire splits the wire and slots the part in.** Without the split, the part sits there with **both of its ends on one node** — the picture looks right, but in the netlist the part is shorted. That is the kind that fails quietly, so it splits at drop time, and the split and the placement are one step so `Ctrl+Z` undoes both. It splits only when **two or more** pins land on the same wire — a single pin is a T-junction and should just connect.

**Only floating pins start a wire.** Allow it on already-connected pins and reaching for a part starts a wire instead. There is no separate distance test — snapping already used a radius to put you there, and measuring again gives you "it snapped to the pin but will not start".

**Duplicate designators show up red on the schematic.** They also appear as errors in the issue list, but you fix them only if you can find them by eye.

**Direct-parallel voltage sources are blocked before the run.** Two voltage sources across the same two nodes make the matrix singular and ngspice cannot solve it, and its error message names only a node, which makes the cause hard to find. It is blocked even when the values match (matching values still cannot be solved), and sources stacked in series are left alone. A voltage source with both ends on one net (shorting itself) is caught in the same place.

Panel sizes change by dragging a splitter, which moves a CSS variable, and are kept in `localStorage` — making you set them again on every visit would be worse than not having them.

### The rest of M4 — find, align, renumber, shapes, PNG

| ID | Feature | Where |
| --- | --- | --- |
| E29 | Find & replace | `Ctrl+F` |
| E30 | Align · distribute | right-click menu · distribute on `Ctrl+Shift+H`/`E` |
| E31 | Renumber designators | right-click menu |
| E32 | Text · line · rectangle | `T` · `Alt+L` · `R` |
| E35 | PNG export | toolbar · right-click menu |

**Align and distribute work on part origins.** Symbols differ in size, so aligning by bounding box puts the origin off the grid, and then **the pins leave the grid and connections break quietly** — this is exactly where the design doc says "after align/distribute the pins are still on the grid and connections hold" (12-5). For the same reason distribute keeps the grid before it keeps an even spacing: spread three over 0–90 and the middle one is at **50**, not 45.

**Connections survive the move.** Attached wires follow the same way they do on a drag: the stretch between each moved pin and the nearest fixed point is routed again (see "Wires that follow a moved part"). One align is one undo step — move six parts and fix seven wires, and a single `Ctrl+Z` brings all of it back.

**Renumbering counts per prefix** (R1 R2 … C1 C2 …). The default order is reading order — top to bottom, left first within a row. The coordinate math lives in `src/doc/arrange.ts` with 24 checks around it.

**Replace swaps only the matched text.** Overwriting the whole field means going for "1k to 2k" and losing the rest of the value. It searches designators, parameters and net labels at once, and clicking a result moves the view there (at the same zoom — the view jumping in and out on every hit is disorienting).

**PNG is drawn with the same function that draws the screen.** Draw it separately and the two drift, so something ends up missing from the exported image only. You can choose everything (at 3× size) or the visible area, and a transparent background.

**Notes (E32) do not go into the netlist.** Their shape is defined by points alone, so rotation and mirroring go through the same path as wires. In hit testing they come last — a large rectangle must not steal clicks from the parts and wires inside it, and rectangles only catch near their border.

### SPICE directive blocks (E33)

A place to hold, **verbatim**, the lines that are not drawn on the schematic. Press `D` to drop one and edit it in the right panel.

```spice
.model DFAST D(IS=2e-14 N=1.05 RS=0.4)
.param vcc=5
```

There is a separate switch for on and off. Switched off, a block is not deleted: each line goes out with a leading `*` as a comment — so that "run it without this line" never means deleting and retyping it. Its place in the netlist is after the device lines and `.model`, before the analysis line (export rule 7).

**The ground check cannot look at the schematic alone.** The netlist is the schematic plus the directive blocks, so after importing an external `.sp` the ground may exist only in a preserved line. Blocking a good circuit with "there is no GND" because the schematic has none is wrong — a device line in a block that uses node `0` counts as ground.

### External `.sp` → schematic (E34)

Open a `.sp` made by another tool and it asks whether to **turn it into a schematic or run the netlist as is**. Converting auto-places in the order the file lists, pulls a short stub off each pin, and connects **by net labels only**. Nothing is wired wire-to-wire, so no lines overlap, and the node names stay exactly as written so they line up with the preserved lines. Node `0` becomes a GND symbol.

| `.sp` line | On the schematic |
| --- | --- |
| R · C · L | The same part, value as is (`10uF` → `10u`) |
| V made of exactly one of DC · SIN · PULSE | That source, with its parameters filled in |
| D · Q · M and their `.model` | Semiconductor parts. **The model line goes verbatim** into the project library |
| Other devices (PWL sources · B · E · I …) and directives like `.param` · `.include` | Preserved in a SPICE directive block |
| `.tran` · `.op` · `.dc` · `.ac` | Become the analysis settings |

**Model coefficients are not rewritten into our shape.** The built-in diode exposes only `IS` and `N` as properties, while an imported model may also carry `RS`, `CJO` and more. Rewriting it into our shape makes those vanish quietly and it becomes **a different device**. So imported parts carry the `.model` line as text, and expose only the model name (and W·L for MOSFETs) as properties.

**A deliberate difference from the design doc — placement spacing.** The doc says 800 mil horizontally and 600 mil vertically, but with a 200 mil stub on each pin a two-pin part is exactly 800 mil wide, so **its stub end lands on the same point as the next part's.** Same coordinates means connected, and two different nets get joined. The vertical case is the same, so it was opened up to 1200 × 1000 mil.

**A MOSFET whose bulk differs from its source is not converted.** Our symbol has three pins, D·G·S, so a line like `M1 d g s 0 ...` with a separate bulk cannot be drawn — forcing it would produce a different circuit, so the line is preserved as is and the reason goes to the log.

#### Verification — run both the original and the conversion

The completion criterion is "import three external `.sp` files, export them again, and get the same result as the original (amplitudes within 0.1%)", so it does not just compare structure: **both netlists go through ngspice and the numbers are matched.**

| File | Parts converted | Lines preserved | v(out) peak difference | Trough difference |
| --- | --- | --- | --- | --- |
| RC low-pass | 3 | 0 | 0.0000% | 0.0000% |
| Half-wave rectifier (`.model` with RS · CJO) | 3 | 0 | 0.0000% | 0.0000% |
| PWL source · current source · `.param` mixed | 2 | 3 | 0.0000% | 0.0000% |

A changed node name or a dropped preserved line is caught right here. The rectifier file is where carrying the `.model` verbatim is measured — drop `RS=0.4` and the peak visibly changes.

### Filling in the missing interactions — found with the comparison table

The 127 items of the EasyEDA comparison table in the design doc's appendix were checked against the code, and of the 48 first-pass ones, the eight you notice by hand were filled in.

| Interaction | Where | Design doc |
| --- | --- | --- |
| Shift+wheel pans sideways | canvas | §1 |
| Zoom to selection (Shift+K · right-click menu) | canvas | §1 |
| **Selecting one wire segment** (click again, Tab widens) | canvas | §2 |
| **Right-click menu** (select segment/wire/net, highlight net, zoom, rotate, delete) | canvas | §2 |
| Part finder (Shift+F) | library | §3 · E01 |
| Drag from the library onto the canvas | library | §3 · E01 |
| **Dragging corners and segments** | canvas | §4 |
| Project `.json` export | toolbar | §10 · E19 |

**A single segment is not a kind of selection but a "narrowed spot".** The selection itself is still the one `wire:id`; only the narrowed segment index is kept beside it. Adding a reference kind would have meant commands, undo, copy and box-select all having to know about segments. The narrowing disappears when that wire leaves the selection or is deleted, and there are many paths that change the selection (tool switch · undo · select all · open), so instead of sprinkling cleanup everywhere it is **checked once, right before drawing.**

Deleting a segment splits the wire in two. Remove the middle and you get two pieces; remove an end and you get one. A piece with a single point is thrown away — leaving it behind leaves a zero-length wire that net extraction reports as an "unfinished wire end" (`splitWire`, 8 checks).

**The right button is "drag to pan, press without dragging for the menu".** Whether it was dragged is known at `pointerup`, so the menu opens from the pointer handling, not from the `contextmenu` event.

Corner dragging holds the shape from the start of the drag and **rebuilds from it every frame.** Accumulating a step at a time lets grid rounding pile up and the corner drifts. Wires that follow a moved part work the same way.

### SKY130 — a real process, not a textbook model

The generic MOSFET above is a level-1 textbook equation: the shape of the transfer curve is
right and nothing else is. The SKY130 parts are SkyWater's own BSIM4 cards for their 130 nm
process, which the simulation engine happens to bundle. They are subcircuits, not primitives,
so the line starts with `X` and carries four nodes; our symbol has three pins, so the bulk is
tied to the source the same way the generic MOSFET does it.

**The bundled deck does not run on its own.** Its model expressions are written as
`nominal + sky130_fd_pr__nfet_01v8__vth0_diff_12`, where the offsets live in SkyWater's corner
files — which the engine does not carry. Hand it to ngspice as it is and you get about 2,400
`Undefined parameter` lines, then `Cannot compute substitute`, and then it never returns. Not an
error: a hang. `tools/extract-sky130.mjs` reconstructs the typical corner, which is what the
names already say it is — every offset zero, and `mc_switch = 0` to switch off the
Monte-Carlo term. So **this build is the typical corner only, with no device mismatch.** Sweeping
process corners needs the real PDK.

**W and L are in metres and cannot be arbitrary.** BSIM cards are split into bins by dimension,
and a size that falls in no bin makes ngspice die on the device line with a message that does not
name the model. The pre-run check catches it first and lists the sizes that do exist
(`tools/extract-sky130.mjs` writes the bin table out beside the models). The defaults, 1.26 µm
and 0.15 µm, sit in the middle of bin 0 for both devices.

Measured against the process, not against a formula we could have written:

| | |
| --- | --- |
| nFET, W/L = 1.26/0.15 µm, VGS = VDS = 1.8 V | 622 µA, i.e. **494 µA/µm** |
| Same device at VGS = 0 | 1.9 pA — **3.4e8 times** lower |
| Gate current | exactly 0 |
| pFET at the same size | 2.59× weaker than the nFET |

The model cards are not in the JS bundle, and they are not one file either. **They are split
per device**, because the first run used to take five seconds: ngspice was reading all 2.29 MB,
and 1.23 MB of that is the HVT pFET's 198 bins, which an nFET circuit has no use for. A netlist
now includes only what it uses — 0.62 MB for an nFET, 1.05 MB for the inverter, and the HVT file
only if an HVT device is on the sheet.

| | first run |
| --- | --- |
| one file, 2.29 MB | 5.1 s |
| split, 1.05 MB for the inverter | 0.85 s |

The worker fetches each file the first time a netlist asks for it, so a circuit of resistors
downloads none of them, and `tools/check-bundle.mjs` fails the build if the models leak back
into the JS or if the devices get mixed back into one file.

### Analog layout — Placement and Layout editors (SKY130)

The schematic can be laid out in SKY130 in the browser. At the right end of the menu bar, left of the
theme button, is **`Circuit ▾ Placement ▾ Layout`**:

```
schematic → layout netlist → primitives (ALIGN, in JS) → placement → routing (ALIGN router, wasm) → DRC/LVS → GDS
```

- **A name** shows that editor alone. **The triangle between two names** opens: the two side by side · one above
  the other · all three · open one in a new window · bring the windows back · link selection with the schematic.
  Drag the bar between them to resize; the editor clicked last takes the keyboard (outlined).
- **New windows** (`layout.html?ws=placement|layout`) use the main window's state — the same placement, tracks and
  undo history, the workers stay in the main window. Closing the main window closes them.
- **Selection is linked.** Selecting transistors on the schematic selects the blocks that contain them; selecting a
  block in Placement or Layout selects its transistors; selecting a net in Layout highlights it on the schematic.

**What goes into the layout** (`src/layout/bridge.ts`): the transistors of the current sheet — SKY130 nFET · pFET ·
pFET HVT, and the generic NMOS/PMOS drawn as SKY130 devices. Sources, R, C and the rest stay out; a net they touch becomes a pin of the
block, as does a net with a label or a supply symbol. Ground is named `VSS`. Bodies go to the rails (nFET to ground,
pFET to the supply) — the simulation ties them to the source because the symbols have no bulk pin. The cells are
built on a 210 nm fin pitch with an even number of fingers, so W per finger is rounded to 2–12 fins, and L is
always 150 nm. Every such change is listed as a note under **From the schematic** in Placement, with the pins and
the block count. Auto place reads the schematic again when it has changed (Read again does it at once); if the
layout netlist comes out the same — a moved label, a new analysis — the placement and the tracks stay.

**The front end is ALIGN rewritten in JavaScript** (`src/layout/front/`) — the compiler (SPICE parser, constraint
schema, series/parallel merging, VF2 primitive matching, symmetry and array detection) and the SKY130 cell generator
of ALIGN-pdk-sky130. No Python and no Pyodide are shipped. The same input gives **byte-identical output** to ALIGN run
with `PYTHONHASHSEED=0`: ALIGN's results depend on Python's set iteration order and string hashes, so
`src/layout/front/py.mjs` reproduces CPython 3.13's set table and SipHash. `tools/verify-front.ts` checks 18 circuits
against outputs produced by the Python ALIGN; `tools/e2e-layout.ts` runs the SKY130 demos from schematic to GDS.

**Placement** — blocks the front end grouped (current mirror, differential pair, single transistor …, with their
parts, variants and symmetry) and their placement: Auto place, then drag blocks (symmetry constraints follow), flip,
change variant, lock, swap, settle (remove overlaps keeping the arrangement), re-optimize keeping the topology,
undo/redo. The **ratsnest** (every net's connections between block pins) is on while you place, as on a PCB; the
selected block's nets stand out.
**Layout** — you draw the tracks, as on a PCB in EasyEDA. Right after placement the cells are there with their pins and
the **ratsnest** (thin lines between what is still to connect); nothing is routed. Press **W**, press on a pin, and the
track follows the cursor as an L; click to fix each bend, and it ends by itself on a pin, track or via of the same
net. **Auto route** is a button you may never press: **Route everything**, or **Route the unfinished nets** — the nets
you finished stay exactly as they are and the router (ALIGN's, in wasm) avoids them. Its tracks are ordinary tracks:
select them, delete them, draw around them. Undo takes back a track, a deletion or a whole auto route. When the
router finds no path between the cells — its global router fails with *Empty path* on some tight placements, and
the placement differs a little between WebGPU and CPU and with the placer's settings — it tries again with 4, 8
and then 16 tracks of room around the cells, and the status line says how much it added. The tracks then run a
little outside the placement's outline; the view includes them.

Where IC layout differs from a PCB, the editor shows it. **Each metal runs one way** (li1 ↕, met1 ↔, met2 ↕, met3 ↔,
met4 ↕ — on the layer buttons, keys 1–5), because the checker reads every shape along its layer's direction. So an L
cannot stay on one layer: the leg along the drawing layer goes on it, the leg that turns goes on the neighbouring
layer (met2 turns on met3, met1 on met2, met3 and met4 come back down), and the corner gets a via — the same thing as
a PCB track changing layer. The pair is next to the cursor while you draw (`met2 ↕ · met3 ↔`). **Space** flips which
leg comes first, **1–5** put a via stack where you are and continue on that layer, **V** goes to the other layer of
the pair. Every point sits where two layers' tracks cross, so a via always fits; a track that starts on a pin of
another layer starts with the via onto it.

The rules are checked while you draw: a leg that would touch another net is red and is not drawn (a short), a leg
too close to another net's end or a via too close to another via is orange (drawn, and the checker flags it). After
each change the editor recounts the nets — the Nets list says which are open — and runs ALIGN's checker on the cells
plus your tracks; the Errors list takes you to each one. A net you have not connected yet is not an error: the
checker reports it as OPEN, but the Errors list puts those under **Not connected yet** and the status bar counts
them as *Open*, not as DRC/LVS. When something cannot be done — a click that is not on a pin, a track that would
short — the reason shows next to the cursor for a moment, as well as in the status bar.

Clicks and drags work either way: click at the start and at each bend, or press on a pin, drag and let go. In the
Track tool a click on a drawn track starts a new track from it, and a drag moves it, as with the select tool.
Pins and tracks are picked within 7 px of the pointer (16 px with a finger), the nearest first. Click a track to select it (Shift adds, drag a box, double-
click selects the whole connected track), **Delete** removes it.

**Editing tracks, as in EasyEDA** (`src/layout/art/edit.mjs`). With the select tool, **drag a track** and its straight
line — every piece on that track, as the router splits a line at each via — moves to another track of its layer,
across its direction only (a horizontal layer moves up and down, a vertical one left and right). The tracks it meets
**stretch or shrink to stay attached**, and the vias at the crossings move with it. **Drag a via** and the two lines
that cross there move together, so the corner goes where you drop it; **drag a free end** to lengthen or shorten a
track; the **arrow keys** move the selection one track; **Move to** in Properties (or the right-click menu) puts a
line on another layer that runs the same way (met1 ↔ met3, li1 ↔ met2 ↔ met4). The preview follows the mouse and is
judged like a track being drawn: red is a short and is not applied when you let go, orange is a spacing warning. One
undo takes the whole edit back.

Vias are where this differs most from a PCB. A PCB via goes through the board and can sit anywhere; here a via joins
two **neighbouring** layers only, and only where their tracks cross, so it moves along with a line to the new
crossing. When a line is held where it cannot follow — a cell pin, a via stack going down to a pin, a line that passes
straight through, or more wiring hanging off the part a neighbour would give up — the old point stays and a short jog
on the neighbouring layer with a via at each end keeps it connected, the way a PCB track dragged off a pad keeps its
end on the pad. Changing a line's layer rebuilds every via stack where it meets other layers, one layer at a time,
jogging to the nearest track where a layer's grid does not pass the point. The router's own layout has duplicate vias
and lines whose pieces only meet through a via's metal; both are handled as one.

The keys follow the schematic beside them and EasyEDA's: **W** track · **V** via · **S** / **Esc** select · **Del**
delete · **Backspace** removes the last bend while drawing · **Enter** / **Esc** / double-click / right-click end the
track · **← → ↑ ↓** move the selection one track · **Esc** while dragging puts it back · **X / Y** flip (Placement) ·
**Ctrl+Z / Ctrl+Y** · **K** fit · **H** highlights the net under the cursor, here and on the schematic. Right-drag pans, the wheel zooms. **Download** (both toolbars): the placement as JSON, the GDS
of the cells and your tracks (opens in KLayout), and the DRC/LVS report. Hand-edited results are named `-edited`
(placement) and `-wires` (tracks).

The drawing code is `src/layout/art/`: the cells placed without the router (`base.mjs`), the tracks and vias with
undo (`doc.mjs`), the SKY130 rules — tracks, via enclosures, minimum length (`rules.mjs`), the L planner and the live
rule checks (`draw.mjs`), editing — moving lines, corners, ends and layers (`edit.mjs`), connectivity and the ratsnest
(`connect.mjs`), the checker and GDS on cells plus tracks (`check.mjs`), and the router's result as tracks, or finished
tracks handed to the router as fixed nets (`import.mjs`). `tools/e2e-art.ts` draws examples by hand with the planner
and checks them, then moves lines, corners and layers on the auto-routed result: every edit that is not a short leaves
every net connected, the ones with no warning check clean, and one undo restores the layout exactly. The browser tests
(`npm run e2e:browser`) draw the SKY130 5T OTA from scratch with the mouse to 0 DRC/LVS errors, and drag its routed
tracks and vias around (`layout-edit`).

Checks are ALIGN's own DRC/LVS rules for this PDK abstraction, not a foundry sign-off deck: the ALIGN-pdk-sky130
cells draw no `npc` (95/20), which SKY130 needs around poly contacts, mark HVT with the placeholder layer 970/0 of
its `layers.json`, and add ALIGN's outline layers (100/5, 104/0). Not there yet: capacitor and resistor cells,
guard rings, user `GroupBlocks`.

#### Examples — ALIGN's circuits in SKY130

**Examples → Layout — ALIGN examples (SKY130)** opens 18 circuits from ALIGN-public's `examples/` — OTAs, comparators,
a sense amplifier, a VCO, an equalizer, a VGA, buffer banks, a power train — as SKY130 schematics **with a test bench**,
and Placement opens beside them. Press Run and the Calculator shows the circuit's figures, as in the other examples;
press Auto place and Auto route for the layout.

- **Reading.** `src/layout/examples/align.ts` reads ALIGN's netlist dialect (`\` and `+` continuations, `//` comments)
  and flattens the hierarchy. An instance's parameters override the subcircuit's `.param` defaults, an instance's `m`
  multiplies everything inside it, and `R a b resistor r=rl` takes its value from `rl`.
- **Sizes that simulate.** The SKY130 models exist only at set widths for L = 150 nm, and the engine picks the model by
  the total W, not W/nf (W = 2.52 µm with nf = 2 has no model). The widths that are both a model and a whole number of
  210 nm fins are 0.84, 1.26 and 1.68 µm (2, 3, 4 fins × 2 fingers) and 5 µm (12 fins × 2 fingers, drawn 5.04 µm).
  Each device keeps ALIGN's total width (fins × fingers × multiplier) as a count of one of these units. Devices with
  the same fin count get the same unit, because ALIGN draws a mirror or a pair only when their fins agree. Three examples
  pick the unit or change a netlist parameter so that the layout finishes; `src/layout/examples/index.ts` says which and why.
- **Test benches** (`src/layout/examples/benches.ts`): the supply, the bias (a current into diode-connected pins, a
  voltage on pins that only reach gates), inputs, loads, the analysis, probes and calculator rows fitted to each
  circuit, as in the demos — the figures by name, a by-hand check next to them from the device values (gm1 over the
  output conductances against the simulated gain, gm1/CL against fu, the VGA's (gm0 + gm1)·(RL ‖ ro), the equalizer's
  degeneration zero), the saturation margin of cascodes and tails, energy per decision, stage delays — and the roles
  the Metrics picker fills from. They touch only the
  subcircuit's pins, so the layout is the same with or without them. Single-ended OTAs are measured open-loop with a
  DC-only feedback (1 GΩ to the inverting input, 1 F from there to ground). The fully differential telescopic OTA gets an
  ideal common-mode feedback, a behavioral source on its pFET current-source gate. At L = 150 nm one device's gm·ro is
  about 10, so a single stage gives about 20 dB.
- **Drawing.** The schematic is drawn like a textbook: series stacks are columns between the rails, pFETs above nFETs,
  gates on the left, wired with the assistant's `connect` (`src/doc/wiring.ts`), which never shorts anything. The sheet
  keeps the subcircuit's own pins (`layoutPins`), so a net the drawing joins with a label stays internal; R and C stay on
  the schematic and their nets become pins.

The tests place with the app's own defaults (`src/layout/place/defaults.mjs`, the same batch and starts as Auto
place): with other settings a placement can route in the test and not in the app, which is how the Current-mirror
OTA's *Empty path* went unnoticed.

`tools/e2e-layout-examples.ts` (part of `npm run e2e`; `npm run e2e:sims` for the simulations alone) builds each
example and runs its test bench — every row must give a value inside its window and each by-hand row must agree with
the simulation — fills every Metrics entry that fits the analysis from the example's roles and checks that none names a
net or device that is not there, then runs bridge → front end → placement → routing → checks. All 18 give their
figures and lay out with **0 DRC/LVS errors**:

| Example | Test bench | Figures | Transistors | Size (µm) | DRC/LVS |
| --- | --- | --- | --: | --: | --: |
| Five-transistor OTA | AC | 18.8 dB, fu 95 MHz, PM 95° | 5 | 20.6 × 21.0 | 0 |
| Five-transistor OTA, high frequency | AC | 20.9 dB, fu 1.15 GHz, PM 68° | 6 | 18.9 × 28.6 | 0 |
| Common-source amplifier | DC sweep | gain −1.53 at 1 V (by hand −1.53) | 2 | 5.2 × 15.1 | 0 |
| Telescopic OTA | AC, ideal CMFB | 37.0 dB, fu 99 MHz, PM 89° | 10 | 8.6 × 43.7 | 0 |
| Telescopic OTA with bias | AC | 46.7 dB, fu 92 MHz, PM 82° | 36 | 43.0 × 32.8 | 0 |
| Current-mirror OTA | AC | 24.2 dB, fu 28 MHz, PM 80° | 12 | 48.2 × 31.1 | 0 |
| Cascode current-mirror OTA | AC | 39.1 dB, fu 31 MHz, PM 89° | 20 | 33.5 × 43.7 | 0 |
| High-speed comparator | transient | ±10 mV decided in 211 ps, 475 fJ | 15 | 34.8 × 79.0 | 0 |
| Double-tail sense amplifier | transient | ±10 mV decided in 244 ps, 307 fJ | 14 | 18.9 × 43.7 | 0 |
| Comparator with ready logic | transient | ±10 mV decided, ready after 318 ps | 22 | 14.6 × 58.8 | 0 |
| Current-starved inverter | transient | pull-up 34 ps, starved 164 ps | 7 | 25.8 × 15.1 | 0 |
| Ring oscillator | transient | 4.55 GHz, 22 ps a stage | 10 | 18.1 × 15.1 | 0 |
| VCO stages | transient | 8 stages 754 ps | 32 | 24.1 × 26.9 | 0 |
| Linear equalizer | AC | DC −0.7 dB, peaking 4.3 dB | 12 | 36.1 × 7.6 | 0 |
| Variable-gain amplifier | AC | 3.6 dB with 2 of 4 slices on, 6.6 GHz | 17 | 29.2 × 15.1 | 0 |
| Single-to-differential converter | AC | −7.2 dB on both outputs, 180° apart | 2 | 5.2 × 7.6 | 0 |
| Unity-gain buffers | DC sweep | error −17 mV and 14 mV, slope 0.90 | 50 | 29.2 × 67.2 | 0 |
| Power train, binary weighted | transient | 118 Ω with one cell, 1.7 Ω with 63 | 63 | 61.9 × 32.8 | 0 |

Of ALIGN's 30 example netlists, 24 routed clean on the first try; the other six are left out or fixed:
two comparators had one **same-net gap** each — ALIGN's router stops a VCC wire 75 nm short of the next VCC shape
on the same met2 track, below the end-to-end rule — and Melange now fills such gaps (`healSameNetGaps` in
`src/layout/route/check.mjs`, the one place the routing deviates from ALIGN). The variable-gain amplifier and the
single-to-differential converter route clean once their supplies come from the schematic. Left out with errors:
`buffer` (two different-net spacing errors where a sub-module's wire ends next to a top-level rail) and a hierarchical
VCO with 144 transistors (also 17 minutes to place). Left out although they route clean: variants of circuits in the
list (the charge-flow comparator, a telescopic OTA with extra connections, a VGA stage, a thermometer-coded power train
that takes 2 minutes to place) and trivial or test-only ones (single inverters, a one-device power train, a
four-device adder, `block_spacing_bug`).

| Where | What |
| --- | --- |
| `src/layout/bridge.ts` | schematic → layout netlist (sizes, pins, rails, notes) |
| `src/layout/front/` | ALIGN front end in JS — `compiler/`, `cell/`, `sky130/`, `py.mjs`, `sha256.mjs` |
| `src/layout/place/` | placer (continuous optimization + LP legalization, symmetry, variants) |
| `src/layout/route/` | routing pipeline, ALIGN router (`alignroute.wasm`), DRC/LVS checker, GDS writer |
| `src/layout/edit/` | placement edit math; the router's PnRDB wire model (`wires.mjs`) |
| `src/layout/art/` | the Layout editor's drawing model — cells without the router, tracks and vias, SKY130 rules, the L planner, editing (moving lines, corners, ends, layers), connectivity and ratsnest, checks and GDS, auto route import |
| `tools/browser/` | browser tests (`npm run e2e:browser`, Playwright) — drawing from scratch, optional auto route, editing tracks and vias, how the tools take clicks and drags, the editor switch, placement edits, the assistant |
| `src/layout/pdk/` | the SKY130 abstraction (`layers.json` of ALIGN-pdk-sky130) |
| `src/layout/ui/` | `switch.ts` (menu bar, first paint), `shell.mjs`, `placement/`, `layout/`, services |
| `src/layout/workers/` | front end · placement · routing workers |
| `src/layout/examples/` | ALIGN example netlists, their reader and flattener (`align.ts`, with the SKY130 sizes), the schematic builder (`build.ts`) and the test benches (`benches.ts`); `src/lib/layout-examples.ts` lists them for the menu |

Only the switch is in the first-paint bundle; the rest is one `layout-*` chunk fetched the first time Placement or
Layout opens (`tools/check-bundle.mjs` keeps it that way), and the router wasm comes when routing starts.

### The component library — Passive and Analog

**Shift+F** (or **Library** above the parts list, or File → Component library…) opens a window in three panes:

```
┌ Libraries ─────────┬ Parts ─────────────────────────┬ Selected part ─────────────┐
│ All parts       33 │ Name        Value   Ref SPICE  │ Symbol on the snap grid    │
│ Passive          7 │ PASSIVE › RESISTORS            │ Description                │
│   Resistors      2 │ Resistor    1k Ω    R   R      │ Properties  (defaults)     │
│   …                │ Potentiometer 10k Ω RV  R      │ Pins        (what each is) │
│ Analog          22 │ …                              │ SPICE       (the lines)    │
│ SKY130 · Symbols   │                                │                     [Place]│
└────────────────────┴────────────────────────────────┴────────────────────────────┘
```

Type to search (name, keyword, SPICE letter — `cur so` finds the current sources), ↑ ↓ to move, **Enter or double-click to place**, Esc to close. A row can also be dragged onto the canvas; the window stays open for the next one. The search box has the focus when it opens, so the old finder's "three letters and Enter" still works. Keys typed while the window is open never reach the editor behind it — pressing R on a library button types an r into the search instead of switching to the rectangle tool. Under 760 px the panes stack and the libraries become a row of chips.

**The preview is drawn by the same functions as the real thing.** The symbol comes from the schematic's `drawPart`, on the same grid; the SPICE lines come from the netlist's `deviceLines` and `modelLine`, with each node shown as `<pin name>`. A preview drawn separately would sooner or later disagree with what lands on the sheet.

**Copyright.** Big EDA tools (EasyEDA among them) have a library browser of this shape; the arrangement is a common one. The layout, wording, icons, symbols and part data here are our own: symbols are IEC/IEEE conventions written as coordinates in `src/lib/parts.ts`, descriptions were written for this project, and no EasyEDA code, graphics, symbols, part data or text are used.

The left list and the window read one table of contents (`src/lib/catalog.ts`). It lives apart from the part definitions on purpose: definitions are copied into every project file that uses them, and descriptions and search keywords belong to the screen, not the document.

#### What is in it

Every part is **ideal** — SPICE primitives and textbook models, no vendor models:

| Library › group | Parts | Netlisted as |
| --- | --- | --- |
| Passive › Resistors | Resistor · **Potentiometer** | `R` · two `R` whose split follows the wiper (`{max(10k*0.3,1m)}`) |
| Passive › Capacitors | Capacitor · **Polarized capacitor** | `C` (the polarity is in the drawing only) |
| Passive › Inductors & transformers | Inductor · **Transformer** | `L` · two `L` and a `K` (turns ratio √(Ls/Lp), coupling k) |
| Passive › Transmission lines | **Lossless line** | `T` with Z0 and TD |
| Analog › Voltage sources | DC · sine · pulse · **PWL** | `V` |
| Analog › Current sources | **DC · sine · pulse** | `I` |
| Analog › Controlled sources | **VCVS · VCCS · CCVS · CCCS** | `E` · `G` · `V`+`H` · `V`+`F` (a 0 V source senses the current) |
| Analog › Amplifiers | Ideal op-amp · **Comparator** | `E` · `B` (tanh between the two levels) |
| Analog › Switches | **Voltage-controlled switch** | `S` with a `.model` of its own per part |
| Analog › Behavioral | **Multiplier** · **Behavioral source** | `B` (`k·V(X)·V(Y)`, or any expression) |
| Analog › Diodes & transistors | Diode · **Zener** · NPN · PNP · NMOS · PMOS | `D` (zener adds `BV`, `IBV`) · `Q` · `M` |
| SKY130 · Symbols | the three process transistors · ground | unchanged |

**One part, several lines.** A template with a newline is filled line by line, so a potentiometer, a transformer or a current-controlled source is still one part on the sheet. Templates without a newline — every part that existed before — produce the same line as before, character for character; the e2e netlists are byte-identical to the previous build. New element letters slot into the existing order (sources → passives → controlled sources → semiconductors) without moving the old ones.

**Three choices that show in the drawing.**

- **Current sources draw the arrow up, and the current leaves through the arrow-head pin.** SPICE's `I n+ n-` pushes current out of `n-`, so `n+` is the bottom pin. Ground the bottom and the load at the top gets a positive voltage — the drawing and the netlist say the same thing, and the test checks the sign, not just the size. A DC current source's AC magnitude defaults to 0: it is usually a bias, and an AC analysis that injects 1 A of tail current measures the bias instead of the input.
- **The switch writes its own model** (`.model S1_MOD SW(…)`). Diodes expose a model name and the pre-run check blocks two diodes that share a name with different coefficients; for a switch the model name means nothing, and making the user rename it every time two thresholds differ would be friction for nothing.
- **Controlled sources show polarity in the symbol, not as pin text.** Their pins sit off-axis from the part origin, where the automatic pin-name text landed on the designator or on the control lines. The diamond carries + / − or an arrow, the control port its own + / − or sense arrow, and the pin names (C+, C−, …) still appear in the issue list. The potentiometer's wiper runs through the default designator spot, so it brings its own text slot (`LibPart.textAt`).

#### An input that nothing drives used to hang the run

Found while testing the controlled sources, and **it applied to the ideal op-amp all along**: if a net is read only by inputs — an op-amp input left open, two inputs tied to each other and nothing else, a behavioral source reading `V(x)` where no net is named `x` — ngspice cannot solve it, and this engine build then **never returns**. It leaves `Error during 'write': no writable vector found.` in its messages and the promise stays pending; the app sat at "Running…" for good, and only a reload got it back.

Two layers now:

| | |
| --- | --- |
| Pre-run check | An input pin (the control nodes of `E`/`G` lines, the `V({pin})` of `B` lines — read from the template, so op-amps saved in old projects are covered too) on a net with no other pin is an **error**, not the old floating-pin warning. A behavioral expression's `V(net)` must name a net that exists and is driven. A current-sensing port shorted to itself, a coupling k outside 0…1 and a wiper outside 0…1 are errors too |
| Worker (`src/sim-run.ts`) | While `runSim` is pending it watches the engine's messages; when the stall line appears the run fails with a readable message naming the node ngspice pointed at. A stalled engine instance stays stalled, so it is dropped and the next run starts a fresh one (and reloads the SKY130 files into the new file system) |

A capacitor alone on an input is fine — DC-floating, but ngspice solves it (measured), so it is not blocked. In the browser the stalled run now ends in about 0.3 s instead of never.

#### How the parts were checked

`tools/verify-library.ts` builds each part into a schematic (pins joined by net labels), extracts nets, writes the netlist and runs it, against values worked out by hand:

| Part | Circuit | Measured | Expected |
| --- | --- | --- | --- |
| Potentiometer | 1 V across it, wiper at 0.3 | 0.7000000000 V | 1 − 0.3 (0 is the pin-1 end) |
| DC current source | 2 mA into 1 kΩ, bottom grounded | +2.000000000 V | +2 V (the sign is the point) |
| Sine current source | 1 mA into 1 kΩ | amplitude 1.0000, +sin(ωt) | 1 V, not inverted |
| VCVS · VCCS · CCVS · CCCS | 0.3 V and 1 mA controls | 3 · 0.6 · 0.5 · 10 V | 10·0.3 · 2m·0.3·1k · 500·1m · 10·1m·1k |
| Comparator | V+ − V− = +10 mV, −10 mV, 0 | 5 · 0 · 2.5 V | high · low · midpoint |
| Multiplier · behavioral | 0.5·2·3 · `2*V(x)+V(Y)/3` | 3 · 5 V | 3 · 5 (net names case-insensitive) |
| Switch | 5 V into 1 kΩ, closed / open | 4.995004995 · 0.004995005 V | 1 Ω / 1 MΩ dividers |
| Transformer | 1 mH : 4 mH, k = 0.999, 1 kΩ load, 100 Hz–100 kHz | error 4.4e-16, phase 6.5e-14° | V2/V1 = 2k / (1 + jωLs(1−k²)/R), dots in phase |
| Transmission line | 50 Ω both ends, TD = 10 ns | \|H\| error 1.1e-16, phase error 0 | 1/2, −360°·f·TD |
| Polarized capacitor | RC corner | 0.7071067812, −45.000000° | 1/√2, −45° |
| Zener | 1 mA pushed into the cathode | 5.1003 V | BV = 5.1 V at IBV |
| DC current source in AC | bias on a 1:1 divider | 0.5000000000 | 0.5 — the bias injects nothing |

It also pins the catalog (every part listed once, a description for each, pin notes that point at real pins), every symbol's pin legs (so moved wires know which way to leave), the exact multi-line netlists, every new pre-run check, and the stall guard itself (a stalled run fails in about 150 ms in Node and a fresh engine runs normally afterwards).

### Semiconductors and `.model`

Five of them: diode · NPN · PNP · NMOS · PMOS. Vendor SPICE models come with assorted redistribution terms, so **they are not included** (design doc, risks section). Instead there are generic models built from textbook values, with the model name and the main coefficients exposed as properties.

| Part | Device line | Model line | Properties |
| --- | --- | --- | --- |
| Diode | `D1 in out DGEN` | `.model DGEN D(IS=1e-14 N=1)` | saturation current · emission coefficient |
| NPN · PNP | `Q1 c b e QNGEN` | `.model QNGEN NPN(IS=1e-16 BF=100)` | saturation current · βF |
| NMOS · PMOS | `M1 d g s s MNGEN W=100u L=10u` | `.model MNGEN NMOS(VTO=2 KP=20u LAMBDA=0.02)` | threshold · transconductance · channel modulation · W · L |

Model lines are built by the same template substitution as device lines. Only the ones in use, deduplicated, in name order, right after the device lines (export rule 7) — so the same circuit always produces the same file.

**Giving one name two sets of coefficients is blocked by the pre-run check.** Left alone, two `.model` lines go out and ngspice picks one without an error — the quietly-different-circuit case. Names are case-insensitive in SPICE, so `dgen` and `DGEN` count as the same name.

**A MOSFET's bulk is tied to the source rather than brought out as a pin.** Discrete parts are actually built that way, and tying the bulk to 0 adds body effect when the source is not at ground — for a PMOS it produces an outright wrong circuit. The design doc's table wrote the fourth node as `0`, but the same row listed the pins as D·G·S·B, so the right one of the two was chosen.

### The demos

Chosen so that the 13 original parts and the four original analyses get used at least once (the parts the component library added are checked one by one in `tools/verify-library.ts` — see below). The app's demo buttons and the automated tests use the **same definitions** (`src/lib/demos.ts`), and the expected-value math sits next to the circuit definition — kept apart, the tests pass while the screen shows a different circuit.

| Demo | Analysis | Uses | Measures |
| --- | --- | --- | --- |
| RC low-pass | transient | R · C · sine source | amplitude 0.847 V, phase −32.1° |
| Inverting amplifier | transient | op-amp | gain −10 |
| Half-wave rectifier | transient | diode | peak = Vp − Vd (solving Shockley) |
| **Voltage divider** | **operating point** | **DC source** | v(out) = 5·4.7/14.7, error 0 |
| **RC step response** | transient | **pulse source** | v(τ) = 5(1−1/e), v(5τ) |
| **RLC resonance** | **AC** | **inductor** | at resonance \|H\| = 1, phase 0 |
| **CMOS inverter** | **DC sweep** | **NMOS · PMOS** | threshold = VDD/2 = 2.5 V |
| **Common-emitter amplifier** | **DC sweep** | **NPN** | slope = −βF·RC/(RB+rπ) |
| **SKY130 inverter** | **DC sweep** | **SKY130 nFET · pFET** | rails at 1.8 V and 0, threshold below VDD/2 |
| **SKY130 5T OTA** | AC | SKY130 nFET · pFET, load capacitor | single pole: −45° at f₋₃dB, unity gain = f₋₃dB·√(A0²−1) |
| **SKY130 StrongARM latch** | transient | 11 SKY130 transistors, clock and supply by net label | ±10 mV decided to the rails, reset to VDD, equal decision times |

**Every example opens with calculator rows.** Open one, press Run, and the Calculator tab already holds that circuit's metrics. Where the textbook has a formula, a hand calculation sits under the simulated value (`# by hand`). The rows are there to be read and edited — the quickest way to see how a metric is written.

| Example | Calculator rows |
| --- | --- |
| RC low-pass | cutoff 1/(2πRC) = 1.592 kHz; gain by sine fit and phase from the zero-crossing delay, against 1/√(1+(f/fc)²) and −atan(f/fc); spectrum |
| Inverting amplifier | gain at the input peak, against −(Rf/Rin)/(1 + (1 + Rf/Rin)/A); output swing; input resistance = Rin (virtual ground) |
| Half-wave rectifier | peak and diode drop; average, RMS, THD; spectrum |
| Voltage divider | v(out) against the divider formula; input resistance; power in the resistors = power from the source |
| RC step response | τ from the 10–90 % rise time (τ·ln 9), against RC; 1 % settling in units of τ, against ln 100; capacitor current and its integral, against the charge C·V |
| RLC resonance | Bode magnitude and phase; f0 where the phase crosses 0, against 1/(2π√(LC)); half-power bandwidth, against R/(2πL); Q = f0/B, against √(L/C)/R |
| CMOS inverter | threshold; noise margins from the two points where the gain is −1; small-signal gain −(gm1 + gm2)/(gds1 + gds2) along the sweep; peak shoot-through current against the square law |
| Common-emitter amplifier | gain at VBB = 0.9 V against −gm·RC/(1 + RB/rπ); IC/gm against kT/q; VCE(sat) |
| SKY130 inverter | the same rows on BSIM4: threshold below VDD/2, unequal noise margins, VTH at the threshold |
| SKY130 5T OTA | Bode; A0 against gm3/(gds2 + gds4); fu against gm3/(2π·CL) — 1.4 % high by hand, as the output node has more than the 1 pF; phase margin; gm/ID |
| SKY130 StrongARM latch | output difference; both decision times (107 ps each); the sign decided for ±10 mV; average power and energy per decision |

The hand rows carry their units — `1/(2*pi*1kohm*100nF)` reads 1.592 kHz, `kb*tnom/q` 25.86 mV — so each one reads in the same terms as the simulated value above it.

The two inverters plot the gain twice, on purpose: `gain` is the derivative of the swept transfer curve, `av` the small-signal gain from the device values (exact for an unloaded inverter in any region). On SKY130 the two lines lie on top of each other. On the level-1 pair they part at the threshold — `av` reaches −210 there, and the 50 mV sweep's derivative stops near −45, because the transition is steeper than the step.

`tools/e2e-calc.ts` runs every example's rows the way the app does, and checks three things. No row fails or asks for a device value the engine does not have. The values agree with closed forms — the rectifier's average, RMS and THD, for instance, against the Shockley equation solved point by point, to 3e-6, 2e-6 and 3e-4. And the **units** are right. That last check exists because a wrong unit is easy to write: `5033/band` reads 3.16 just like `f0/band`, but in seconds (see the rule under "The calculator").

**Theory values are solved, not written in as constants.** The rectifier's diode voltage is implicit — the current is inside the voltage — so it is solved iteratively, and the CE amplifier's slope is computed from **rπ derived from the IC read out of the simulation** — so that when the bias changes, the expected value changes with it (error 7.8e-4).

**RLC is matched against theory at the sampled frequency.** At 50 points per decade, no sample lands exactly on the resonant frequency. Find the peak sample, compute R/(R+j(ωL−1/ωC)) **at that frequency**, and magnitude and phase agree to 1e-16. Whether the peak is near f0 (within 4.6%, one sample spacing) is checked separately.

**The MOSFET model includes channel-length modulation.** With LAMBDA at 0 the output resistance in saturation is infinite, so at a point of infinite gain like a CMOS inverter the solution is undetermined — the DC sweep actually spiked to **−5,000,000 V** at the transition. With the textbook value (0.02 /V) as the default the transfer curve falls properly. The threshold is still 2.500000 V.

**The 5T OTA runs open-loop on purpose.** nFET input pair, pFET current-mirror load, tail current source; W 5 µm · L 1 µm, VDD 1.8 V, both inputs at 0.9 V, 1 pF load. With equal inputs the symmetric circuit puts the output at the mirror node's voltage, so it sits in the high-gain region without feedback and the AC sweep reads the small-signal gain directly. Only the + input carries the AC signal — every other source is set to `AC 0`, otherwise VDD would carry the signal too. The gain itself (40.4 dB, gm·(ro2‖ro4)) comes from the process model, so it only gets a sanity window. What can be solved by hand is that the 1 pF output node makes **one dominant pole**: phase −45.008° at f₋₃dB (133 kHz), −0.4311° at 1 kHz against −atan(f/f₋₃dB) = −0.4312°, and unity gain at 13.834 MHz against f₋₃dB·√(A0²−1) = 13.840 MHz (phase margin 87.5°).

**The StrongARM latch is drawn the way a designer would draw it.** Eleven transistors: four pFET resets (outputs and the internal nodes p, q), the cross-coupled pFET and nFET pairs, the input pair and the clocked tail. Clock and VDD reach the gates and sources through **net labels** (same name, same net) rather than wires — routing a clock line to six gates turns the page into a thicket. The two cross-coupling lines cross each other and the gate columns without a dot; a plain cross is not a connection. A 10 ns clock runs it twice with inn at 0.9 V and inp stepped from 0.91 to 0.89 V: +10 mV ends at outp 1.8 V / outn 0 V, −10 mV the other way round, both outputs back at 1.8 V during reset. The latch's gain is unbounded, so direction and rails can be checked exactly; the decision time (about 107 ps from the clock edge to half-rail output difference) is up to the model, but the circuit is mirror-symmetric, so +10 mV and −10 mV must decide in the same time — they do, 0.3 ps apart at a 10 ps time step. Probes on clk, outp and outn make the waveform open on just those three; with all nine nets drawn, the decisions hid under the lines sitting at 0 V. The OTA opens on its output's Bode magnitude the same way.

**The common-emitter sweeps 0.3–2 V so that cutoff → active → saturation fit on one screen.** Starting at 0.6 V hides cutoff — even there a little base current flows and the collector sits 11 mV below VCC.

### Demo 3 — half-wave rectifier

10 V 1 kHz sine → diode → 1k load. It is not a sine, so it cannot be measured by fitting; instead two things that match hand calculation are checked. `Demo` has a `measure()` so that **the expected-value math is next to the circuit definition.**

The diode voltage at the peak is implicit, so it is solved iteratively — the current is inside the voltage.

```
I = (Vp - Vd)/R,   Vd = n·Vt·ln(I/Is + 1)
```

**The peak must not be measured as the maximum sample.** At 10 µs spacing with a 1 kHz sine, the peak can be missed by up to 5 µs and read **4.9 mV low**. Using the vertex of the parabola through the largest point and its two neighbors gets it to 1.4e-6 V (ngspice's time steps are not uniform, so the Lagrange quadratic is solved directly).

The reverse floor is −1e-8 V. Almost all of that is GMIN (1e-12 S), which ngspice puts in parallel with every device for convergence, not the saturation current (−1e-11 V).

**Amplitude is not printed in the legend for non-sinusoidal waveforms.** Fitting a sine to a rectified waveform gives you the fundamental component, not the size of the waveform. If the residual exceeds 5% of the amplitude, it is hidden.

### The analyses — transient · DC op · DC sweep · AC · noise · transfer function

Picked in the simulation panel. Changing the kind swaps in that kind's defaults, and since the x axis changes, the previous result and cursors are dropped.

| Kind | Analysis line | X axis | Result |
| --- | --- | --- | --- |
| Transient | `.tran 10u 5m 0 10u` | time (linear, ms) | real |
| DC operating point | `.op` | none | one point → **a table** |
| DC sweep | `.dc V1 0 5 0.1` | swept voltage (linear, V) — or `temp` for temperature, in °C | real |
| AC | `.ac dec 20 10 1meg` | frequency (**log**, Hz) | **complex** |
| Noise | `.noise v(out) V1 dec 10 1 1g` | frequency (log) | output and input-referred noise density, V/√Hz |
| Transfer function | `.tf v(out) V1` | none | gain · input resistance · output resistance → a table |

The last two came in with the calculator (below) — see "Noise and transfer function".

The x axis is chosen by the **result vector name**, not by the analysis kind (`time` → `frequency` → `*sweep*`). That way an external `.sp` run without a schematic still gets the right axis. ngspice names the DC sweep axis `v(v-sweep)`, and since the name starts with `v(` it would otherwise **be drawn as a voltage** — the trace used as the axis is excluded from the plot.

**One circuit runs both analyses.** A voltage source line can carry DC/AC specs and a transient spec at once.

```spice
V1 in 0 AC 1 SIN(0 1 1k 0 0 0)     <- 'AC 1' is added only for an AC analysis
```

When it is not an AC analysis, `{acspec}` becomes empty. That keeps the transient netlist identical down to the character — the `.sp` round trip and the desktop-ngspice comparison depend on it.

**AC results are complex.** Not knowing that and calling `Float64Array.from` turns everything into `NaN`, with no error and an empty graph. `src/sim-values.ts` converts to magnitude and phase. The complex test is per **whole result**. Per vector, the input, whose imaginary part is always 0, loses its phase and only `v(out)` gets an angle in the table; per point, a point at exactly 180° (imaginary 0, real negative) comes out with a **negative magnitude**.

The cursor table prints the angle alongside for AC, like `0.9878 V ∠-9.0°`. The y axis starts at 0 when all values are positive — this keeps the bottom half from being empty for AC magnitudes and 0–5 V sweeps.

**Files saved earlier** — projects from when transient was the only analysis have no `kind`. Opened as is, a netlist goes out with no analysis line and the engine returns an empty result. `normalizeSim()` lays down the per-kind default shape at the loading points (autosave, `.sp` restore) and overlays the stored values.

### Waveform cursors A·B

Click the waveform for cursor A, Shift+click for B. Hold and drag and it follows. Double-click clears them. Each trace's value, ΔV and Δt appear to the right of the waveform (the same place as the design doc's screen sketch).

Cursors **snap to actual samples.** So the values you read are what the simulation produced, uninterpolated, and in the RC demo they match theory to 1e-4:

| | Cursor | Theory |
| --- | --- | --- |
| v(in) @797.31 µs | −0.9562 V | −0.9561 V |
| v(out) @797.31 µs | −0.8172 V | −0.8175 V |

The cost is that **time resolution is tied to the sample spacing.** With a 10 µs max step in `.tran`, a Δt measured by cursor only comes in multiples of 10 µs — put them on the input and output peaks and the theoretical 89.3 µs reads as 100 µs. Fine for eyeballing, and this is why the automated tests use sine fitting rather than cursors.

Rebuilding the whole tab while moving a cursor replaces the canvas with a new one, so **mid-drag the pointer events go to a detached element.** So it redraws in place.

### Automatic measurements (`.meas`)

The cursor answers "what is the value here". It does not answer "what is the rise time", and the paragraph above says why: a cursor reads samples, so Δt only ever comes in multiples of the step. ngspice can answer that question itself — `.meas` interpolates between samples and returns a named number.

Write the lines in the Simulation panel, one per row, the way ngspice takes them:

```
tran trise TRIG v(out) VAL=0.1 RISE=1 TARG v(out) VAL=0.9 RISE=1
dc   vmid  FIND v(out) AT=0.9
ac   bw    WHEN vdb(out)=-3
```

The leading `.meas` is added when the netlist is built, so you can leave it off — or type it, both are accepted. The lines go **after the analysis line and before `.end`**, which is where ngspice needs them: it has to know which analysis' results to look at, and it never reads past `.end`. They belong to the project, not the sheet, next to the analysis settings — and they travel inside exported `.sp` files, so the deck you hand to desktop ngspice measures the same things.

Three things made this more than passing text through:

**The results do not come back as data.** ngspice returns vectors for traces, but measurements arrive as **text in `getInfo()`** — `vfinal =  9.998774e-01`, `trise =  2.195845e-04 targ=  … trig=  …`. There is nothing to plot, so they get a table of their own (the Measure tab) rather than a line on the waveform. Since we are parsing prose, the parser only looks for **the names the netlist actually asked for**: inventing a number out of an unrelated log line would be worse than showing nothing. A name that cannot be found reads `failed`.

**A failed measurement is not a failed run.** `.meas tran nope FIND v(out) AT=9` on a 5 ms sweep writes this to `getError()`:

```
Error: measure  nope  find(AT) : out of interval
 .meas tran nope find v(out) at=9 failed!
```

The prefix is `Error:`, and the message sorter (above) treats those as fatal — so one mistyped measurement threw away a run that had produced 512 perfectly good rows, **waveform and all**. Those two shapes are now classed as notices when results exist. The reason is not thrown away either: it is lifted out and shown next to that row, so `failed` comes with `find(AT) : out of interval` beside it rather than leaving you to guess.

**Parsing prose breaks silently when the format shifts.** So the format is pinned in two independent places. `tools/verify-dotmeas.ts` holds the engine's real output as a fixture and tests the parser against it — name extraction, `.meas` vs `.measure`, names that are prefixes of each other (`vfinal` vs `vfinal2`), repeated runs, failures. `tools/e2e.ts` asks the live engine and compares against **hand calculation**:

| | Measured | By hand | Error |
| --- | --- | --- | --- |
| `vfinal FIND v(out) AT=5m` | −0.4505379 V | −0.4504772 | 6.1e-5 |
| `t4 WHEN v(out)=0.8 RISE=4` | 3.2863100 ms | 3.2861590 | 1.5e-7 |
| `tr TRIG 0.1 TARG 0.8` | 178.1544 µs | 178.0355 | 1.2e-7 |

If the engine changes its wording the e2e breaks; if the parser is broken the unit test breaks. Which one moved is then obvious.

### Noise and transfer function

Two analyses the textbook needs and the first four cannot give: the noise spectra of Razavi's chapter 7, and the gain · Rin · Rout triple of chapter 3. Both take an **output** and an **input source**; write a net name (`out`), a difference (`v(a,b)`) or, for `.tf`, a current (`i(V1)`). Choosing the kind fills both from the circuit — the output the way the `.meas` example picks one, the source as the one that carries the signal: a sine or pulse source if there is one, otherwise the DC source whose AC magnitude is not 0 (in the 5T OTA demo, bias and supply are written `AC 0`, which leaves the + input).

What ngspice does with these lines, measured on this engine:

| | |
| --- | --- |
| `.noise` with no AC value on the input source | `Noise input source v2 has no AC value`, the analysis is skipped, and the engine then fails on `no such plot named noise1`. The input source is given `AC 1` for this analysis — and only it needs one: another source's AC magnitude changes neither spectrum |
| `.save @m1[gm]` next to `.noise` | **the noise spectra are gone** — only `@m1[gm]` comes back. With `.save all @m1[gm]` both do |
| `.save v(out)` next to `.tf` | `no data saved for transfer function analysis; analysis not run` |
| `.tf` vector names | `transfer_function` · `output_impedance_at_v(out)` · `v2#input_impedance` — and `v1#output_impedance` when the output is a current, `i1#input_impedance` when the source is a current source. The unit of the gain (ratio, Ω or S) is read from these |
| `.dc temp -40 125 5` | the axis is named `temp-sweep`; a swept current source gives `i(i-sweep)`. The waveform axis now labels °C and A instead of always V |

So neither analysis gets `.save` lines of its own, and whatever the calculator needs goes behind `all`. A source name that does not exist used to surface as an ngspice error on an unrelated line; the pre-run check now says `The analysis takes its input from V9, but there is no source by that name — sources: V1, V2` (the DC sweep's source gets the same check, with `temp` allowed).

**Noise is drawn log-log.** On the waveform tab's linear y axis a 1/f spectrum is a needle at the left edge and a line along the floor; on two log axes 1/f is a straight slope and the thermal floor is flat (the picture of Razavi's Fig. 7.27). The noise view uses the calculator's plot for that. ngspice's `.meas` does not read noise results, so the measurement editor says so and points at `rmsnoise()`.

**`.tf` gets a table of its own.** Its three values arrive wrapped as `v(…)`, so the operating-point table would have printed an output resistance in volts. An open terminal comes back as 1e20 Ω and is shown as `∞ (open)`.

### The calculator — post-processing the results

The waveform shows curves and `.meas` answers the questions ngspice has a keyword for. The questions an analog designer actually asks sit one step further: what is the phase margin, gm/ID of M1, the THD, the integrated noise, the CMRR. The **Calculator** tab answers them with expressions over the last run:

```
a0  = dcgain(v(out)/v(inp))           104.16 (40.35 dB)
fu  = ugf(v(out)/v(inp))              13.82 MHz
      pm(v(out)/v(inp))               87.48°   at fu = 13.82 MHz
      gm(X3)*ro(X2)*ro(X4)/(ro(X2)+ro(X4))    104.3
bode = db20(v(out)/v(inp))            waveform · 141 pts · dB      ← plotted
```

Each row is one line of text, kept with the project (`project.calc`, next to `project.meas`, and inside exported `.sp` files). A row that starts with a name can be used by the rows below it. A row whose value is a waveform is plotted on the right.

**It is a language, not a list of measurements.** A fixed menu of "measure THD", "measure phase margin" covers the textbook and nothing next to it: the THD of a differential output, a gain ratio between two runs, a noise integral over the audio band only. So there are three pickers above the rows and all three only *type for you* — **Metrics** (the textbook's performance metrics as expressions), **Signals** (the nets, currents and device values of this circuit) and **Functions**. What they insert is ordinary text from then on.

| Writing | Means |
| --- | --- |
| `10k` `2.2meg` `5m` `1u` | Numbers with SPICE suffixes. `M` is milli, as in SPICE — and the row says so. `2pi` is an error, not 2 pico |
| `1kohm` `100nF` `10mH` `1kHz` `5V` `1mA` | A unit written after a number goes with it: `1/(2*pi*1kohm*100nF)` is 1.592 kHz. `S` is siemens and `s` seconds; `1F` is 1 femto, as in SPICE |
| `v(out)` · `v(a,b)` | Net voltage · difference. The argument is a **name**, read up to the matching bracket, so `v(v2#input_impedance)` works |
| `i(V1)` · `i(R1)` · `i(M1)` | Current through a source or inductor; through a resistor or capacitor; drain / collector current |
| `gm(M1)` `ro(M1)` `vov(M1)` `ft(M1)` `beta(Q1)` … | Device values at the operating point, by the designator on the schematic (39 of them) |
| `op(M1, cgg)` · `@m1[cgg]` | Any operating-point parameter ngspice has, by its own name |
| `dm.v(out)` | A signal from a **kept run** |
| `+ − * / ^`, `name = …`, `# comment` | Arithmetic on numbers and waveforms, real or complex |
| `time` `frequency` `sweep` · `onoise` `inoise` · `tf_gain` `tf_rin` `tf_rout` · `pi` `kb` `q` `tnom` | The x axis · noise densities · `.tf` results · constants |

| Functions (97) | |
| --- | --- |
| Math | `abs sqrt exp ln log10 pow sin cos tan atan atan2 hypot min max floor ceil round sign deg rad` … |
| Complex & dB | `mag phase real imag conj db20 db10` |
| Calculus | `deriv` · `integ` (a number) · `iinteg` (the running integral) |
| Statistics | `mean rms stddev ymax ymin xmax xmin pp value first last npoints` — each takes an optional `from, to` |
| Window & sampling | `clip` · `sample(w, step, from, to)` · `resample` · `shift` · `xval` |
| Timing & events | `cross ncross delay risetime falltime slewrate settling overshoot period freq duty periods instfreq jitter` |
| Spectrum & distortion | `fft` (rect · hann · hamming · blackman · bh · flattop) · `psd` · `harmonic hd thd sfdr sndr enob` |
| Frequency response | `dcgain f3db ugf gbw pm gainmargin pcross peaking groupdelay middlebrook` |
| Noise | `rmsnoise fcorner enbw snr` |
| DC transfer | `slope swing nonlin tc` |

A value is a number or a waveform, and waveforms carry their axis: adding a time waveform to a frequency response is an error, not a silent mismatch. Two waveforms on different grids (a kept run, two `fft()` results) are interpolated onto the first. Help → Calculator reference lists everything.

**Units are worked out, not looked up** (`src/calc/units.ts`). Every electrical unit is a power of V, A and s, with m and K added — Ω = V/A, F = A·s/V, H = V·s/A, Hz = 1/s — so a product, quotient, power or square root is arithmetic on exponents, and the result is named again: `v(out)/i(V1)` is in Ω, `1/(2*pi*1kohm*100nF)` in Hz, `gm(M1)/(2*pi*1pF)` in Hz, `sqrt(kb*tnom/1pF)` in V, `sqrt(4*kb*tnom*1kohm)` in V/√Hz, `integ(v(out)^2)` in V²·s, a slew rate in V/µs. Exponents go in halves, for √Hz. Three rules sit on top:

- **A number without a unit is a pure number.** `2*v(out)` is in V and `1/ro(M1)` in S. So a frequency written by hand without its unit and divided by a simulated one comes out in seconds — write `5033Hz/band`, not `5033/band`.
- **dB, °, % and ppm do not multiply.** They survive adding and subtracting their own kind (`bode + 3`, `phi + 180`) and scaling by a pure number; anything else makes the result unknown. `°C`, the temperature axis, counts as a temperature difference, so a derivative over a temperature sweep is in V/K.
- **Unknown is kept apart from dimensionless, and stays unknown.** `v(out) + i(V1)` has no unit, and neither does anything computed from it, so dividing it by `1kohm` does not turn it into siemens. Unknown shows as a blank.

A value whose unit starts with an exponent — V², V²/Hz, Ω², V⁻¹ — is written without an SI prefix, because `µV²` reads as (µV)². `A/V²` keeps its prefix: it belongs to the A.

#### Device values — and why asking ngspice for them is delicate

ngspice saves node voltages and branch currents, not `gm`. Each device value has to be asked for by name — `.save @m1[gm]` — and comes back as a vector along time, along the sweep, or as one point. The calculator reads its own rows, works out which names they need, and adds them to the run (`calcSaves` → `savePlan`). So a new `gm(M1)` row says *press Run* once, and then has its value.

The names are not the same from model to model, and a name the model does not have does one of two bad things. Both were measured on this engine, one name at a time:

| Asked for | Level 1–3 | BSIM3 (level 8 · 49) | BSIM4 (14 · 54, SKY130) |
| --- | --- | --- | --- |
| threshold | `von` — `vth` reads **0** | `vth` — `von` reads **0** | `vth` — `von` reads **0** |
| total gate capacitance | `cgg` **stops the run** — built from `cgs + cgd + cgb` | `cgg` | `cgg` |
| `cgb` | yes | **stops the run** | yes |
| a typo (`@m1[bogus]`) | **stops the run** | stops the run | stops the run |

"Stops the run" means: `vector @m1[cgg] is not available`, then `no writable vector found`, and the engine never returns — one name loses the whole simulation, waveform included. "Reads 0" is worse because it looks like an answer: `@m1[vth]` on a level-1 device comes back as 0 V when another parameter is saved beside it (and stops the run when it is alone). A threshold of 0 V in a gm/ID table would not be noticed.

So the calculator knows what each family has (`src/calc/devices.ts`) and asks only for that. `vth(M1)` reads `von` on a level-1 device and `vth` on a BSIM one; `cgg(M1)` adds the three Meyer capacitances where there is no `cgg`. For a model it does not know (another level, or an external deck) it does **not guess** the names that differ between families — `vth()`, `vov()`, `cgg()`, `ft()` say so and point at `op(M1, vth)` / `op(M1, von)`. And if a name asked for that way still stops the run, the worker takes **that vector** out of the save lines and runs again (`runWithFallback`, `src/sim-run.ts`): the rest of the device values survive, and the row that asked reads `ngspice has no @m1[cgg] for M1 — the run was repeated without it`. ngspice names one missing vector at a time, so each missing name costs one more run on a fresh engine — a stalled one cannot be reused (0.8 s in all for one retry of a small circuit in Node). A stall that is not the calculator's doing — a floating node aborts the analysis, and then the *first* saved vector is reported missing — is recognised by `run simulation(s) aborted` and not retried.

Signs, as the textbook writes them. ngspice returns `vgs`, `vds` and `id` of a PMOS as magnitudes already, but a level-1 PMOS keeps `von` and `vdsat` negative while BSIM4 gives them positive; BSIM's `cgs` is a transcapacitance and comes back negative; a PNP's currents keep their sign. The device functions give |VTH|, |VDS,sat| and |Cgs|, and currents in the direction the device conducts — so `vov(M2)` is 1.5 V for a PMOS with VSG = 2.5 V and VTH = −1 V (checked against the engine), and `gm(M1)/id(M1)` needs no `abs()`. `@m1[von]` still returns ngspice's raw −1.

**In an AC or noise run a device value is one number.** The operating point does not move with frequency; ngspice just repeats it at every point. Returned as a 141-point flat waveform, `gm(X3)` was a plot instead of a number and dragged every expression using it into a waveform too. And `i(R1)` is refused there: `@r1[i]` in an AC run is 0 and `@m1[id]` is the DC drain current — neither is the AC current the row asked for (measured). The message says to put a 0 V source in series.

What reaches the netlist, on top of the existing `.save` rules:

- **Ordinary run** — the names are appended to the node list: `.save v(out) v(in) @m1[gm]`.
- **Runs that save everything** (`.op`, noise, `.tf`, a directive block with device lines, a `.meas` with `par()`) — `.save all @m1[gm]`. Plain `.save @m1[gm]` would save *only that*: the operating-point table loses its voltages, noise loses its spectra, `.tf` is skipped. Voltages and branch currents are not repeated after `all`, and with no device value asked for there is no line at all.
- **A `.save` of the user's own in a directive block** — the names are added without `all`, which would have overridden what the user chose to save.
- The exported `.sp` gets none of this, as before.

#### Kept runs — metrics that take two simulations

CMRR is a differential gain over a common-mode gain; PSRR is the gain from the input over the gain from the supply; a VCO's gain is the frequency at two control voltages. No single run holds both halves. **Keep run…** names the last run, and expressions read it with a prefix:

```
db20(dcgain(dm.v(out)) / dcgain(cm.v(out)))        # CMRR, eq. (4.55)
(freq(b.v(out)) - freq(a.v(out))) / 0.1            # KVCO in Hz/V, eq. (15.55)
```

Kept runs live for the session and are dropped when another project is opened — they are megabytes, and they belong to the circuit that produced them.

#### The metrics, by chapter

The Metrics picker follows Razavi, *Design of Analog CMOS Integrated Circuits* (2nd ed.), chapter by chapter: 94 entries in 16 groups, each one an expression with a line saying what it is and which section defines it. The names in them are **this circuit's** — `{out}`, `{in}`, `{m}`, the supply and the signal source are filled from the schematic the way the `.meas` example is, so the first thing inserted does not fail on a net that is not there. Entries that need another analysis than the one selected are dimmed and say which. Names alone can mislead — in ALIGN's 5T OTA the net called `vin` is the inverting input, AC-grounded by the test bench — so a project can say which net and device is which (`calcRoles`: `out`, `in`, `outp`, `outn`, `m` …), and the picker takes those first; the layout examples all do.

| Chapter | Metrics | From |
| --- | --- | --- |
| 2 · MOS device physics | gm · rO · gm·rO · VGS − VTH · VTH · VDS − VDS,sat · gmb/gm · Cgg · fT | any run |
| 3 · Single-stage amplifiers | ∂Vout/∂Vin · peak gain · gain at a bias point · output swing · gain, Rin, Rout | DC sweep · `.tf` |
| 4 · Differential amplifiers | differential output · ADM · **CMRR** · input offset · input range | AC · DC sweep |
| 5 · Current mirrors | copy ratio · output resistance · compliance voltage | any · DC sweep |
| 6 · Frequency response | Bode magnitude and phase · A0 · f−3dB · fu · GBW · input impedance | AC |
| 7 · Noise | output and input-referred density · total noise · input-referred RMS · 1/f corner · floor · noise bandwidth · SNR · kT/C · √(4kTR) | noise |
| 8 · Feedback | closed-loop gain · loop gain by Middlebrook's method · closed-loop Rout | AC · `.tf` |
| 9 · Operational amplifiers | open-loop gain · fu · slew rate · 1 % settling · overshoot · output swing · **PSRR** · power · supply current | AC · transient · DC |
| 10 · Stability | phase margin · gain margin · gain and phase crossover · closed-loop peaking | AC |
| 11 · Nanometer design | gm/ID · ID/W · VDS,min · gm·rO against bias | any |
| 12 · Bandgap references | TC (box method and at 27 °C) · Vref · PTAT slope · supply sensitivity | DC sweep of `temp` / the supply |
| 13 · Switched-capacitor circuits | sampled values · 0.1 % settling · hold pedestal · switch Ron · kT/C | transient |
| 14 · Nonlinearity and mismatch | nonlinearity · THD · HD2 · HD3 · spectrum · SFDR · offset | DC sweep · transient |
| 15 · Oscillators | frequency · ring stage delay · amplitude · duty cycle · frequency over time · **KVCO** | transient |
| 16 · Phase-locked loops | lock time · frequency over time · RMS and peak-to-peak period jitter · phase error · control-voltage ripple | transient |
| 17 · Short-channel effects | DIBL · gm against VGS · rO against VDS | DC sweep |

`tools/verify-calc.ts` fills every one of the 94 from a circuit's names and evaluates it against a result of each analysis it claims to work on, so a renamed function or a wrong argument count cannot hide in an entry nobody clicks.

#### Where a definition had to be chosen

A metric is only as good as its definition, and several have more than one. These are the ones where the first implementation gave a number that was wrong, or right for a different question — every figure below was measured.

| | What went wrong | What it does now |
| --- | --- | --- |
| **−3 dB** | Measured at exactly 3.000 dB, a one-pole response gave 0.9976 × the pole | `f3db` uses the half-power point, 1/√2 (−3.0103 dB): the pole itself, which is what Razavi's ω0 is. Another number (`f3db(H, 6)`) is taken as given |
| **Phase margin of an inverting gain** | `v(out)/v(in)` of a common-source stage starts at 180°, so 180° + ∠H was off by 180° | PM is defined on the loop gain βH (§10.3). A response that starts near ±180° is taken as the loop gain of a negative-feedback loop, its sign belonging to the feedback: same margin as the non-inverting one |
| **Harmonics by FFT** | Resampling ngspice's uneven time steps for an FFT puts interpolation error at about −100 dB, and a window's main lobe swallowed HD2 into the fundamental: 1 % HD2 read **62.8 dB** SNDR instead of 40 | `harmonic` · `hd` · `thd` · `sfdr` · `sndr` fit the harmonics by least squares at f0, on the samples as they are — the reason amplitude and phase already use a sine fit (`src/measure.ts`). `fft()` is still there for looking at a spectrum |
| **Fitting only the harmonic asked for** | With 2 harmonics in the model, the 3rd leaked into the 2nd — on an uneven grid the cosines are not orthogonal — and HD2 was off by 2e-4 | Ten are always fitted; a signal the model fully contains is recovered exactly |
| **RMS of a sampled sine** | Integrating the square of the straight line between samples cuts the peaks: the power comes out (2 + cos ωh)/3 of the true one — 4e-5 low at 400 points a period, against 1e-4 for a −40 dB harmonic. SNDR read 42.3 dB instead of 40 | The squares at the samples are integrated by the trapezoid rule, exact for an evenly sampled sine over whole periods and what `.meas … RMS` does |
| **THD** | The book's eq. (14.10) is a power ratio; its own "0.01 % (−80 dB)" two lines down is an amplitude ratio | The amplitude ratio √(ΣAk²)/A1, the usual one — shown as % and dB. Its square is eq. (14.10), and the test checks both |
| **Integrating noise** | AC and noise points sit at equal steps of log f; the trapezoid rule on straight lines between them over-reads a 1/f slope and the −40 dB/decade tail | Each interval is integrated as a power law S ∝ f^α — exact for 1/f and for the asymptotes of a pole. kT/C of an RC comes out to 1.3e-3 at 10 points a decade |
| **Mean and RMS** | A point average weights the samples equally, and ngspice clusters them where the waveform moves fast | Time-weighted. Sample points (`sample()`, `periods()`) are averaged plainly — they are points |
| **Period of a ringing clock** | Ringing through the mid level halved the period | Edges have 5 % hysteresis: down through the lower threshold before a rise counts |
| **Settling** | — | Time until the waveform stays within tol % of the **step** around its final value (the final value when the step starts from 0, which is Example 9.2 and §11.6). A third argument sets the start |
| **Output swing** | The book gives a headroom argument (§9.6), not a formula a curve can be measured against | `swing(w, frac)`: how far the output moves while the gain stays above `frac` of its peak. The fraction is in the inserted expression so it is seen and can be changed |
| **Nonlinearity** | — | The largest deviation from the line through the **end points**, over the output span — Fig. 14.4. On y = α1x + α3x³ it reproduces eq. (14.6) to 1e-5 |
| **Noise bandwidth** | Started at the first frequency of the sweep | Eq. (7.146) integrates from 0; below the sweep the response is taken as flat. A one-pole RC gives π/2 · fc |
| **Units** | A table of pairs (V·A = W, V/A = Ω …) dropped any pair it did not hold, such as Ω·F or S/F. The dropped unit then read as *dimensionless* in the next step, so `(v(out) + i(V1))/ro(M1)` came out in siemens. Units written after numbers were parsed and thrown away | Exponents of V, A, s, m and K, with *unknown* kept apart and carried through; units after numbers are kept. See "Units are worked out" above |

One limit is the engine's, not the calculator's. With ngspice's default tolerance a behavioural source's output is accepted about 4 µV away from f(v(x)) — Newton stops on the value linearised at the predicted point — and that error reads as harmonics: HD2 off by 1.6e-4, which is (ωh)² for a 2 µs step, and HD3 by three times that. Tightening the engine (`.options reltol=1e-6` in a directive block) brings HD2 to 7e-7 of the closed form. Distortion below about −80 dB needs that line.

#### The plot

Rows that are waveforms are drawn as they are added — a spectrum should appear when `db20(fft(v(out)))` is typed, not after hunting for a checkbox — and each row's checkbox takes the colour of its line. The first plotted row sets the x axis; a frequency axis starts logarithmic, an `fft()` spectrum linear (it starts at 0 Hz), noise densities log-log. **There are two y axes**: the first unit on the left, the next different unit on the right, which is what a Bode plot is (dB and degrees). A third unit is not squeezed onto either — the legend says how many rows are waiting and why. Moving over the plot reads every line at that x, interpolated.

The plot is separate from the waveform tab's on purpose. That one is bound to the run — its x axis is the analysis' and its y axis is volts. A calculator result has whatever axis its expression produced.

#### Loaded when it is needed

Function table, metric texts, spectrum code and plot come to 109 kB (35 kB brotli) — a third again on top of the first-paint JS. Someone who came to draw a schematic should not pay for that before the first paint, so the calculator is its own chunk (`src/calc/calc.ts`) and `app.ts` imports only its **types**. It is fetched when the Calculator tab is opened, when a project that has calculator rows is run (the rows decide what to save), when a noise run needs the plot, or for the reference sheet — the same idea as `spice.wasm` waiting for Run. `tools/check-bundle.mjs` fails the build if the chunk disappears, which is what happens when someone imports a calculator module by value and the bundler quietly folds it into the first-paint chunk.

| | Before | After |
| --- | --- | --- |
| First-paint JS (brotli) | 96 kB | 101 kB — two analyses, their checks and tables, the calculator's wiring, and the examples' calculator rows |
| Calculator chunk (brotli) | — | 35 kB, on demand |

#### Verified against hand calculation

`tools/verify-calc.ts` (358 checks, no engine) runs the numerics on waveforms whose answers are closed forms: a one-pole response's f−3dB, fu = p·√(A0² − 1) and 90.06° margin; two and three poles for the margins; a 2nd-order step's 16.3 % overshoot; τ·ln 100 settling; a clock with ±5 ps period jitter; Razavi's eq. (14.9) for HD2 and HD3 and eq. (14.6) for nonlinearity; kT/C and the π/2 noise bandwidth; a 1/f corner. Samples are deliberately uneven, as ngspice's are. It also pins the unit arithmetic: Ω·F = s, S/F = Hz, √(kT/C) in V, units after numbers, and unknown staying unknown where the old table turned it into siemens.

`tools/e2e-calc.ts` (234 checks, 121 of them on the examples' own rows — see "The demos") goes through the engine the way the app does — schematic → netlist → the calculator's save lines → ngspice → the worker's converter → expressions:

| Circuit | Expression | Got | By hand | Error |
| --- | --- | --- | --- | --- |
| NMOS common source, `.op` | `gm(M1)` | 315.8 µS | β·Vov·(1 + λVDS) | 4.8e-10 |
| | `2*id(M1)/vov(M1)` | 315.8 µS | the square law: gm = 2ID/(VGS − VTH) | 1.1e-8 |
| | `1/(0.02*id(M1)/(1+0.02*vds(M1)))` | 222.2 kΩ | rO = 1/(λ·ID) = `ro(M1)` | 1.1e-8 |
| Same circuit, PMOS mirror image | `vov(M1)` | 1.500 V | \|VGS\| − \|VTH\| | 0 |
| Same circuit, `.tf` | `tf_gain` · `tf_rout` | −3.022 · 9.569 kΩ | −gm·(RD ‖ rO) · RD ‖ rO | 1e-8 |
| Same circuit, DC sweep | `slope(v(out), 2.5)` | −3.022 | the same −gm·(RD ‖ rO) | 3.5e-6 |
| SKY130 5T OTA, AC | `gm(X3)*ro(X2)*ro(X4)/(ro(X2)+ro(X4))` | 104.3 | A0 = 104.16 from the AC run | 1.3e-3 |
| | `ugf(H)` | 13.82 MHz | f−3dB·√(A0² − 1) | 5.9e-4 |
| | `value(phase(H), f3)` | −44.98° | −45° at f−3dB | 3.6e-4 |
| RC low-pass, noise | `rmsnoise(onoise)` | 203.3 nV | √(kT/C) | 1.3e-3 |
| | `value(onoise, 1)` | 4.071 nV/√Hz | √(4kTR) | 3.7e-7 |
| | `enbw(onoise)` | 2.494 kHz | π/2 · fc, eq. (7.146) | 2.2e-3 |
| Polynomial y = x + 0.1x² + 0.05x³ | `hd(v(out), 2)` · `hd(v(out), 3)` | 2.477 % · 0.3096 % | eq. (14.9) | 7e-7 · 6e-6 |
| RC step | `settling(v(out), 1)` | 460.1 µs | τ·ln 100 | 6.8e-6 |
| Two runs, RD 10 k and 5 k | `dcgain(a.v(out)/a.v(in)) / dcgain(v(out)/v(in))` | 1.915 | ratio of the two hand gains | 4.8e-9 |

The OTA row is the one that ties the two halves together: the gain computed from three BSIM4 device values read by name agrees with the gain the AC analysis measured, to 0.13 %. The same file pins what the device functions rely on — that a level-1 PMOS returns `von` = −1 and `vdsat` = −1.5, that BSIM4's `cgs` is negative — so an engine upgrade that changes a sign fails a test instead of a gm/ID table. It also asks for names the model does not have and checks that the run comes back with the rest.

### The assistant — OpenRouter, with your own key

The **AI** button in the menu bar (left of the theme button, or Shift+A) opens the assistant as the **rightmost column of the window** — beside the schematic, the Placement or Layout editor, or two or three of them together, and it stays there when you switch. You say what you want — *"an RC low-pass at 1.6 kHz, show me its Bode plot"*, *"why does this fail?"*, *"make the gain 11 and check it"* — and the assistant does the editing: it places and wires parts, sets values, picks the analysis, writes `.meas` lines and calculator rows, **runs ngspice, reads the numbers, and adjusts until the result meets the goal**. Everything it does is ordinary editing, so you can change or undo any of it by hand.

It runs on a model from [OpenRouter](https://openrouter.ai), with **your own key**: "Connect with OpenRouter" creates one through OAuth (PKCE — the page comes back with a code and trades it for a key), or you paste one. The key stays in this browser, and requests go from the browser straight to openrouter.ai — Melange still has no server. **The assistant sends your messages and a description of the circuit (parts, nets, netlist, simulation results) to OpenRouter, only when you use it.** The default model is the newest Claude Sonnet that takes tool calls; any tool-calling model on OpenRouter can be picked.

#### Pins and nets, not coordinates

A language model asked for "the coordinates of R1's pin 2" is off by one grid step now and then — and a wire off by one step lands on another pin and **shorts it quietly** (rule 3: a pin in the middle of a segment is a connection). So the tools speak in connections and the editor does the geometry:

| Tool | What it does |
| --- | --- |
| `get_circuit` | Parts with the net of each pin, nets with their pins, labels, directive blocks, analysis, `.meas`, calculator rows, probes, pre-run issues, unconnected pins. Big circuits come as a summary that can be narrowed by designators or nets |
| `place_parts` | Places parts; designators and positions are optional. **A pin never lands on an existing net** — the part moves to the nearest free spot, and the result says where |
| `connect` | `R1.2` to `C1.1`, or `C1.2` to the net `0` (a GND symbol) or `out` (a stub and a net label). The wire is found by the same router that re-routes wires when parts move (`src/doc/route.ts`) |
| `set_params` · `move_parts` · `delete` | Values (with the "M is milli" warning), designators, moves and rotations with wires following, deletes that take the dangling wire stubs along |
| `set_analysis` · `set_measures` · `set_calculator` · `edit_directives` · `set_probes` | The rest of what the Simulation panel and the Calculator tab hold |
| `run_simulation` · `get_results` · `read_trace` | Run and wait; a summary per trace (min, max, first, last), the `.meas` values and the calculator rows, and a trace read at chosen points |
| `import_netlist` | Merges SPICE text into the open circuit: designators that clash get the next free number, the new parts go to the right of the drawing, nets with the same name join (the result says which), and lines that cannot be drawn go into a directive block. `.control` and analysis lines are left out and reported |
| `rename_net` · `show_parts` | Renames a net's labels (and warns about directive lines that still use the old name); selects and zooms to parts, and highlights a net as the H key does |
| `view_schematic` · `view_waveform` | Pictures, for models that read images — see below |

**No connection you did not ask for.** `connect` routes, then extracts the nets again and checks that **exactly the two nets merged** and nothing else changed — net names are not compared, since auto names shift; the old-net → new-net map has to be a function and only the two may share an image. If the route fails that check, or there is none, the pins are joined by net labels instead, placed where they again touch nothing else. A move that would put a pin on another net, or leave a wire behind, is refused. `tools/verify-ai-tools.ts` connects random pin pairs 300 times on random sheets and finds no other connection changed.

Arguments are checked before anything is applied — a wrong designator or a parameter the part does not have changes nothing and goes back to the model with the list it should have picked from.

#### Layout — placement and routing, all the way

*"Lay this out"* is carried through: the assistant reads the schematic for the layout, places, routes, checks DRC/LVS and fixes what is left, then reports the size, HPWL and the check result. The tools call the same functions as the editors' buttons (`src/layout/ui/ai.mjs`), so the Placement and Layout editors show each step, and their undo takes it back. Long steps wait until the placer or router is done. The layout chunk is fetched the first time a layout tool runs.

| Tool | What it does |
| --- | --- |
| `layout_status` | What was read from the schematic (transistors, pins, size notes), the blocks (kind, parts, variants, symmetry), the placement (size, HPWL, each block's position, size, flip, variant, lock) and the tracks (how many, DRC/LVS errors, open nets, each net's pins and opens) |
| `layout_read_schematic` | Reads the schematic again; keeps the placement and tracks when the layout netlist did not change |
| `layout_place` | Auto place — effort (48 / 96 / 288 starts) and the weight of wirelength against area |
| `layout_edit_placement` | Moves (absolute or relative, nm), flips, variants, locks, a swap — then settles (overlaps out, on the grid, order kept); optionally re-optimizes the variants for that arrangement |
| `layout_route` | Auto route (optional) — by default the nets already drawn to the end stay and the router does the rest; `keep_drawn: false` replaces every track |
| `layout_fix_routing` | Draws like a person in the Layout editor: `connect_net` follows a net's ratsnest with L-shaped tracks (only where nothing is shorted and no spacing rule is broken), `connect_all` does every open net, `route_unfinished` hands what is not finished to the router, `delete_net` · `undo` · `redo` |
| `layout_show` · `view_layout` | Puts editors on screen and highlights a net or blocks (on the schematic too); a picture of an editor for models that read images |

Each request also carries one line about the layout (placed or not, size, tracks, DRC/LVS, open nets). `tools/verify-ai-tools.ts` checks the tools' arguments and refusals with a stand-in for the editors.

#### One request, one undo step — and you can keep editing

History now takes a **tag** with a command (`History.run(…, group)`). The assistant's commands carry the request's tag, and consecutive ones join one step labelled "AI: …", which the chat can undo with "Undo these changes". The tag travels with each command, not with "the assistant is busy": edits you make by hand while it works are steps of their own, and its later commands start a new step after them — undo still goes back in the order things happened, so the two never mix.

**The assistant is told what you changed — compared at the boundary, not on every edit.** Every commit says who made it, but a hand edit only marks the circuit as changed: nothing is scanned while you drag or type, so a big sheet edits as fast with the panel open as without it. The comparison runs once, right before something goes to the model — when a request is sent, and before each further step of a running request. The circuit is compared with the last state the assistant knew (taken right after its own edits, once per burst) and turned into a short log — values, designators, moves, which pins now share a net, labels, analysis, `.meas`, calculator rows — merged per item (1k → 2.2k → 4.7k is one line, and an edit undone by hand disappears). Edits between requests ride along in the next request's context; edits made **while** it works go in as a note before its next step, so it builds on them instead of undoing them. If a hand edit lands while one of its tools is still applying edits, the two cannot be told apart; the note says so and asks it to read the circuit again.

The analysis settings, `.meas` lines and calculator rows used to be changed directly, outside the history. **They are commands now** (`setSim` · `setMeas` · `setCalc`), so undoing the assistant's request undoes the analysis it chose, and Ctrl+Z undoes those edits when made by hand too.

#### Simulations it can wait for

The worker used to answer into the app's globals. `src/sim-client.ts` numbers each request and returns a Promise; the Run button and the assistant use the same path, so the waveform tab shows whatever the assistant ran. Stop terminates the worker — there is no other way to cut a running analysis — and the next run starts a fresh one. Results remember the document revision they ran on, so the assistant is told when they no longer match the circuit.

#### Pictures — the schematic, the plots, and your photos

For models that read images (the model list marks them "sees images"), two more tools appear. `view_schematic` draws the sheet the way the PNG export does — the same shape list through Canvas 2D, one function for both — and adds every net name beside its wires, pin names and probes, so the picture uses the same names as the netlist; given designators, it frames the area around them. `view_waveform` draws the waveform tab's graph off screen at a fixed size, with the legend drawn into the picture and, when a range is given, the vertical scale fitted to that range (a zoomed ripple reads 4.990 · 5.000 · 5.010 V, not 5.0 V three times). The pictures go to the model as one user message after the tool results — few providers take an image inside a tool result — and are **dropped from the conversation when the answer ends**: they show a past state, and every later request would pay for them again.

You can attach pictures too — the paperclip, paste, or drop on the panel: a photo of a circuit drawn on paper, a screenshot, a figure from a datasheet. The browser shrinks each to 1568 px on the long side and re-encodes it as JPEG (which also drops metadata such as a photo's location), up to four per message. They stay in the conversation while the page is open but are not saved with it; a reopened conversation shows where a picture was. With a model that does not read images, the paperclip says so instead of attaching. The PNG export got a fix on the way: its bounds now include the designator and value text, which used to be cut off along the top edge.

#### Project memo — what carries over between conversations

After a request that changed or simulated the circuit, one small extra call updates a short note about the project: what it is for, the targets, decisions, measured results, what is left to do. A new conversation starts from it, so starting over or summarizing a long conversation loses nothing that matters. It is sent when a conversation starts and when you have edited it — never back to the conversation that just wrote it. The memo button in the panel header opens it to read, correct or clear; if you edit it while the assistant is rewriting it, yours stays. It can be turned off in the settings.

#### Usage

Every request, conversation summary and memo update is logged per project: model calls, tokens in and how many came from the prompt cache, tokens out, credits as OpenRouter reports them, time, tool calls and pictures. The token line under the input box opens it — totals, a table per model, the recent requests — with CSV download and clear. A new conversation keeps it: the cost belongs to the project.

#### Ask about a part

Right-click a part, a wire or a net: "Ask the assistant about R1…" opens the panel with the question started — "About R1 (Resistor 4.7k): " — for you to finish.

#### Loaded when it is needed

Like the calculator, the assistant is a chunk of its own (39 kB brotli — client, conversation, tools, system prompt with the parts table generated from `BUILTIN`, panel) loaded when the panel opens. `app.ts` imports only its types; `check-bundle.mjs` checks that the system prompt and the OpenRouter client are not in the first-paint chunk. Conversations, memos and usage logs are kept per project in **a separate IndexedDB database** (`melange-ai`): adding a store to `melange` would mean raising its version, and the autosave's `indexedDB.open("melange", 1)` would then fail with a VersionError — the assistant would stop the circuit from being saved. Long conversations are summarized; requests of one conversation share an OpenRouter `session_id`, so they reach the provider holding the prompt cache (Claude and Qwen get cache markers, the others cache by themselves).

#### Simple mode and edit mode

Two buttons at the left end of the toolbar. **Simple** keeps the schematic, the assistant and the results: Parts and Properties are hidden and the bottom panel has only Waveform, Measure and Calculator; a failed run shows its reason in the waveform tab, where the Log tab would have. **Edit** is the full editor. Both remember themselves.

### Spatial index — what keeps the performance budget

Net extraction asks "is this point on this segment" for every segment. Scanning all points makes it **segments × points**, which is O(n²) on a 1,000-part sheet. Measured, it was:

| Parts | Before the index | After |
| --- | --- | --- |
| 100 | 5.2 ms | 1.7 ms |
| 500 | 77.1 ms | 5.6 ms |
| **1,000** | **321.8 ms** | **11.5 ms** |

In the browser, one real edit went **302 ms → 16 ms**, and the moment of dropping a part **349 ms → 22 ms**. The budget is 50 ms.

All coordinates are integers in units of 10 mil, so the cell number is integer division (`src/net/spatial.ts`). Only the cells a segment's bounding box touches need looking at, and in practice the candidates drop to **2%** of the total. For a horizontal or vertical wire the bounding box is a single row of cells, so exactly that row is examined.

Junction counting happens in the same pass — it is the same "is this point on a segment" question, and running it separately meant paying the same O(n²) a second time.

**A cell key collision cannot produce a wrong result.** After the candidates come back, the exact test is redone with an integer cross product, so a collision only costs a few more candidates. Still, to leave no room for quiet errors, tests check that **the result matches an exhaustive scan** over 300 random segments and three circuit sizes.

#### Past 1,000 parts — no strings in the hot loop

The index kept a 1,000-part sheet inside the budget, but the work grew past it: at 10,000 parts one edit spent 270 ms in net extraction, and most of that was building `"x,y"` strings, hashing them and splitting them back into numbers. Points now get integer ids, the union-find runs on an `Int32Array`, and integer coordinate pairs are hashed directly (`PairMap`) — a coordinate that is not an integer still falls back to a string key, so no input takes a different path to a different answer.

| Parts | Before | After |
| --- | --- | --- |
| 1,000 | 23 ms | 4.5 ms |
| 10,000 | 242 ms | 53 ms |
| 50,000 | 1,968 ms | 252 ms |

**The output did not change by a single character, and that is the hard part.** Automatic net names (N001…) are handed out in the order of each net's union-find root, sorted as the string `"x,y"`, and which point ends up as the root depends on the order the unions ran in. So point registration, the order the index hands out candidates, and the argument order of every union are kept exactly as they were. Sorting the roots was a third of the remaining time; it now sorts numbers — the rank of each distinct coordinate's string — which gives the string order without building a string per net (`","` sorts before every digit, so the shorter x wins the way the string comparison would). `tools/verify-extract.ts` keeps the old implementation frozen in `tools/ref/` and compares everything — pin nets, net point lists in order, junctions, loose ends, warnings, the coordinate→net lookup — on the demos and 400 random sheets built to collide (T-junctions, crossings, coincident pins, `out`/`OUT` labels, off-grid points).

`ex.nets` is now built the first time something reads it. Nothing on the edit path does any more — the pre-run check and the status bar ask `netSize()` and `netCount`, which come out of the union-find directly — so an edit no longer allocates an array per point just to count them.

### Only what changed — the sheet index

Even with fast extraction, an edit on a large sheet paid for everything on the sheet several times over: extraction on every commit, a full scan of every part and wire on every mouse move (snap candidates and hit testing), `Array.find` for every selected object, and a sorted, indented JSON of the whole project two seconds after each edit.

`src/doc/sheet-index.ts` compares the sheet with its previous state on every commit — **by reference, not by value.** Commands never edit coordinates in place; they swap in new arrays (`history.ts`), so an unchanged reference means an unchanged shape. Only the objects that changed are taken out of a 160-unit grid and put back. From that:

| | Before | Now |
| --- | --- | --- |
| Edits that touch no connection (value, designator, no-connect mark, probe, note) | full net extraction | **skipped** — the previous result is reused |
| Snap candidates and hit test on every pointer move | every part and wire | the cells around the cursor |
| Box select, "which pin is here", wires attached to a dragged part | every object | the cells the box covers |
| Finding the selected objects by id | `Array.find` per object — select all + delete at 10,000 parts: 549 ms | an id table, checked against the array on every hit |
| Autosave | sorted, indented JSON: 102 ms at 10,000 parts, 537 ms at 50,000 | plain `JSON.stringify`: 15 ms and 69 ms — key order does not matter for reading it back |
| Netlist / issues / waveform tab on every edit | rebuilt immediately | rebuilt once the edits stop (120 ms) |

Measured in the browser on the 1,000-part reference scene scaled up:

| Parts | Pointer move before → now | One edit (draw a wire) before → now |
| --- | --- | --- |
| 10,000 | 5.9 ms → 0.0 ms | 290 ms → 115 ms |
| 50,000 | 27 ms → 0.0 ms | 1,661 ms → 560 ms |

Hits come back from the grid in no particular order, so they are sorted by their place in the sheet before the old rules run: the topmost object still wins, and a tie between snap targets still goes to the same one. `tools/verify-sheet-index.ts` runs 600 random edits (commands, undo, redo) and checks after each that a box query matches an exhaustive scan, that every "connections unchanged" verdict really leaves the extraction identical, and that every moved object is reported as changed.

Two bugs came out of this, both quiet:

- **Undoing a multi-delete scrambled the order.** `removeObjects` recorded each object's position in an array that was shrinking as it went, so deleting A and C from [A, B, C] and undoing gave [A, C, B]. Order decides automatic net names, so an undo could hand back a different netlist. It now records positions in the original array and merges them back in one pass (which is also what took select-all + delete + undo off S × N).
- **Cancelling a drag left things moved.** A drag moves objects directly, without a record, and builds one command when it ends. A second finger landing (pinch) dropped the drag without putting anything back, and Esc during a drag cleared the selection so the release had nothing to restore — either way the parts stayed where they were, in a state undo could not reach. Both now restore the starting shape.

#### Edits that do change connections — incremental extraction

Extraction is now two steps (`src/net/extract.ts`): **building the inputs** — a number for every coordinate (hashing), for every wire the points that sit in the middle of its segments (spatial queries), the `"partId:pinId"` strings — and **solving** — replaying the unions, naming, building the results. The expensive step is the first one, and one edit barely changes it. `src/net/incremental.ts` keeps the inputs per object (on the sheet index's entries) and rebuilds only those of the objects the index reports as changed. Each point counts how many objects use it; when a point appears or disappears, only the wires whose segments pass through it look for their middle points again.

**Solving still starts from scratch, on purpose.** Automatic net names follow the order of the unions across the whole sheet, so one new wire can renumber every net after it — there is no local answer. But solving is now arrays of integers only, no hashing and no strings (the auto names come from a cache), and **it is the same function the full extraction uses**, so the two cannot drift apart. `tools/verify-incremental.ts` runs 700 random edits — commands, undo, redo, a replaced document, a broken document with a duplicated id — and after every one compares the incremental result with a full extraction: pin nets, net point lists in order, junctions, loose ends, warnings, lookups, floating pins. All identical; outside of a replaced or broken document, every edit was incremental.

The pre-run check's "floating pin" test used to count pins per net name through a map built from every pin and every net — 100 ms per edit at 50,000 parts. Solving now answers it directly from the union-find (`ex.floating`); `tools/verify-extract.ts` checks that the issue list is the same, line for line, as the old way of counting.

Large scratch arrays (the union-find, branch counts, pin lists) are reused between edits. Allocating them fresh threw away tens of megabytes per edit at 50,000 parts, and the garbage collector then stalled the next frame by around 100 ms.

| Parts | Full extraction | Index sync + incremental update |
| --- | --- | --- |
| 10,000 | 47–57 ms | 21 ms |
| 50,000 | 220–250 ms | 130 ms |

Where the whole edit path ended up, in the browser (drawing one wire, median of six; the frame is the next one, which redraws):

| Parts | Edit, at the start of this work → now | Next frame → now |
| --- | --- | --- |
| 1,000 | 35 ms → 8 ms | 9.7 ms → 5.5 ms |
| 10,000 | 290 ms → 65 ms | 61 ms → 6.4 ms |
| 20,000 | 559 ms → 98 ms | 115 ms → 16 ms |
| 50,000 | 1,661 ms → 242 ms | 421 ms → 28 ms |

What is left in an edit at 50,000 parts is the work that is global by nature: replaying the unions and renaming every net (sequential names shift when a net appears early in the order), the pin-to-net map that the netlist and the pre-run check read, and the rest of the pre-run check.

### The static layer on WebGPU

The old renderer drew every part and wire with Canvas 2D on every pan and zoom. It drew off-screen objects too, text included — so zooming in until a few dozen parts were visible was 3–7× *slower* than seeing the whole sheet, because every designator and value on the sheet still went through `fillText`. That is not a GPU problem, and the profile said so: at 10,000 parts the time was in `drawPart`, `toScreen`, `stroke` and `fillText` calls, not in pixels.

So the screen is now three canvases:

| Canvas | What | How |
| --- | --- | --- |
| `static` | grid · wires · symbol lines and circles · pin dots · no-connect X · junctions | **WebGPU.** Geometry lives in GPU buffers in world coordinates; panning and zooming rewrite one uniform |
| `text` | designators · values · pin names · labels · net names · notes · directive blocks · probes · loose-end marks · net highlight | Canvas 2D, **only what is on screen** (asked from the sheet index) |
| `overlay` | hover · selection · snap · previews | Canvas 2D, as before — but a large selection skips what is off screen |

**Geometry is three shapes** (`src/render/scene.ts`): segments (both ends in world coordinates, plus a pixel offset for the no-connect X), discs (pin dots, junctions — radius in screen pixels), rings (symbol circles — radius in world units, stroke in pixels). Widths grow with zoom exactly like the old `lw()` — `k = max(1, min(scale/2, 2))` — and that factor is applied in the shader, so the buffers do not change when the zoom does. Each segment is one quad; the fragment shader measures the distance from the pixel centre to the segment, which gives round caps, round joins where segments meet, and antialiasing in one step. Blending is premultiplied alpha into a non-sRGB texture, the same space Canvas 2D blends in, so the glass plate behind the canvas shows through as it did. Grid dots have no buffer at all: the vertex shader places them from the instance number. The old code called `fillRect` once per dot — 30,000 times a frame at a zoom of 0.5.

**Only what changed is rebuilt.** Parts and wires live in chunks of 1,024. The sheet index reports which objects changed on a commit, and only their chunks are re-emitted and re-uploaded. During a drag, the moving objects are taken out of their chunks once and drawn from a small buffer rebuilt every frame — dragging one part on a 50,000-part sheet does not touch the other 49,999.

**The same shapes, checked two ways.** `tools/verify-scene.ts` draws every built-in part with the old `drawPart` into a fake canvas that writes down its path (`moveTo`, `lineTo`, `arc`, `closePath`, widths) and compares it with the new shapes projected to the same screen — 16 parts × 8 rotations/mirrors × 4 zooms, 512 cases, to 1/1000 px (the GPU buffers are Float32, which moves the last digits of the inductor's curve). It also runs 300 random edits and checks that rebuilding only the dirty chunks gives the same shapes as rebuilding everything, and that dragged objects leave their chunks and come back. Then the pixels: the nine demos at three zooms, screenshotted from the Canvas 2D build and the WebGPU build — mean difference ≤ 0.12/255, at most 0.6% of pixels more than 8/255 apart, all on antialiased edges.

**PNG export draws the same shape list** with Canvas 2D (`drawScene2D`) and the same text functions. What is drawn is decided in one place; only the rasterizer differs. The old rule — a separately written export path ends up missing something — still holds.

Main thread per frame, headless Chromium, the reference scene scaled up:

| Parts | Pan, zoomed out (scale 0.25) | Pan, zoomed in (a few dozen visible) | Frame after an edit |
| --- | --- | --- | --- |
| 1,000 | 2.2 → 0.7 ms | 5.4 → 0.4 ms | 9.7 → 1.8 ms |
| 10,000 | 15 → 1.2 ms | 52 → 0.5 ms | 61 → 3.7 ms |
| 20,000 | 25 → 1.5 ms | 111 → 0.5 ms | 115 → 10 ms |
| 50,000 | 66 → 2.1 ms | 441 → 0.5 ms | 421 → 40 ms |

Pan cost no longer follows the size of the sheet: zoomed in it is the same half millisecond at 1,000 parts and at 50,000.

**WebGPU is required.** It ships in Chrome and Edge (113+, Android 121+), Safari 26, and Firefox 141 on Windows and 145 on Apple Silicon. Where it is missing (Firefox on Linux and Android at the time of writing), the canvas says so instead of staying blank. If the device is lost (a driver reset), it is recreated and every buffer re-uploaded; if it keeps getting lost, it stops trying and says why.

**Measuring without a GPU.** A headless browser with no GPU runs WebGPU on SwiftShader, and in this one the device is lost the moment a WebGPU canvas is presented — a minimal page that only clears a canvas loses it too. So there are two diagnostic targets: `?gpu=readback` draws into a texture and copies the pixels into the canvas through 2D (the screenshots above), `?gpu=offscreen` draws into a texture and stops there (the frame times above — main-thread cost only; the GPU work is in another process).

### Simulation on bigger circuits — save less, pick the solver, draw what can be read

Moving ngspice to the GPU is not on the table: WGSL has no double precision, the time goes into device models (BSIM4 is thousands of lines of branchy C), and Newton's loop needs the result back on the CPU every iteration. What was measured instead, with the same engine in Node:

| Circuit | Everything saved (before) | Only what is shown |
| --- | --- | --- |
| RC ladder, 10,000 stages | 23.9 s, 155 MB of results, 1.8 GB resident | 6.2 s, 0.5 GB |
| SKY130 inverter chain, 300 stages (600 BSIM4) | 29.1 s, 2,105 vectors, 1.1 GB | 24.4 s, 0.5 GB |

**Without `.save`, ngspice keeps every node voltage and branch current** at every time point, and all of it is copied three or four times on the way out (engine vectors → `out.raw` → JS arrays → `Float64Array`), inside a WASM heap that ends at 2 GB. The run netlist now ends with `.save` lines (`savePlan` in `src/net/netlist.ts`):

- **Top-level node voltages only, by default.** Each SKY130 device is a subcircuit that brings six internal nodes per inverter; the waveform panel already threw them away. Probing after a run still draws without re-running (E24), because every top-level net is still saved.
- **Whatever `.meas` reads** — `v(a)`, `v(a,b)`, `vdb(x)`, `i(V1)`. Leave one out and the measurement fails.
- **On a circuit with 2,000 nets or more and probes placed, only the probed nets** — and the log says so, since probing another net then needs another run.
- **Nothing is cut when it cannot be known what is needed:** a directive block with device lines (nodes the schematic does not have), a block that sets output itself (`.save`, `.probe`, `.control`, `.meas` …), a `.meas` with `par()`, and the DC operating point (one point, and its table shows branch currents).

The exported `.sp` does not get these lines — desktop ngspice keeps saving everything. `tools/verify-save.ts` pins the rules, and `tools/e2e.ts` runs every demo with and without them: every voltage the panel draws is **identical to the bit**, and the vector count drops (SKY130 inverter 12 → 4).

**KLU when it wins.** The binary has KLU as well as the default Sparse 1.3. It is not faster on everything:

| Circuit (two nodes saved) | Sparse 1.3 | KLU |
| --- | --- | --- |
| SKY130 inverters, 100 stages (200 devices) | 6.5 s | 6.5 s |
| SKY130 inverters, 300 stages (600 devices) | 24.4 s | 22.2 s |
| SKY130 inverters, 500 stages (1,000 devices) | 46.3 s | 39.8 s |
| SKY130 inverters, 1,000 stages (2,000 devices) | 162.7 s | 101.5 s |
| RC ladder, 10,000 stages | 6.2 s | 7.1 s |
| Level-1 CMOS inverters, 1,000 stages | 11.3 s | 11.8 s |

It pays off with many subcircuit devices (each brings internal nodes), so the run adds `.options klu` from 400 SKY130 devices up; smaller circuits keep the default solver and their results to the last digit.

**The waveform draws what can be read.** With no probes it used to draw every node: on a 1,000-stage ladder, 1,001 lines redrawn on every cursor click (217 ms) behind a legend that filled the panel. It now draws up to 40 and says how many there are ("40 of 1,002 nodes — probe the ones to show"). A line with far more points than the plot has pixels is reduced to the first, lowest, highest and last point of each pixel column, which covers the same pixels. The value range and the sine fit for the legend are computed once per result instead of on every redraw.

In the app, run to waveform and one cursor click:

| Circuit | Run → waveform | Cursor click |
| --- | --- | --- |
| RC ladder, 1,000 stages | 2.64 → 2.52 s | 217 → 4 ms |
| SKY130 inverter chain, 300 stages | 33.3 → 27.6 s | 45 → 6.5 ms |

### Wires that follow a moved part (E09)

Move a part — drag, arrow keys, align, rotate, flip — and the wires on its pins come along. The first version stretched each wire: it kept the shape and added one corner so the end could reach the pin. One move looked fine, but **corners piled up move after move**, and walking a part around in a circle left the wire folded back over itself. Worse, after two drags (down, then right) the stretched wire ran straight through the resistor's body and **across its other pin** — a pin in the middle of a segment is a connection (rule 3), so the resistor was quietly shorted while the drawing still looked plausible. Rotating did not take the wires at all, so a rotated part was simply disconnected.

**Now the moved stretch is routed again instead of being patched.** Each attached wire is cut at the points that must not move: wherever something else is connected — another wire's end or corner, a part that is not moving, a net label, a probe, a manual junction. The part between the moving pin and the nearest such point is thrown away and found again as a **shortest right-angle path on the grid** (A*; cost = length + 3 per corner, plus a small penalty for leaving or entering a pin from the side). The rest of the wire is left exactly as drawn, so labels stay on their nets.

The search refuses every step that would change the netlist:

| May not | Because |
| --- | --- |
| pass a pin, a wire corner, a label, a junction or a probe | a point on a segment is a connection (rules 2, 3) |
| run along another wire | the two wires' ends land on each other — connected |
| turn on top of another wire | the corner lands in the middle of that wire — connected |
| cross a part body or a pin lead | ugly, and a lead crossing reads as a connection; allowed only as a last resort (below) |

Crossing another wire at a right angle is allowed (rule 5: a plain cross is not a connection). If a rotation leaves no clean path — the junction next to an op-amp boxed in on four sides — a second search may cross a part body at a high cost, never a pin. If even that fails the wire stays where it was: a visibly open pin (○) is better than a silent short.

When several wires meet at the moved pin, the junction stays where it is and **only one wire is extended** to the pin. Extending each of them gave two parallel paths between the same two points — a loop.

| | Result |
| --- | --- |
| Every part of every demo (85 parts in 11 circuits) rotated 90° four times — 296 turns | connectivity identical after every turn, no fold-backs, no wire longer than it started |
| The RC filter's R1 turned a full circle, or dragged around a square | back to exactly the original wires |
| 1,578 random moves and rotations on the demos | connectivity identical whenever no pin was put down on something that stays |
| Drag frame, 1 part / 100 parts / 1,000 parts on a 10,000-part sheet | 0.1 / 1.0 / 2.7 ms (median) |

Every frame of a drag is still computed **from the shape at the start of the drag**, never from the previous frame, so dragging back to where you started gives back the original wires. Wires inside the selection move with it and are not stretched (design doc spec 5).

### The grid — a dot on every snap step

Parts, pins and wire corners snap to a 100 mil step, and **every step has a dot**, so a placed pin always lands on one. The dots used to be 1 px and faint, and the only marks you could really see were the bold ones every ten steps — which made pins look as if they landed between grid points. The dots are now darker and grow with zoom (1 → 1.5 → 2 px from 12 and 24 px spacing), and a bold dot marks **every fifth step**, close enough to count by eye. Below 6 px spacing the small dots are left out (they would turn into a mesh) and only the bold ones remain. Every dot sits centred on its grid point, rounded to device pixels so it stays sharp on high-DPI screens.

### No-connect marks and supply symbols (E05 · E07)

A pin with a no-connect mark is left out of the "floating pin" warning, and on export **a 1 TΩ resistor from that node to 0** is added automatically (`R_nc1 n002 0 1T`). Even a deliberately unconnected pin fails in ngspice as a floating node if it is alone on its net. The name starts with an underscore so it cannot collide with a user designator.

Supply symbols with the same name are one net. If a net also carries a net label, **the net label wins** — a name attached right there is a more specific intent than a wide-reaching name like VCC.

### Autosave (E19)

It saves to IndexedDB two seconds after an edit, and <kbd>Ctrl</kbd>+<kbd>S</kbd> saves immediately. Leaving the tab flushes whatever is pending. Refresh and the circuit you were drawing is back.

It is not `localStorage` because the project library carries copies of part definitions and can grow to several MB. **Editing continues even if saving fails** — in private mode or when storage is full, IndexedDB simply throws, and losing the circuit you are drawing over that is not acceptable. The status is reported in the toolbar and that is all.

### Voltage probes (E24)

Press <kbd>P</kbd> to put one on a net. The net at that spot is not stored but recomputed from the coordinates every time — a net is a value derived from geometry, so it has to follow when the wiring changes.

With probes placed, only those nets are plotted; with none, every node voltage is. The trace color matches the probe color, so you can tell which line is which without the legend. The whole result is kept, so **probing after a run draws immediately without re-running.**

### `.sp` in and out (E22 · E23 · E28)

An exported file runs as is in ngspice, and reopening it restores the schematic too.
(One exception: a circuit with SKY130 parts. The models are ours at run time, so the export
carries a commented `.lib` line to point at your own PDK instead of a path only this app knows.) The schematic restore data goes into `*@` comment lines, which SPICE does not read, as base64.

```spice
* RC lowpass demo
*@sch-begin v1 body=18b41846dbaecc33…      <- SHA-256 of the body
*@ ewogICJmb3JtYXRWZXJzaW9uIjogMSwK…       <- project JSON, 76 chars per line
*@sch-end
V1 in 0 SIN(0 1 1k 0 0 0)                  <- from here to .end is the "body"
R1 in out 1k
C1 out 0 100n
.tran 10u 5m 0 10u
.end
```

The body hash is there to notice when someone edits only the netlist in a text editor. On a mismatch it asks whether to restore the schematic or use the changed text.

Line order is sources → passives → controlled sources → semiconductors, and within a kind by designator number, so the same circuit always produces the same file.

**Two things that bit while handling SPICE text** — both of the quietly-wrong-result kind.

1. **ngspice does not stop at `.end`.** The manual says it ends there, but in practice it keeps parsing the following lines and dies with `unknown device type`. We cut the file ourselves when reading.
2. **SPICE always reads the first line as the title and discards it.** Hand it the body alone and the first device line is eaten as the title and disappears — the circuit runs broken and produces something unrelated like `singular matrix`. Not a wrong value but a different circuit, which makes it hard to notice. `runnable()` adds the title line.

### Verification

`npm run verify` runs these without a browser.

| | What |
| --- | --- |
| Sine fitting | amplitude ±1%, phase ±1° on uniform and non-uniform samples |
| `.meas` reading | name extraction, the engine's real output as a fixture, names that prefix each other, repeated runs, failure reason, number formatting |
| Message classification | notices vs real errors, empty-result verdict, splitting lumped lines, **a failed measurement is not a failed run** |
| Snapping | hysteresis · tier priority · radius clamping |
| Command pattern | apply→revert restoration for 11 commands, batching, undo/redo, selection restore, step size |
| Transforms | pins on the grid for 8 parts × 5 transforms, mirror images, renderer and pin coordinates agreeing, batch transforms |
| Wires that follow | the router never steps on a pin, wire, corner or body; every demo part rotated a full turn and 1,578 random moves with connectivity unchanged; full turns and round trips give back the original wires; T-pins; segment removal |
| Align · distribute · renumber | axis alignment, grid kept, end-fixed distribution, per-prefix numbering, reading order |
| External .sp → schematic | device and model conversion, preserved lines, auto-placement, **running both the original and the conversion and comparing** |
| Analysis kinds | `.tran .op .dc .ac .noise .tf` lines, AC magnitude spec (and the `AC 1` a noise input needs), complex→magnitude·phase, opening old files |
| Spatial index | identical to an exhaustive scan (300 random segments · 3 circuit sizes), cell borders, negative coordinates |
| Net extraction equivalence | the rewritten extractor against the frozen old one (`tools/ref/`) on the demos and 400 random colliding sheets — names, order, junctions, lookups |
| Sheet index | 600 random edits with undo/redo: box queries equal an exhaustive scan, "connections unchanged" never hides a changed extraction, every moved object is reported |
| Static-layer shapes | every built-in part against the old `drawPart` path (512 cases), chunked rebuild equals a full rebuild over 300 random edits, drag in and out of chunks |
| Run-time `.save` | the default, `.meas` vectors, large-circuit probing, the cases that must not be cut (device lines in blocks, user output directives, `par()`, `.op`) |
| Incremental extraction | 700 random edits (commands, undo, redo, replaced and broken documents): every result identical to a full extraction, every ordinary edit incremental |
| Unfinished spots | finding floating pins and broken wire ends, they disappear when connected, touching pins and labelled ends excluded |
| Junction cleanup | a vanished crossing is removed in the same step and comes back on undo |
| No-connect · supplies | warning exclusion, the 1 TΩ ground line, supply symbols grouping, net label > supply symbol priority |
| Voltage source checks | catching direct parallel and shorts, blocking even with equal values, series passes |
| .model | only models in use · deduplicated · ordered, name collision check (case-insensitive) |
| Net extraction | connection rules 1 · 2 · 3 · 5 · 6 · 7 · 8 individually, probe coordinate→net, pre-run checks, serialization round trip |
| `.sp` I/O | line order · names · node rules, round-trip restore, body tamper detection, reading external `.sp`, engineering units |
| Component library | every part listed once with a description, pin legs, search, multi-line netlists, the input-only-net and range checks, each new part through ngspice against hand calculation, the stall guard — including a run ngspice ends itself (`fatal error in ngspice, exit(1)`), which used to leave the app at "Running…" |
| Assistant client | streamed tool-call fragments with and without an index, a thinking model's reasoning blocks kept whole, keep-alive lines, a non-streamed answer, an error mid-stream, retries on 429/5xx, cache markers only where they apply and a refused `cache_control`/`session_id` dropped and sent again (35 checks, a fake fetch) |
| Assistant tools | an RC low-pass drawn from nothing with the tools, one request undone to the byte, 300 random connects with no other connection changed, placement away from nets, argument checks that change nothing, analysis · `.meas` · directive rules, the summary, the log of hand edits, merging a netlist (renamed designators, joined nets, the title line), renaming and highlighting nets, the picture tools offered only to models that read images, their argument checks (90) |
| Assistant conversation | a scripted model through the request loop: tool results in order, one undo step, hand edits reaching the model between requests and mid-request, the step limit, broken arguments, stop with no tool call left unanswered, conversations kept per project, summarizing, the usage log, no scan of the circuit on a hand edit, tool pictures sent after the tool results and dropped when the answer ends, attached photos kept for the session but never saved, a text-only model refusing them, the project memo — updated only after requests that changed or simulated something, sent to new conversations and after your edits, your edit winning over one in flight (61) |
| Calculator | the expression grammar, every function against a closed form on uneven samples (statistics, crossings, step response, FFT and harmonic fits, one- to three-pole frequency responses, noise integrals, DC transfer), the device table per model family, sign conventions, what gets saved for which analysis, kept runs, all 94 metric entries evaluated on a result of each analysis they claim |

`npm run e2e` builds **all eleven demo circuits** in code, extracts netlists, runs them through ngspice and matches the expected values. The circuit definitions come from the same module the app's demo buttons use (`src/lib/demos.ts`) — kept apart, the tests pass while the screen shows a different circuit. It then takes the same RC circuit and **switches the analysis kind**, running the operating point, a DC sweep and AC, checking that the capacitor is an open circuit at DC and the −45° at the corner frequency. It then puts four `.meas` lines on that circuit — one of them deliberately out of range — and checks the measured values against hand calculation, that the failed one comes back with its reason, and that **the waveform survives it**. Finally it biases a BJT and a MOSFET to see whether the `.model` coefficients reach the engine intact — a missing model line kills ngspice outright, but a coefficient in the wrong slot **still runs, as a different device**. Last, it runs every demo again with the run-time `.save` lines and checks that every voltage the panel draws is identical to the bit.

| Measurement | Value | Expected | Error |
| --- | --- | --- | --- |
| RC low-pass amplitude | 0.8467 V | 0.8467 | 7.9e-5 |
| RC low-pass phase | −32.1503° | −32.1419 | 0.0084° |
| Inverting amplifier amplitude | 1.0000 V | 1.0000 | 2.2e-16 |
| Inverting amplifier phase | 180.0000° | 180.00 | 0 |
| Operating point v(out) | 0.000000 V | 0 | 0 |
| DC sweep v(out) − swept value | 0.000000 V | 0 | 0 |
| AC \|v(out)\| @1591.5 Hz | 0.707107 V | 0.707107 | 1.8e-11 |
| AC ∠v(out) @1591.5 Hz | −45.000000° | −45 | 1.5e-9 |
| Half-wave rectifier peak | 9.287237 V | 9.287238 | 1.4e-6 |
| Half-wave rectifier reverse | −1.0e-8 V | 0 | 1.0e-8 |
| NPN βF = IC/IB | 100.0046 | 100 | 4.6e-5 (relative) |
| NPN IC = IS·e^(VBE/VT) | 8.204773 µA | 8.204694 | 9.7e-6 (relative) |
| NMOS ID (saturation) | 440.0000 µA | 440 | 1.1e-8 (relative) |
| Voltage divider v(out) | 1.598639 V | 1.598639 | 0 |
| RC step v(τ) | 3.160600 V | 3.160603 | 2.5e-6 |
| RLC \|H\| @peak | 0.999140 | 0.999140 | 2.2e-16 |
| RLC phase @peak | 2.376766° | 2.376766 | 3.0e-14 |
| CMOS inverter threshold | 2.500000 V | 2.5 | 2.0e-8 |
| CE active slope | −8.687983 | −8.688764 | 7.8e-4 |
| `.meas` v(out) at 5 ms | −0.4505379 V | −0.4504772 | 6.1e-5 |
| `.meas` 4th rising 0.8 V crossing | 3.286310 ms | 3.286159 | 1.5e-7 |
| `.meas` 0.1 → 0.8 V rise time | 178.1544 µs | 178.0355 | 1.2e-7 |

`npm run e2e` then runs `tools/e2e-calc.ts`: the calculator through the engine, against the textbook's own formulas — the table is under "The calculator" above.

Last, `tools/e2e-ai.ts` puts the assistant in front of the engine with no key: a scripted model draws an RC low-pass on an empty sheet with the tools alone (1 kΩ, 100 nF), sets an AC sweep, a `.meas` line and two calculator rows, and runs **real ngspice**. What comes back to the model is checked against hand calculation: the `.meas` cutoff is **1591.55 Hz** against 1/(2πRC) = 1591.55 Hz, the calculator's `f3db` row says 1.591 kHz and `dcgain` 1.000, and reading `v(out)` at the cutoff gives 0.7071 at −44.998°. One undo then takes the sheet, the analysis, the `.meas` line and the rows back to an empty project.

Only the transient demos measured by sine fitting get ±1% amplitude and ±1° phase. The rest, which must match hand calculation exactly, are tightened to 1e-12 – 1e-3, and where a tolerance is loose the reason is written down (the BJT current ratio cannot be tighter than ngspice's default reltol of 1e-3, and IC, with an exponential in it, is 25× sensitive to a difference in the constant).
Results are read through the same converter the worker uses (`toTraces`), so a change in the engine's output shape is caught here.

### Two things that matter in the design

**Amplitude and phase are measured by least-squares sine fitting** (`src/measure.ts`). Peak finding is off by up to half the sample spacing (a 10 µs step is 3.6° at 1 kHz), which is 1.80° worst case and exceeds ±1° for 39% of phase values. Fitting works directly on non-uniform samples and its error is around 1e-13°. The measurement window is 1–5 ms (exactly 4 periods, past 10τ with 0.002% of the transient left).

**Snap hysteresis is a score bonus for the current target, not an extended radius** (`src/feel/snap.ts`). Extending only the radius means never being able to move to another target in the same tier. A score bonus creates a dead band, which stops the jitter while still letting you cross to a nearer target. With a shaking hand at an ambiguous spot, snap flips over one second went **151 → 0**.

### Three things that bit in SPICE text

None of the three raises an error; all three produce **quietly wrong results**. They are the kind you cannot find without actually running the browser and the engine.

1. **ngspice does not stop at `.end`.** It keeps parsing the following lines and dies with `unknown device type`. We cut the file when reading.
2. **The first line is always read as the title and discarded.** Hand it the body alone and the first device line disappears, the circuit runs broken and raises `singular matrix`. The error message points somewhere entirely unrelated to the cause.
3. **Non-ASCII bytes in the title line misalign the result vectors.** With a Korean title, `time` comes back with length 513 (the data is 512) and carries current values instead of time inside it. No error. Export rule 8 in the design doc says "Korean may appear only in the title line", but in this engine even that does not hold — `asciiTitle()` blocks it, and non-ASCII names stay intact in the `.sp` restore data (JSON).

A model note: **the SKY130 models' `mult` does not multiply the device** — it only scales the mismatch statistics
(`sqrt(l*w*mult)`); ngspice multiplies a subcircuit with `m=`. The SKY130 parts write both (`src/lib/parts.ts`), and a
saved file gets `m=` when it opens (`normalizeProject`). Until then a Multiplier of 4 ran as one device, with no error.

An engine note: **calling `runSim` twice in a row on the same `Simulation` instance leaves the second one unresolved.** The app is fine because there is a gap between user actions, but the tests spin up a fresh engine per demo.

## Structure

```
src/doc/types.ts        Document model. 10 mil integer coordinates; pins and corners on a 100 mil grid
src/doc/units.ts        Engineering units (f p n u m k meg g t). In SPICE, M is milli
src/doc/route.ts        Shortest right-angle path on the grid that never makes a new connection
src/doc/follow.ts       Which stretch of an attached wire to route again when parts move or rotate
src/doc/history.ts      Command pattern and undo. The document changes only through here
                        Object references (kind:id) · geometric transforms (move/rotate/mirror) · multi-delete
                        Tags that group one assistant request into one step · analysis, .meas and calculator commands
src/doc/ops.ts          Commands the editor and the assistant share: new parts, moves and transforms with wires following
src/doc/wiring.ts       The assistant's geometry: pin to pin, pin to a named net, free spots, deletes — never a stray connection
src/io/sp.ts            .sp export/import, scanning an external .sp
src/io/store.ts         IndexedDB autosave. Editing continues even if saving fails
src/lib/parts.ts        Built-in parts (symbol + SPICE template + parameters)
src/lib/catalog.ts      Library contents: which part is in which library and group, descriptions, search
src/lib/demos.ts        Demo circuits. The app buttons and the automated tests share them
src/net/spatial.ts      Grid-hash spatial index. Takes the O(n²) out of net extraction
src/net/extract.ts      Net extraction. Union-find, integer cross product for "on this segment"
src/net/incremental.ts  Incremental extraction: inputs kept per object, the same solve as the full extraction
src/doc/sheet-index.ts  What changed since the last commit, and what is where (grid of object boxes)
src/net/netlist.ts      Netlist generation + pre-run checks
src/feel/profile.ts     The feel parameter table   ← every magic number lives here
src/feel/snap.ts        Snap decisions (priority + hysteresis)
src/feel/viewport.ts    World↔screen, cursor-anchored zoom
src/render/schematic.ts Canvas 2D drawing: text layer, overlay, export text
src/render/scene.ts     Static-layer shapes in world coordinates, chunked, rebuilt only where changed
src/render/gpu.ts       WebGPU renderer for those shapes (instanced quads, distance-field coverage)
src/measure.ts          Least-squares sine fitting
src/sim-log.ts          Sorts ngspice messages into notices and failures
src/sim-run.ts          Runs the engine, gives up when it stalls without a result, and runs again
                        without a saved vector the engine turned out not to have
src/sim-values.ts       Result vector conversion. AC complex into magnitude and phase
src/sim-client.ts       Talking to the worker: numbered requests, waiting for the answer, stopping
src/calc/parse.ts       The calculator's grammar: SPICE numbers, names read verbatim inside v() · i() · gm()
src/calc/wave.ts        Numbers and waveforms; interpolation, integrals, derivative, crossings on uneven samples
src/calc/ops.ts         Arithmetic on numbers and waveforms, real and complex, with the common units
src/calc/dsp.ts         FFT and windows, least-squares harmonic fit, power-law integration of noise
src/calc/funcs.ts       The 97 functions, each with its signature and one-line description
src/calc/devices.ts     Device table from the netlist; which operating-point names each model family has
src/calc/eval.ts        Evaluates rows over a run and kept runs; works out what the next run must save
src/calc/metrics.ts     The textbook metrics as expressions, filled with the circuit's own names
src/calc/format.ts      Engineering notation with units
src/calc/calc.ts        The calculator as one chunk — loaded on demand, not with the first paint
src/ai/openrouter.ts    OpenRouter: streamed chat with tool calls, retries, the model list, OAuth PKCE
src/ai/cache.ts         Prompt cache markers and the fields a provider refuses
src/ai/agent.ts         The request loop, hand edits passed on, pictures, conversations kept and summarized, the project memo
src/ai/circuit.ts       The circuit as the model sees it, and the diff of hand edits
src/ai/tools*.ts        The tools — reading, placing, wiring, values, analysis, merging netlists, running, results, pictures
src/ai/usage.ts         The usage log per project: calls, tokens, cache, credits, CSV
src/ai/prompt.ts        The system prompt; the parts table is generated from the library
src/ai/panel.ts         The assistant panel; src/ai/assistant.ts is the chunk loaded on demand
src/ui/icons.ts         Hand-drawn 16×16 toolbar icons
src/ui/library.ts       The component library window (Shift+F): libraries · parts · symbol, pins, SPICE lines
src/ui/calc-panel.ts    The Calculator tab: rows, results, the three pickers, kept runs, the reference sheet
src/ui/plot.ts          The calculator's plot: log axes, two y axes, values under the pointer
src/ui/glass.ts         Glass refraction (SDF normal map + feDisplacementMap)
src/sim.worker.ts       The ngspice worker. Results come back as transferables
src/app.ts              The M1-thin editor shell
```

Because every coordinate is an integer, connection tests are integer comparisons. A bug where floating-point error breaks a connection cannot structurally occur.

## Running it

```bash
npm install
```

```bash
npm run dev
```

`/` is the editor, `/spike-a.html` is the simulation spike, `/spike-b.html` is the feel spike.

```bash
npm run verify && npm run e2e && npm run typecheck
```

## Hosting

Every build output uses relative paths, so it drops straight into a GitHub Pages subpath.
The engine is a single-threaded build and does not use `SharedArrayBuffer`, so
**no COOP/COEP headers are needed** (verified with `crossOriginIsolated=false`).

### The bundle — 20 MB down to 37 kB

`eecircuit-engine` arrives as a single 19.4 MB .mjs. Opened up:

| What takes the space | Size | Why it is not needed |
| --- | --- | --- |
| spice.wasm base64 (browser path) | 7.8 MB | Pulled out as a separate file, it gets streaming compilation |
| spice.wasm base64 (node-only path) | 7.8 MB | Inside `process.versions.node`, so it **never runs in a browser** |
| GF180 · FreePDK · PTM process models | 1.5 MB | Other foundries. Nothing in the library uses them |
| SKY130 process models | 2.2 MB | Pulled out to a separate asset instead — see below |
| The actual engine wrapper | ~0.1 MB | |

Both sit inside ternaries and runtime branches, so a bundler cannot shake them out.
The `strip-inline-wasm` plugin in `vite.config.ts` removes them at build time —
it empties the base64 payloads, rewrites the engine's wasm loader to read the asset URL we hand it,
and finds the foundry models **by content** (not by minified variable name) to empty them.
`spice.wasm` itself is produced in `postinstall` by decoding the base64 (`tools/extract-wasm.mjs`).

| | Before | After |
| --- | --- | --- |
| Worker chunk (raw) | 20,185 kB | **76 kB** |
| First-screen JS (brotli) | ~3.6 MB | **37 kB** |
| spice.wasm (brotli) | in the bundle | 1.21 MB, **not fetched until you press Run** |
| Engine init | 170 ms | **77 ms** |
| To the first waveform | 660 ms | **143 ms** |

If you need the other foundry models, set `DROP_FOUNDRY_MODELS` to `false` in `vite.config.ts`.

`npm run build` finishes by running `tools/check-bundle.mjs` to confirm the base64 has not come back and that sizes are within budget. If the engine package changes shape in an upgrade, it is caught here. It also checks that the calculator is still a chunk of its own, fetched on demand (see "Loaded when it is needed" under the calculator) — the first-paint JS has grown with the editor since the table above was measured and is 101 kB brotli today, and the calculator's 35 kB stay out of it.

## License

The code in this repository is MIT ([LICENSE](LICENSE)). Third-party notices are collected in [THIRD-PARTY.md](THIRD-PARTY.md), which the build copies into `dist/` so it can be read from the deployed site too (Help → Licenses).

The deployed build **contains `spice.wasm`, ngspice compiled to WebAssembly.** BSD-family licenses require the copyright notice and warranty disclaimer to ship with binary redistribution, so this is an obligation, not a choice.
The engine bundle is [eecircuit-engine](https://github.com/eelab-dev/EEcircuit-engine) (MIT), and the [ngspice](https://ngspice.sourceforge.io/) inside it is **Modified BSD at the base with several licenses mixed in** — confirmed present in the binary we ship are KLU (LGPLv2) · numparam (LGPLv2+) · OSDI (MPLv2) · sparse (MIT) · XSPICE (public domain). The GPLv2 `xspice/icm/table` is not included. Versions and where to get the sources are written down in THIRD-PARTY.md.

**No EasyEDA code, icons, symbol graphics, part data or documentation text is used.**
That includes the component library window: its three-pane arrangement is a common one, and its
layout, wording, symbols and part descriptions were made for this project.
The generic semiconductor models (DGEN · QNGEN · MNGEN · DZGEN) are textbook values we wrote,
and the other library parts are SPICE primitives with defaults we chose.
The one vendor model deck that does ship is SkyWater's SKY130, under Apache-2.0, with its
notice intact — see [THIRD-PARTY.md](THIRD-PARTY.md). Every other foundry deck the engine
carries is stripped at build time.
