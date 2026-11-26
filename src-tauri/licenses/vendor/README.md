# Vendored licence texts (SPM-29)

Committed so `bun run licenses` regenerates `../THIRD-PARTY-NOTICES.txt`
offline. Replace these (and update the version line below) when the pinned
ONNX Runtime changes (the `ort` crate's `ort-sys` build script names the
version, `ms@<version>` in its `dist.tsv`).

ONNX Runtime version: 1.31.0

`scripts/licenses.mjs` reads the version from the line above for the ONNX
Runtime heading and fails if it is missing. When refreshing the texts, update
that line and the provenance table below together.

| File | Source | Version |
|---|---|---|
| `onnxruntime-LICENSE` | `onnxruntime/LICENSE` inside Microsoft's official `onnxruntime` wheel on PyPI (`onnxruntime-1.31.0-cp312-cp312-win_amd64.whl`, https://pypi.org/project/onnxruntime/1.31.0/) | ONNX Runtime 1.31.0 |
| `onnxruntime-ThirdPartyNotices.txt` | `onnxruntime/ThirdPartyNotices.txt` from the same wheel | ONNX Runtime 1.31.0 |
| `isnet-dis-LICENSE.txt` | `LICENSE.md` of https://github.com/xuebinqin/DIS (Apache-2.0, branch `main`) | n/a |

Why the wheel: pyke's prebuilt archive that `ort` downloads
(`https://cdn.pyke.io/0/pyke:ort-rs/ms@1.31.0/...tar.lzma2`) holds only
`libonnxruntime.a`, and `github.com/microsoft/onnxruntime` was not reachable
when this was vendored. The files are byte-for-byte as shipped (CRLF line
endings); the generator normalises them to LF.
