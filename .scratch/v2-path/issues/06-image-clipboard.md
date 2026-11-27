# Research: image clipboard in Tauri 2 on Windows

Type: research

## Question

Can a Tauri 2 app (WebView2 on Windows; Linux dev under WSL) write a PNG image to the system clipboard and read one back, so Editor Ctrl+C/Ctrl+X/Ctrl+V can exchange pixels with other apps? Compare the webview's async Clipboard API (ClipboardItem image/png in WebView2, permission prompts, secure-context needs), tauri-plugin-clipboard-manager (image support in v2), and Rust crates (arboard etc.): what each supports for write and read, transparency preservation (PNG vs CF_DIB alpha loss when pasting into other Windows apps), and the rough work to wire it up.
