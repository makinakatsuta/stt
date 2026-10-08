# STT build and verification

After changing source files, finish the task with the following steps:

1. If `main_wasm.go` changes, rebuild `docs/main.wasm` with `GOOS=js` and `GOARCH=wasm`.
2. Run the relevant regression tests. Preserve the existing Normal balance snapshot,Easy balance snapshots,hard balance snapshots.
3. Always rebuild the local Windows x64 executable from the latest sources, including JavaScript-only changes. `stt.exe` embeds the web assets and may be ignored by Git.
4. With `GOOS=windows` and `GOARCH=amd64`, run `go build -trimpath -o stt.exe main_server.go`.
5. Run `.\stt.exe --version` and confirm it succeeds before reporting completion.
