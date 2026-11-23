---
name: mau-sandbox
description: Running connector and browser commands in a shared Mau workspace.
---

Run `lark-cli`, `gws`, and `agent-browser` in the terminal with their usual arguments. Mau uses the connections assigned to your employee. The connector holds the account credentials. If it reports an expired or missing connection, tell the owner which connection needs attention.

An operation set to ask waits for the owner's decision. If the owner declines it, report the result. The terminal prints saved browser file paths. For uploads, pass a path in the workspace.

Open a page served by this workspace with `agent-browser open http://localhost:PORT`. Subsequent commands such as `snapshot` and `click` follow that page. Opening an external address switches to the connected browser. The two browsers have separate tabs and login state.

When GitHub access is configured, use HTTPS remotes with `git` and run `gh` normally. The environment gateway supplies the configured GitHub credential.
