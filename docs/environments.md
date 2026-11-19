# Environment setup

[简体中文](environments.zh-CN.md)

Mau owns environment profiles, provisioning, the operation journal, Host bootstrap,
Agent/environment binding, lifetime renewal and idle pause/wake. Router owns account identity,
channel authorization and delivery. Host owns native execution and sessions.

## Configure the server

1. Put the service behind Cloudflare Access and add `edgeIdentity` to `mau.json` (see [web console](web.md#login-cloudflare-access)): it is the only owner login, and Mau does not start without it. Mau embeds Router and runs it without Matrix; run only one process on a state directory and its channels.
2. Prepare an existing sandbox service and template using [Environment](https://github.com/Olorinm/agent-kit/tree/main/packages/environment). Mau allocates sandboxes, not clusters or networks.
3. Install Host and the native kernel in the template. Start Host with `serve --ready-file ...`; preserve Host state, native sessions and workspace on durable paths.
4. Copy [mau.json](../examples/mau.json) and [Host config](../examples/cloud/host-profile.json) outside the repository. Supply private Environment `providers.json` and API-key files. Paths resolve relative to `mau.json`; adjust them when moving files.
5. Assign profiles to exact Router owner IDs (`owners: ["*"]` explicitly permits all accounts). Private `files` inject individual native credentials, never into a shared image. Clients select only profile IDs; they cannot submit commands, URLs or file paths.
6. Optional `connectionsFile` points to Router's private JSON containing `mailServices`. All channel connection logic stays in Router.

Mau is deployed on Cloudflare as a Worker with one container; [deployment](deployment.md) describes the
image, where configuration and state live, and how a release reaches production. `mau-server` reads
`MATRIX_SERVER_NAME` (the owner-ID namespace, such as `agents.example` in `@alice:agents.example`; no Matrix
server is used), `AGENT_SERVICE_URL`, `MAU_CONFIG_FILE`, `MAU_STATE`, optional `MAU_WEB_ROOT` for the
[web console](web.md), and Router's options through `loadServiceConfig`. Only explicitly trusted proxy
addresses belong in `AGENT_TRUST_PROXY`.

`MAU_STATE/router/` contains identities, channels and delivery records.
`MAU_STATE/mau/` contains the environment journal and per-Agent Host tokens. One coordinator holds a
renewable journal lease: run only one process on a state directory. No production addresses, environment
IDs, credentials or topology belong in this repository.

## Lifecycle

Creation records the operation before requesting resources, then saves the returned
ID before bootstrap. Duplicate requests return the existing operation. A lost
response is reconciled by ID or unique metadata, never a blind second allocation.
Interrupted mutations become `needs_action` after restart.

Pause/destroy stop delivery workers and refuse active or uncertain runs before
changing cloud state. Resume retains the environment and native session binding.
Missing environments are never silently replaced. Provider-retained snapshots
may require separate cleanup.

Deleting an Agent (`DELETE /_mau/v1/agents/:id`, `mau partner delete NAME --yes`) first
pauses its schedules and destroys its current, retained previous and retired
environments (a partner in a [shared environment](#partners-sharing-an-environment)
has none of its own and leaves that environment in place); records already confirmed `deleted` are not contacted again, so an
Agent whose provider was removed from configuration can still be deleted. A
cloud failure leaves the Agent and its binding in place (`needs_action`). After
Router deactivates the Agent, Mau removes its bindings, tokens, memory files,
history, schedules and product records.

Ready environments renew every 30 seconds. `lifetimeSeconds` must be at least 600.
A renewal request may fail twice; the third consecutive failure, or a confirmed
stopped environment, becomes `needs_action`. Cloud timeout policy applies during
longer Mau outages. Volcengine currently uses explicit pause and `kill` on expiry;
choose durable storage accordingly.

Optional `idlePauseSeconds` (600 to 2592000) pauses a ready environment after no
Host requests for that long from any partner running in it, using the same guarded pause. The state is `sleeping`.
Router keeps receiving messages; when deliverable work waits, it asks Mau to wake
the environment, and the first reply waits for resume. Active or unresolved runs
count as activity. An explicit `mau env pause NAME` is never woken by messages.

Provider, template, kernel, runtime ID, Host directory and port identify an
existing binding and must not change. Labels, owners, instructions, lifetime, idle,
bootstrap file settings and the [other kernels](#more-than-one-kernel-in-an-environment) a profile
offers may change.

Host requests use Environment's application endpoint/traffic token and a separate
Host token per environment. Cloud management credentials stay in Mau. Private gateways
must preserve application Authorization and required sandbox routing headers.

```sh
mau partner create helper --profile cloud-codex
mau partner check helper
mau partner show helper
mau env pause helper
mau env resume helper
mau env reconcile helper
mau env destroy helper --yes
```

Environment bootstrap binds the Host and keeps the Agent's channel connections. The owner's built-in chat
is the console's conversation, served by Router's ledger; it needs no channel connection.

`mau env create NAME --profile PROFILE` binds an unbound Agent; `mau partner list` shows the
existing identities. `--no-wait` returns progress; closing the terminal does
not cancel provisioning. `mau partner check NAME` verifies configuration and HTTP/runtime access,
not real model authentication. Router's former product commands and provisioning
routes are deleted, with no compatibility aliases or automatic state migration.


## More than one kernel in an environment

An environment has one main kernel (`kernel`, `runtimeId`). A profile can offer further kernels for
the partners that [share the environment](#partners-sharing-an-environment): each is another
runtime of the same Host process, in the same sandbox and the same working directory. Changing
kernels this way needs no second container; give a partner an environment of its own when its work
must be isolated.

```json
{
  "id": "cloud-codex",
  "kernel": "codex",
  "runtimeId": "personal",
  "otherKernels": [
    {
      "kernel": "claude",
      "runtimeId": "claude",
      "files": [
        { "source": "/private/alice/claude-settings.json", "destination": "/home/user/.claude/settings.json" }
      ]
    }
  ],
  "hostConfigFile": "cloud/host-two-kernels.json",
  "files": [
    { "source": "/private/alice/codex-auth.json", "destination": "/home/user/.codex/auth.json" }
  ]
}
```

- `otherKernels` (at most four) lists only the kernels that are installed in the template, have
  credentials and are meant to be used. Accepted kernels: `codex`, `claude`. Kernels that bring
  their own gateway are not offered this way. A kernel may appear once in a profile and every
  runtime ID once (`duplicate_environment_kernel` at start).
- The Host configuration must have a runtime with that `id` and `kernel` for each entry, with the
  same `cwd` as the main runtime; otherwise creating an environment is refused with
  `environment_runtime_profile_mismatch`. See
  [host-two-kernels.json](../examples/cloud/host-two-kernels.json). Mau uploads the file as it is.
- `files` of an entry are that kernel's private files, its model credentials: they are uploaded
  with the profile's own `files` when the environment is created, mode 0600. Credentials are per
  kernel, not per partner: every partner in the sandbox runs as the same user, so each kernel, and
  each partner, can read the other kernels' credential files. Use an environment of its own where
  that is not acceptable. No credential belongs in this repository or in the Host configuration.
- A profile that offers other kernels tells the provider which model endpoints the environment
  needs: `openai` for `codex`, `anthropic` for `claude`, for all its kernels, with every create
  and resume (`modelServices` of
  [Environment](https://github.com/Olorinm/agent-kit/tree/main/packages/environment)). The gateway
  admits only reviewed endpoints of those services; a private model gateway or another provider is
  a change to the gateway's rules. A profile without `otherKernels` names none: its requests to
  the provider are the same as before, and the gateway's default applies. The gateway keeps the
  last list it was given, so after `otherKernels` is removed from a profile its existing
  environments keep the wider list until an operator resets it at the gateway.
- `modelAccounts` holds the environment to its own account at a model service
  (`modelAccounts` of
  [Environment](https://github.com/Olorinm/agent-kit/tree/main/packages/environment)). An agent
  that is talked into it could otherwise send the owner's data to the same model provider under
  someone else's sign-in; with it the gateway refuses a ChatGPT backend request that carries
  another account's token, and refuses `api.openai.com`. Omitted, Mau reads the ChatGPT account
  from the profile's Codex sign-in file (the `files` entry whose destination ends in
  `/.codex/auth.json`: the account its access token names, else `tokens.account_id`) and sends it
  with every create and resume. Set `"modelAccounts": { "openai": ["<account id>", …] }` to name
  the accounts yourself (at most eight), or `"modelAccounts": false` to send none. Nothing is sent
  when the sign-in file uses an API key or names no account: such an environment needs
  `api.openai.com`, which a held environment cannot reach. The gateway applies the accounts when
  the environment next starts and keeps the last ones it was given. An environment that already
  exists gets them at its next resume: pause and resume it to apply them at once.
- `otherKernels` is not part of what identifies an existing environment. Offering a kernel later
  does not invalidate bindings or sessions, and the partners that exist keep their runtime. Mau
  does not rewrite the files of an environment that already exists: add the runtime to its
  `host.json` (with the matching `ready.json` hash) and place the credentials there yourself, keep
  the profile's Host configuration byte-identical to it, and let the Host restart. The model
  endpoints follow at the environment's next resume.
- A partner's kernel is chosen when it is created (`kernel` beside `shareWith`, or `kernel` of a
  [recruit](native-work.md#partners)) and is fixed afterwards. Without one it runs on the main
  kernel. A kernel the profile does not offer is refused with `environment_kernel_not_available`
  and `kernels`; one whose runtime the running Host does not have, or reports unavailable, with
  `environment_kernel_not_ready`. `GET /_mau/v1/options` lists a profile's `kernels`, and an Agent
  summary has the `kernel` that Agent runs on.

What differs between kernels stays with the kernels. A runtime reads its own instruction files and
skill directories: Codex reads `AGENTS.md`, Claude reads `CLAUDE.md` (a `CLAUDE.md` in the working
directory can import the other file). A runtime's permission settings are its own too: a turn that
a partner's message started cannot ask the owner, so a kernel that asks before every command needs
a non-interactive permission setting in its runtime profile to work there. Partners on different
kernels share files, not native context: they exchange what they know as
[messages](native-work.md#partners). See [native work](native-work.md#partners-on-another-kernel)
for what a partner on another kernel can and cannot use.

## Partners sharing an environment

A partner normally gets an environment of its own. It can instead run in the environment of another
partner of the same owner: the same sandbox, Host, runtime and working directory. It is still a
complete Agent, with its own Router identity, conversations, ledger, memory, schedules and
model settings, and creating it makes no cloud request. A partner that another partner
[recruits](native-work.md#partners) is created this way, in the recruiter's environment.

`POST /_mau/v1/agents` takes `name` and exactly one of:

- `profileId`: an environment of its own (the behavior described above);
- `shareWith`: the ID of the partner whose environment it runs in, optionally with `kernel`, one of
  the [kernels the environment's profile offers](#more-than-one-kernel-in-an-environment).

Both accept an optional `duty`, one line of plain text (at most 200 characters) saying what the
partner is responsible for. The duty is fixed once the partner has an environment binding; there is
no route to change it. The response has the usual shape; repeating the request with the same name
returns the same partner.

```json
{ "name": "scout", "shareWith": "00000000-0000-4000-8000-000000000001", "duty": "Watches the inbox and files invoices" }
```

Rules:

- The other partner must belong to the same owner and have an environment of its own that is not
  destroyed. Sharing does not chain: a partner that runs in a shared environment cannot be shared
  with (`environment_share_chain_not_allowed`, `environment_share_target_unavailable`).
- `GET /_mau/v1/agents` and `/agents/:id` return `duty` (or `null`). The `environment` of a sharing
  partner is the state of the environment it runs in plus `sharedFrom` (that partner's ID); the
  `environment` of a partner whose environment is shared lists the sharing partners in `sharedBy`.
- The sharing partner's Host requests, checks and file relay use the shared environment and its
  Host token. Its runtime ID is the environment's main one, or that of the kernel it was created
  on. Its fixed instructions are the environment
  profile's instructions followed by a `## Partner identity` section with its name and duty, written
  when it is created. The instructions of the partner that has the environment do not change.
- Idle pause counts the Host requests, unresolved runs and running native threads of every partner
  in the environment. Work waiting for any of them wakes a sleeping environment. An explicit pause
  stops the environment for all of them and is refused while any of them has an active or
  unresolved run.
- A sharing partner only reads the environment's state. Its pause, resume, reconcile, destroy,
  replace, rollback and SSH requests are refused with `environment_shared_from_partner` and
  `partner: { id, name }`; the partner that has the environment operates it.
- While other partners run in an environment, destroying it, replacing it, rolling it back and
  deleting its partner are refused with `environment_shared_by_partners` and
  `partners: [{ id, name }]`, before anything is stopped. Delete the sharing partners first.
- Deleting a sharing partner removes its own identity, memory, history, schedules and product
  records, and leaves the environment and the other partners untouched.
- Without a connector assignment of its own (`PUT /_mau/v1/agents/:id/connectors`,
  `mau connector assign`), a sharing partner uses the
  connections assigned to the partner whose environment it runs in, under its own Agent ID.
  Connections that act as the owner's personal identity keep their rule: they work only in the
  owner's private conversation with the partner making the call, and the application behind such a
  connection is still set up through the partner it is assigned to
  (`connector_assigned_through_partner`). Connector guides and commands are files of the
  environment and follow the assignment of the partner that has it; a partner on a kernel whose
  shell does not relay them gets the guides with the `connected_apps` tool instead.
- Every Codex partner in the environment reads the same native event stream. A native turn that
  Router did not start is delivered only to the owner's private conversation of the partner whose
  session ran it. This relay follows Codex runtimes only.

- Partners in one environment can message each other. Each has its own Host sessions and native
  threads, and their turns run side by side up to the runtime's limit of concurrent runs. A runtime
  that runs one turn at a time refuses the turn of a message sent while the sender's own turn still
  runs; the sender is told that the message failed.

Partners in one environment see the same files, native kernel homes and logins. Give a partner an
environment of its own when its work must be isolated.

## SSH access

Add `"ssh": { "port": 37421 }` to an assigned environment profile to enable
`mau ssh NAME`. Choose a port different from the Host service port. The environment
image must contain Node.js, OpenSSH server/client and `/run/sshd`; see
[Dockerfile.ssh](../examples/cloud/Dockerfile.ssh). Host keys are generated per
environment and must not be shared in an image.

Mau uses Environment's existing exec, file and application-endpoint interfaces;
Host is unchanged. It starts OpenSSH as the existing execution user.
Both setup and connection check account ownership. The CLI generates a temporary
Ed25519 identity, checks the Host key returned over the authenticated API, and
carries native SSH over an HTTPS `Upgrade: mau-ssh` tunnel. Front proxies and
provider application gateways must preserve HTTP Upgrade. No public per-container
SSH port is required. Custom HTTP entrypoints must call `mau.attach(server)`.

Each Agent allows up to eight connections or setup requests. Active SSH sessions
block lifecycle changes and idle pause while normal environment renewal continues.
Resume a paused environment before connecting. Client authentication expires after
ten minutes and established sessions after eight hours. A partner in a shared
environment has no SSH access of its own; connect through the partner that has the environment. Shell access exposes the
execution user's existing files and credentials; it does not change the existing
network or model-credential policy.
