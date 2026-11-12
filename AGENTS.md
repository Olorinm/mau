# Mau

- Mau is the product composition of Agent Router, Agent Host and Agent Environment.
- Router owns accounts, channel connections, conversation routing and delivery.
- Mau owns environment profiles, Agent/environment binding, Host bootstrap and lifecycle coordination.
- Use component public package exports; do not import another repository's implementation paths.
- The console's React components live in `web/ui` (`@olorinm/agent-ui`, private, part of the `web` npm workspace); the console imports only its package exports.
- Preserve native execution, sessions, tools and approvals in Host and its kernels.
- Keep credentials, production addresses, environment IDs and operational state outside this repository.
- There are no Router provisioning aliases or compatibility routes.
- Verify separate distributable packages; distinguish fixtures from live cloud/model acceptance.

CI browser checks use the official Playwright image pinned by version and digest. Update its pin
together with `@playwright/test` and both lockfiles (`package-lock.json`, `web/package-lock.json`); keep the image-version/browser check before
builds and tests. Do not reinstall browser system dependencies during each CI run.
