# Triage: real clipboard Cut/Copy

Type: grilling
Status: resolved
Blocked by: 06

## Question

Verdict (v2 / v3 / rejected) for the Editor's real clipboard: Ctrl+C copies the selected pixels (or the selected layer) to the system clipboard as PNG, Ctrl+X does the same and leaves a transparent hole, so stickers move between sessions and apps. Includes whether paste from the system clipboard comes with it.

## Answer

Owner verdicts (2026-11-27): **v2**, about 1.5 sessions in all (rough). Built on [Research: image clipboard in Tauri 2 on Windows](06-image-clipboard.md): Rust `arboard` writes the registered "PNG" format plus an alpha-carrying `CF_DIBV5`; Ctrl+V keeps the webview paste event.

- **Ctrl+C** (new): with a drawn selection, copies the pixels inside it from the one selected layer it touches (Cut's source rule; text layers allowed, rasterised without changing the layer); with no selection, the selected layer(s) flattened into one image as they look on the canvas (scale, rotation, effects); with nothing selected, disabled with the reason as its tooltip.
- **Ctrl+X becomes a standard cut**: the pixels go to the clipboard (as Ctrl+C) and leave a transparent hole; no new layer.
- **The in-app Cut button is renamed "Lift to new layer"** ("Lift" where space is tight). It keeps today's behaviour and does not touch the clipboard: one undo step, the new layer directly above its source at the same spot, with the source's native pixels and its scale and rotation. Its shortcut becomes **Ctrl+Shift+J** (Photoshop's "Layer via Cut"; free in the Editor). The lifted layer is named **"Lifted"** (was "Cutout"), telling it apart from "Pasted image" in the layer list. Owner's rationale: name the two routes apart so the one-step, fidelity-keeping Lift stays available beside standard cut-and-paste; its tooltip states the differences (one step, stays above its source, clipboard untouched).
- **In-place paste**: when the clipboard still holds the app's own last copy, Ctrl+V lands in place using an internal copy (native pixels plus the source's transform), so Ctrl+X then Ctrl+V matches Lift's result except for two undo steps, the name "Pasted image" and the position on top of the stack. Any other clipboard image (another app, or after the clipboard changed) is decoded from the PNG and lands centred, as today.
- **Paste button reads through Rust** (`arboard` `get_image`), no longer depending on the webview allowing clipboard reads. Ctrl+V keeps the webview paste event (it also takes files copied in Explorer).
- **"Copy image" in the Pack Manager** (~0.25): copies the selected sticker's image to the clipboard, from the detail panel and the v2 right-click menu (see [Triage: Pack Manager interactions](01-pack-manager-interactions.md)), through the same Rust command.
- **Before shipping**: an owner hand test on Windows: paste into Telegram Desktop (semi-transparent edges), a browser, GIMP, Windows 11 Paint (Photoshop if available), and copy, quit, relaunch, paste.
