# Browser verification entry

This is the portable repository entry when the optional local `web-debug` Skill is absent. It does not install or reconstruct an archived Skill. Read applicable host/browser/GPU rules first, including the installed Chrome connection/recovery instructions before initializing browser control. Where the local Skill exists, follow its routing.

## Interactive work

Use the current supported browser tool and its returned documentation. Discover the actual browser/profile/tab; use a dedicated test tab and preserve other sessions' tabs. Confirm the intended checkout, scene and completed business state. If a connection fails, follow the installed connection/recovery workflow; do not bypass a failed connection with a custom CDP client, replace extensions or restart unrelated services. A login wall requires user action for that page; local validation can continue.

## Checked-in local acceptance

The repository provides `tools/verify/editor-smoke.mjs` and its shared library for controlled editor acceptance. On this Windows/NVIDIA host the required mode is headed with real hardware:

```powershell
pnpm run editor:smoke -- --headed
```

The default editor port is 5100. Confirm the existing server serves the intended checkout before running the probe. Preserve fixed port, host, strictPort and HTTPS/Tailscale settings. If the default probe Chrome profile or CDP endpoint is already owned by another session, do not kill it or delete its profile; use the supported interactive tool or stop that verification path and report the specific ownership conflict.

The probe can start a temporary server when necessary and manages its own test session. Do not start an unrecorded long-running replacement. For deliberately started persistent services, use detached execution and record working directory, log and exact stop method.

Verify `isSecureContext`, an actual hardware adapter and GPU/browser errors. Headless/SwiftShader runs cannot establish local visual quality. Do not add `--no-sandbox` or `--disable-dev-shm-usage` as a workaround on this host. Do not disable TLS validation globally or bypass browser interstitials through hidden APIs.

Use the actual visible scene for acceptance and distinguish programmatic input-hook coverage from the human UI route. Edit → Apply → Save → Reload and Play → Stop/resource cleanup are separate checks. Store screenshots and measured state with their revision and scope; build success or a canvas appearing is not sufficient acceptance.

See [the visual quality playbook](art/visual-quality-playbook.md) for scene matching and evidence discipline, and [P0 intake](32-P0-asset-intake-2026-10-05.md) for existing hardware validation boundaries.
