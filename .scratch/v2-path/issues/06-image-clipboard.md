# Research: image clipboard in Tauri 2 on Windows

Type: research
Status: resolved

## Question

Can a Tauri 2 app (WebView2 on Windows; Linux dev under WSL) write a PNG image to the system clipboard and read one back, so Editor Ctrl+C/Ctrl+X/Ctrl+V can exchange pixels with other apps? Compare the webview's async Clipboard API (ClipboardItem image/png in WebView2, permission prompts, secure-context needs), tauri-plugin-clipboard-manager (image support in v2), and Rust crates (arboard etc.): what each supports for write and read, transparency preservation (PNG vs CF_DIB alpha loss when pasting into other Windows apps), and the rough work to wire it up.

## Answer

Yes: PNG with transparency can go to and come back from the Windows clipboard. Most robust: do it in Rust with the `arboard` crate (3.7), which writes the registered "PNG" format first and a correct alpha-carrying `CF_DIBV5` second (what Chromium/WebView2, Qt apps such as Telegram Desktop, GIMP 3 and Office read), with no focus, gesture or permission rules, and the data outlives the app. Copy/Cut = a Rust command compositing the selection with the existing pixel code, then `set_image`; Ctrl+V keeps the webview paste event (reads "PNG", also takes Explorer-copied files); a Rust `get_image` can back the Paste button. The webview Clipboard API works for writes but re-encodes premultiplied (faint-edge colour rounding) and needs `enable_clipboard_access()` to read without a prompt; tauri-plugin-clipboard-manager is an arboard wrapper that round-trips pixels through the bridge. Paint and Photoshop behaviour is unverified (closed source): a Windows hand test of paste targets plus copy-quit-relaunch-paste is needed before shipping.

Findings: branch `research/image-clipboard` (commit a3308f3), file `research/image-clipboard.md`. Never merged.
