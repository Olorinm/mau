# Mau

- Mau is the product composition of Agent Router, Agent Host and Agent Environment.
- Router owns accounts, channel connections, conversation routing and delivery.
- Mau owns environment profiles, Agent/environment binding, Host bootstrap and lifecycle coordination.
- Use component public package exports; do not import another repository's implementation paths.
- Preserve native execution, sessions, tools and approvals in Host and its kernels.
- Keep credentials, production addresses, environment IDs and operational state outside this repository.
- There are no Router provisioning aliases or compatibility routes.
- Verify separate distributable packages; distinguish fixtures from live cloud/model acceptance.
