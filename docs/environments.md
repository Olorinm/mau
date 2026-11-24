# Environment setup

[简体中文](environments.zh-CN.md)

Mau owns environment profiles, provisioning, the operation journal, Host bootstrap,
Agent/environment binding, lifetime renewal and idle pause/wake. Router owns account identity,
channel authorization and delivery. Host owns native execution and sessions.

## Configure the server

[`mau deploy`](deployment.md#deploy-your-own) does all of this for a deployment on Cloudflare, and
[`mau local`](local.md) for a service on your own machine. The steps below are what they do, for a setup made by hand.

1. Put the service behind Cloudflare Access and add `edgeIdentity` to `mau.json` (see [web console](web.md#login-cloudflare-access)): it is the only owner login of a service others can reach, and Mau does not start without it. The one exception is [local mode](local.md): with `MAU_LOCAL_TOKEN_FILE` naming a private file, `mau-server` signs in the bearer of the token in it as `@owner:<MATRIX_SERVER_NAME>`, and starts only with `HOST` set to `127.0.0.1` or `::1` and no edge identity. Mau embeds Router and runs it without Matrix; run only one process on a state directory and its channels.
2. Prepare an existing sandbox service and template using [Environment](https://github.com/Olorinm/agent-kit/tree/main/packages/environment). Mau allocates sandboxes, not clusters or networks.
3. Install Host and the native kernel in the template. Start Host with `serve --ready-file ...`; preserve Host state, native sessions and workspace on durable paths.
4. Copy [mau.json](../examples/mau.json) and [Host config](../examples/cloud/host-profile.json) outside the repository. Supply private Environment `providers.json` and API-key files. Paths resolve relative to `mau.json`; adjust them when moving files.
5. Assign profiles to exact Router owner IDs (`owners: ["*"]` explicitly permits all accounts). Private `files` inject individual native credentials, never into a shared image. A profile's optional `env` names variables its environments are created with, for example a proxy; it is not for secrets, and an environment keeps the ones it was created with. Clients select only profile IDs; they cannot submit commands, URLs or file paths.
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
mau partner create helper --profile codex
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
  credentials and are meant to be used. Accepted kernels: `codex`, `claude`, `agy` (Google
  Antigravity, [below](#an-antigravity-partner)), and `dsh` (DeepSeek Harness). Kernels that bring their own gateway are not
  offered this way. A kernel may appear once in a profile and every
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
  needs: `openai` for `codex`, `anthropic` for `claude`, `google` for `agy`, and `deepseek` for `dsh`, for all its kernels, with every create
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

### Four partners in one workspace

The [four-partner Mau options](../examples/mau-four-partners.json) and [Host configuration](../examples/cloud/host-four-partners.json) use one Claude runtime for the lead, one Codex runtime for two independent partner sessions, and Antigravity for the advisor. Each partner has its own conversation and connection assignments. Replace `personal-gmail` and `team-browser` with the actual connection IDs.

1. Copy the sample options to your private Mau configuration directory, keep the referenced `cloud/` and `private/` paths relative to it, and set the Router owner ID and service endpoints. Supply the verified Host archive and its SHA-256 manifest alongside the matching Agent Kit Cloudflare `start-host.sh` and its `official-skills.tgz`. With the updated gateway's `node24` template, this script installs Codex and the checksum-verified Linux Antigravity release. The Host package includes Claude Agent SDK.
2. Put the operator's Anthropic, Gemini and scoped GitHub credentials at the configured paths. Mau resolves `anthropicCredentialFile` and `githubCredentialFile` relative to its configuration directory and reads them before provisioning or resuming the environment. Omit `githubCredentialFile` for a team that does not use GitHub. Switching Claude authentication also requires configuring a working provider. Supply the Codex authentication JSON and the sample [Gemini provider selection](../examples/cloud/agy-settings.json). The gateway holds the keys and supplies guest placeholders or native login handles. The connector authority and caller signing keys stay with Mau. The sample expects the [ConnectorService setup](connector-accounts.md#operator-configuration).
3. Create a partner named `lead` and select the `shared-team` environment for it. In the owner's private conversation, ask lead to check `partners` with `action=roster` and `guide=true`, then use `action=recruit` for the three entries below. A second Codex recruit gets its own native session on the existing runtime. Check `action=roster` again for all four names and their kernels.

   | Name | Kernel | Duty |
   | --- | --- | --- |
   | `backend` | `codex` | Implement changes and run targeted tests. |
   | `reviewer` | `codex` | Review the changes independently and report defects. |
   | `advisor` | `agy` | Review designs and trade-offs for lead. |

4. In Mau's Connectors settings, assign personal connections only to lead. Give each subordinate the work connections it needs. Set allow, ask or deny for each operation on the connection. The sample enables employee authorization and permits only the `connected_apps` tool through the shell relay. Partner approval cards go to the lead's conversation when work is delegated by lead. Connectors and the model gateway have separate authorization settings.

Backend and reviewer share the sandbox and approval configuration of the `implementation` runtime. They have independent native sessions and Mau employee IDs. Removing one employee’s connection leaves the other’s assignments intact. Employees assigned the same connection use its common operation policy. Processes under this shared OS account can read each other’s session IDs and claim them, so this profile assumes trusted coworkers.

Codex and the optional DSH runtime discover the official skills in `/home/user/.agents/skills`. The shared workspace retains the browser skill for local pages, and adds the Lark and Google groups when employees have those connections. Each CLI still checks the calling employee's assignment. Installing a second copy under `.codex/skills` would duplicate entries in Codex. [Codex skill discovery](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills)

Codex uses the native Auto preset, with workspace writes and on-request approvals. Its workspace network flag is enabled for the loopback relay, local web tests and outbound requests permitted by the gateway. Only the advisor's Antigravity command receives `--dangerously-skip-permissions`; Mau still enforces connected-app policies. Ordinary work and acceptance are coordinated in lead's private conversation. [Codex approval and sandbox settings](https://developers.openai.com/codex/agent-approvals-security/)

### Git, GitHub CLI and Claude credentials

For a Cloudflare environment, set `githubCredentialFile` to the path of an operator-local file containing a GitHub access token.
Select its repositories and permissions on GitHub. Mau registers that token with the gateway at creation and resume. Use normal HTTPS Git remotes and
`gh` commands for pulls, pushes and pull requests. All partners in this environment share the selected GitHub permissions. Git and `gh` contact GitHub
directly through the gateway and these commands have no Mau connector approval cards. Rotating the file and resuming updates the gateway. Removing the
selection and resuming revokes access for that environment.

Set `anthropicCredentialFile` the same way for a Claude partner using the official Anthropic API. Claude receives a placeholder in
`ANTHROPIC_API_KEY`. The gateway replaces it on the allowed Anthropic inference and model-listing paths. Keep these operator files outside the profile's
guest `files` mappings. The starter ships the connector skills from the pinned official releases and installs them offline beside the Mau sandbox addendum.

### A DeepSeek Harness partner

Add `{"kernel":"dsh","runtimeId":"dsh"}` to `otherKernels` and the corresponding runtime to the Host configuration. DSH can also be the main runtime. Set the profile's `deepseekCredentialFile` to an operator-local file containing its API key. Mau imports the key into the gateway on creation and resume. The sandbox receives a placeholder in `DEEPSEEK_API_KEY`. The Cloudflare starter installs the pinned official CLI for a DSH runtime. Other templates need `dsh` on the Host's path. See the [Host configuration example](../examples/cloud/host-dsh-partner.json).

### An Antigravity partner

`agy` is Google's Antigravity CLI, which Agent Host runs through its ACP server (`agy acp`). It
gives the environment a partner on Gemini. It needs Agent Host with the `agy` kernel and an
Environment gateway with the `google` model service. With an Agent Kit release that has neither,
the gateway refuses the environment (`invalid_model_services`) and the Host does not start with
this configuration.

```json
"otherKernels": [
  { "kernel": "agy", "runtimeId": "agy", "files": [
    { "source": "/private/alice/agy-settings.json", "destination": "/home/user/.gemini/antigravity-cli/settings.json" },
    { "source": "/private/alice/gemini-api-key", "destination": "/home/user/.gemini/api-key" }
  ] }
],
"hostConfigFile": "cloud/host-agy-partner.json"
```

- **Runtime.** See [host-agy-partner.json](../examples/cloud/host-agy-partner.json). `model` and the
  values of `allowedSettings.model` are IDs of Antigravity's model selector, as `agy models` prints
  them without the thinking level; `effort` is its thinking level. List only the efforts every
  listed model offers: Antigravity reports no per-model list that Mau reads, and a level a model
  does not offer fails the turn.
- **Permissions.** Antigravity asks before commands, and those requests become approval cards in the
  owner's conversation. A turn a partner's message started cannot ask, so the partner's runtime needs
  `"args": ["acp", "--dangerously-skip-permissions"]`. Its `auto` mode (`"config": {"mode": "auto"}`)
  is not enough: it runs edits and safe commands unasked, and still asks before every tool of Mau
  (`partners`, `memory`, `connected_apps`), which such a turn then waits on until the Host's deadline.
  With the flag the sandbox and the gateway are what holds the partner; Mau's own approvals, such as
  a connector write, are unchanged.
- **The command.** The template must have `agy` on the `PATH` of the Host's user (or name it with
  `command`). The Cloudflare startup script installs the pinned Linux release when the profile includes Antigravity.
- **Credential.** Use a Gemini API key. Antigravity needs two things for it, and one alone does
  nothing: `{"modelProvider": "gemini"}` in `/home/user/.gemini/antigravity-cli/settings.json` (a
  file of the entry's `files`) and `GEMINI_API_KEY` in the environment of the `agy` process. The key
  is a credential and does not belong in the Host configuration: supply it as a 0600 file through
  `files` with a destination that ends in `/.gemini/api-key`, and have the runtime's `command` read
  it, as the example does. Antigravity's Google sign-in is not supported here: it is kept in a
  desktop keyring a sandbox does not have, and the `google` service does not admit its hosts.
  - **A gateway that holds credentials** (Cloudflare) gets the key from Mau, and the key never
    enters the sandbox: the file there contains the placeholder `gateway-managed`, which is all
    Antigravity checks for, and the gateway replaces whatever key or token a request to
    `generativelanguage.googleapis.com` carries with the owner's. Mau stores the key at the gateway
    again on every create and resume, so after rotating it replace the file's content and resume
    one environment of the profile: the gateway uses the new key at once, for every environment
    that shares the file. An environment made before the gateway held the key has the real key
    replaced by the placeholder at its next resume. The file is one key on one line; a profile has
    one such file.
  - **A provider that holds none** gets the file as it is, and like every kernel's credential it is
    readable by all partners of the environment. The same Host configuration serves both cases.
- **Network.** What the `google` service admits on `generativelanguage.googleapis.com` depends on
  who holds the key. When the gateway holds it, the whole Gemini API there is open, any path and
  method (model listing, files, caches, the other generation methods): a partner can only use the
  owner's key, so nothing it sends reaches another account. When the key is in the sandbox, only
  the one request a turn makes is admitted, `POST /v1beta/models/<model>:streamGenerateContent`:
  the gateway cannot tell whose key a request carries (`modelAccounts` covers `openai` only), and
  with more admitted a partner that is talked into it could use someone else's key to upload the
  owner's files into that person's project. With an API key Antigravity offers Gemini models only;
  the runtime's `allowedSettings` decides which a partner may select.
- **Instructions.** Antigravity reads its rule files (`AGENTS.md`, `GEMINI.md`) by its own rules; Mau
  writes neither.

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

## A browser inside the environment

The [remote browser](connector-accounts.md#connector-clis-and-guides-in-the-agents-environment) runs outside
the environment and refuses loopback and private addresses, so it cannot open a page the Agent serves at
`http://localhost:PORT`. For those pages the environment carries a browser of its own, from Environment's
[start script](https://github.com/Olorinm/agent-kit/blob/main/packages/environment/cloudflare/examples/start-host.sh)
(`cloud/start-host.sh` of a deployment):

- Debian's `chromium-headless-shell` with Latin, Chinese/Japanese/Korean and emoji fonts, and the official
  [agent-browser](https://github.com/vercel-labs/agent-browser) CLI, unmodified, from npm at the version
  Agent Connectors pins, under `/opt/local-browser` with only this machine's binary kept. About 285 MB to
  download and 670 MB on disk. Chromium is the version Debian ships and updates; nothing is downloaded
  from a browser vendor, and none of this touches the Playwright pin of this repository's CI.
- Use `agent-browser open http://localhost:PORT` in the terminal. Mau runs loopback pages through
  `/opt/local-browser/agent-browser`. The local launcher sets
  `AGENT_BROWSER_EXECUTABLE_PATH` to that Chromium, `AGENT_BROWSER_ARGS` to what Chromium needs in a
  container as a user other than root (`--no-sandbox`: the environment is the isolation boundary;
  `--disable-dev-shm-usage`: `/dev/shm` is small) and `AGENT_BROWSER_NO_VERSION_CHECK=1` (the CLI's check
  for a newer Chrome asks a site on the internet), then passes the arguments to the official CLI. When an external address opens through the assigned cloud
  browser, subsequent commands such as `snapshot` and `click` follow that browser session.
- The installation runs in the background after an environment's first start, so Host is ready as
  before, and is kept by the environment's snapshot. `/opt/local-browser/agent-browser` appears when it
  has finished, a few minutes later; `/var/log/local-browser-install.log` has its output.
- The CLI keeps a daemon with the browser between commands, as the user that ran it, with its socket and
  session files in `/home/user/.agent-browser`. It ends with `close`, after an hour without commands, or
  when the environment pauses.
- This browser has no internet access: the environment's outbound network admits no websites.
- Mau uploads the script when it creates an environment, and a resumed environment runs the copy in its
  snapshot. An environment created before the script had this therefore stays without the browser until
  it is [replaced](environment-replacement.md).
- An image of your own that does not run this script needs the same packages and file.

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
