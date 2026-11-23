# Connect an agent on your computer

A partner can be an agent that is already installed on your own computer (Windows, Linux or macOS) instead of one
Mau runs in a cloud environment. Your computer runs Agent Kit's Host, pairs with the partner once, and from then
on connects to your Mau service by itself; nothing connects to your computer from outside.

Mau does three things with such a partner: it sends it messages, takes its replies, and passes its requests for
approval to you. Its kernel, model, permissions, memory, skills and files are its own.

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
  "pairing": { "code": "…", "expiresAt": "…", "command": "agent-host link --config host.json --url https://mau.example.com --code …" }
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
| `GET /_mau/v1/agents/:id/device` | `{ "ownership", "connection": "pairing" \| "online" \| "offline", "device": { "id", "name", "platform", "kernel", "online", "pairedAt", "lastOnlineAt" } \| null }` |
| `POST /_mau/v1/agents/:id/device/pair` | `{ "code", "expiresAt", "command" }` |
| `DELETE /_mau/v1/agents/:id/device` | `204` |

## What it can and cannot do

- **Messages.** You write to it in the console, the CLI or a chat channel connected to it, like to any partner.
  It takes text only: an attachment is answered with a line saying so. While its computer is offline or not yet
  paired your messages wait and are handled when it is there; the conversation and `mau chat send` say what they
  wait for.
- **Other partners.** A partner in an environment can send it a message with the `partners` tool and gets its reply
  back in the conversation it sent from. A relay or an ask to an offline computer waits, for at most 48 hours. An
  inform wakes nobody: it is added to the next relay or ask a partner sends it (your own messages do not carry
  it). The sender is told that this partner is on your computer, with its own files and tools, and cannot see the
  sender's environment, so everything must be in the message. It cannot be recruited, and it does not message
  other partners itself.
- **Approvals.** When its kernel asks before doing something (running a command, for example), the question
  appears as a card in your conversation with it. When the turn was started by another partner's message, the
  same request also appears in the conversation that message was sent from, naming the partner; your choice there
  answers it, and that copy is withdrawn when the request is answered elsewhere, expires or its turn ends. Only you
  can answer either card. The partner that sent the message is told that it waits for your approval.
- **What reaches it.** Text. Your message arrives as you wrote it. A partner's message arrives as one JSON
  object: `from.partner` names the partner that wrote it, `about` says that you paired this computer so that your
  agents can send it work and that its answer goes back to the sender, `notes` carries what partners left for it
  earlier, and `message` is the message. It is not told that the message authorizes nothing: an agent told so
  declines to act, and its own permissions on your computer apply either way. No instructions and no tools of Mau or of Router are sent: the
  computer's Host refuses a turn that carries any.
- **Not for it.** Mau's memory document and its change record, conversation search, background memory review,
  connectors, skills, model settings, environments, SSH and scheduled rules. Those routes answer
  `not_available_for_external_partner` (HTTP 409), and the console does not show them.

## Security boundary

- The service can send the partner text, stop a run, and answer the questions its kernel asks you. Agent Kit
  enforces this on the computer: a turn that arrives over the link with instructions, tools or attachments is
  refused there, whatever the service sent. Turns of such a partner do not pass through Mau's own Host layer, which
  is where partners in an environment get Mau's tools, memory and skills.
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

Agent Kit locks out an address after repeated failed enrollments. The address is the client's only when Router
trusts the proxy in front of it: a deployment made by `mau deploy` sets `AGENT_TRUST_PROXY` in `mau.env` and its
Worker passes the client address on. Without that setting every computer shares the proxy's address.

A service started with `mau local` listens on `127.0.0.1` only, so the only computer that can pair is the one it
runs on.
