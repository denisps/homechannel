# Apps Architecture Plan

## Goals

- Serve a minimal, auditable client: a small `index.html` and a testable `client.js`.
- Deliver apps over the WebRTC datachannel directly from the server.
- Make each app a self-contained Node.js module with a dedicated channel.
- Allow users to install their own apps on the server safely.
- Keep async execution and fault isolation as first-class concerns.

## High-Level Structure

- `client/index.html`
  - Minimal UI shell.
  - Loads `client.js` from the same origin.
  - Allows server public key input, optional embed, and storage in localStorage.
- `client/client.js`
  - Most UI and logic lives here for testability.
  - Loads app metadata from server.
  - Requests app bundles over the datachannel.
- `server/node_modules/`
  - Each app is a Node.js module (folder per app).
  - Provides an async entry that can be safely invoked.
  - Optional app-specific static assets (if needed for client rendering).
- Datachannels
  - Each app uses its name as its channel label.
  - A reserved `apps-control` channel provides the app list and metadata.

## App Packaging Model

- Each app is a self-contained Node.js module directory under `server/node_modules/<app-name>/`.
- Apps expose a single async entry point (e.g. `async run(context)`), no globals.
- Apps should be pure async and wrap logic in try/catch.
- Server should wrap app calls in try/catch or promise error handling, or dispatch via inter-process messages.
- Apps should not assume filesystem or network access unless explicitly allowed.
- Apps should define a minimal manifest with name, description, and optional client assets.

## Client Delivery Flow

1. Client establishes WebRTC connection.
2. Client requests app list over a control channel.
3. Server returns app list with metadata (name, version, size).
4. Client selects or auto-loads apps.
5. For each selected app, client opens a datachannel named after the app.
6. Server streams the app payload over the app channel.
7. Client loads the app payload into the UI runtime.

## Server Responsibilities

- Read enabled app names from server config.
- Validate that each app exists, is loadable, and has a valid manifest.
- Handle missing files or corrupted manifests without throwing; skip the app and return a structured error.
- Expose a control channel for listing apps and metadata.
- Serve each app payload over its dedicated channel.
- Enforce limits (max size, max apps, timeout, rate limiting).
- Optionally isolate apps in worker processes to reduce risk.

## Client Responsibilities

- Display and manage the app list.
- Fetch app payloads and trust the server-provided payloads.
- Load apps in a sandboxed runtime where possible.
- Cache app payloads if allowed.
- Keep `client.js` as the primary entry for logic and tests.

## App Isolation and Safety

- Apps should be invoked with strict async boundaries.
- Server app calls must be wrapped in try/catch, chained with a promise error handler, or isolated via inter-process messaging.
- App loading must not throw if files are missing or manifests are corrupted; surface a structured error and continue.
- Consider optional worker isolation (per-app worker or pool).
- Define a limited, explicit `context` API passed into apps.
- Log errors through structured error handlers, not `console.log`.

## Config Changes

- Add `apps` to server config, e.g. an array of app names.
- Allow per-app settings under a namespace for overrides.
- Add server-side limits for payload size, timeouts, and channel limits.

## Migration Plan (No Code)

1. Create `client/index.html` and move most logic to `client/client.js`.
2. Introduce `docs/APPS.md` (this document) and update related docs.
3. Add `server/node_modules/` folder and move existing apps into it.
4. Define an app manifest format and minimal server loader contract.
5. Add a control channel spec to `docs/PROTOCOL.md`.
6. Update tests to target `client.js` and app loading flow.
7. Add tests for server app loading, control channel, and app delivery.
8. Add tests for client app discovery, channel handling, and sandbox loading.
9. Ensure each app has its own focused test suite.

## Documentation Updates Needed

- `docs/ARCHITECTURE.md`: reflect app delivery over datachannels and app modules.
- `docs/PROTOCOL.md`: add control channel and app transfer messages.
- `docs/SECURITY.md`: app isolation, integrity checks, limits, and threat model.
- `client/README.md`: new client entry structure and audit flow.
- `server/README.md`: app config, install locations, and safety notes.
- `docs/FILE_SERVICE.md`: clarify relationship to apps (if still needed).
- `docs/TESTING.md`: add app-specific test expectations.

## Testing Requirements

- Server tests must cover app discovery, manifest validation, control channel responses, and bundle delivery.
- Client tests must cover app list handling, per-app channel setup, and sandbox loading flow.
- Each app must include its own tests for message handling and error paths.
- Tests must validate real behavior (responses, payloads, and errors), not just absence of exceptions.

## Decisions

- App payload format: ES module bundle.
- App integrity: trust server payloads (no extra verification).
- Worker model: per-app worker isolation.
- Client runtime: sandboxed iframe.
