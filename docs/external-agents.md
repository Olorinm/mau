# Connect an agent on your computer

A partner can be an agent that is already installed on your own computer (Windows, Linux or macOS) instead of one
Mau runs in a cloud environment. Your computer runs Agent Kit's Host, pairs with the partner once, and from then
on connects to your Mau service by itself; nothing connects to your computer from outside.

Mau does three things with such a partner: it sends it messages, takes its replies, and passes its requests for
approval to you. Its kernel, model, permissions, memory, skills and files are its own.

A service offers this only when it runs with Agent Kit's host links. One that does not answers
`external_partners_unavailable` (HTTP 503), `GET /_mau/v1/options` says `"external": false`, and the console's
"My computer" choice is disabled.

## Steps

```sh
mau partner create laptop --external --duty "Works on my laptop"
```

The answer has the partner and, once, its pairing:

```json
{
  "agent": { "id": "…", "name": "laptop" },
  "kind": "external",
  "ownership": "owner",
  "connection": "pairing",
  "device": null,
  "pairing": { "code": "…", "expiresAt": "…", "command": "npx @olorinm/agent-host link https://mau.example.com --code …" }
}
```

Run `pairing.command` on the computer. When its Host has enrolled, the partner is `online`, and `offline` whenever
the computer is off or disconnected:

```sh
mau device list                  # your partners on a computer: pairing, online or offline
mau device show laptop           # the computer: name, platform, kernel, connected, last online
mau device pair laptop           # a new code; the computer that uses it replaces the one paired before
mau device remove laptop --yes   # end the pairing; the partner stays and waits for a new one
mau chat send laptop "hello"
```

In the console: New partner, "My computer". The dialog shows the code and the command; the partner's profile
shows its device where other partners have an environment, with "Pair again" and "Unpair".

A pairing code is shown only by the request that makes it (creating the partner, `mau device pair`), expires, and
is replaced by the next one. One partner has one computer. Dismissing or deleting the partner ends its pairing.

| Route | |
| --- | --- |
| `POST /_mau/v1/agents` with `{ "name", "kind": "external", "duty"? }` | Create the partner; `201` with its summary and `pairing`. `ownership` may be given as `"owner"`; `"other"` is refused (`external_ownership_not_supported`). |
| `GET /_mau/v1/devices` | `{ "data": [{ "partner": { "id", "name" }, "ownership", "connection", "device" }] }` |
| `GET /_mau/v1/agents/:id/device` | `{ "ownership", "connection": "pairing" \| "online" \| "offline", "device": { "id", "name", "platform", "kernel", "online", "pairedAt", "lastSeenAt" } \| null }` |
| `POST /_mau/v1/agents/:id/device/pair` | `{ "code", "expiresAt", "command" }` |
| `DELETE /_mau/v1/agents/:id/device` | `204` |

## What it can and cannot do

- **Messages.** You write to it in the console, the CLI or a chat channel connected to it, like to any partner.
  While its computer is offline your messages wait and are handled when it is back.
- **Other partners.** A partner in an environment can send it a message with the `partners` tool (relay, ask,
  inform) and gets its reply back in the conversation it sent from. A relay or an ask to an offline computer waits,
  for at most 48 hours. The sender is told that this partner is on your computer, with its own files and tools, and
  cannot see the sender's environment, so everything must be in the message. It cannot be recruited, and it does
  not message other partners itself.
- **Approvals.** When its kernel asks before doing something (running a command, for example), the question
  appears as a card in your conversation with it.
- **What reaches it.** Each turn carries the message and one sentence saying who it is from (you, another partner,
  or a chat channel), and notes other partners left for it. A partner's message says that it is not from you and
  authorizes nothing new. No instructions and no tools of Mau are sent.
- **Not for it.** Mau's memory document and its change record, conversation search, background memory review,
  connectors, skills, model settings, environments, SSH and scheduled rules. Those routes answer
  `not_available_for_external_partner` (HTTP 409), and the console does not show them.

## Security boundary

- The service can send the partner text and attachments, stop a run, and answer the questions its kernel asks you.
  It cannot read or write files on the computer, start native sessions there or call the kernel's native methods:
  Mau does not pass those abilities of a Host on for such a partner.
- What the agent may do on the computer (which directories, which commands, what needs your approval) is decided
  by the Host's configuration on that computer and by the kernel's own permissions. Mau neither sees nor changes
  them. Give the Host the least it needs.
- Whoever holds an unused pairing code can pair a computer with the partner and will receive the messages sent to
  it. Treat the code like a password until it is used; `mau device pair` invalidates it and `mau device remove`
  disconnects a computer.
- Another partner's message is delivered as that partner's words, never as yours. What the agent does with it is
  still limited by its own permissions on your computer.

## Deployment and local mode

On a Cloudflare deployment the computer reaches two paths without your sign-in, each checked by Agent Kit against
the pairing code or the link's own credential: `POST /_agent-router/v1/host-links/enroll` and the WebSocket
`/_agent-router/v1/host-links/socket`. `mau deploy` gives each an Access application with a Bypass policy, and
`mau doctor` reports `host-links` when one of them is behind the login. See
[Deployment](deployment.md#deploy-your-own).

A service started with `mau local` listens on `127.0.0.1` only, so the only computer that can pair is the one it
runs on.
