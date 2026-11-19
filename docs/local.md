# Mau on your own machine

`mau local` runs the whole product on one machine: the same server a deployment runs, with one owner and with each
partner's environment as a container of the local Docker engine. It needs no Cloudflare account. It is for trying
Mau out; [deploy your own](deployment.md) when you want to keep it.

## Prerequisites

- Node.js 24 or later, git, and a running Docker engine (Docker Desktop, Colima or another that answers `docker`);
- a Codex sign-in on this machine: `codex login`, which writes `~/.codex/auth.json`. Partners use it for their model.

## Run it

```sh
git clone https://github.com/Olorinm/mau && cd mau
node scripts/bootstrap.mjs && npm run build     # add `npm run build:web` for the web console
node dist/cli.js local
```

`mau local` checks the machine, writes its private directory, starts the server on `http://127.0.0.1:8790` and signs
this CLI in to it. When the service is ready it prints one JSON document on stdout; the server's log goes to stderr.

```json
{
  "url": "http://127.0.0.1:8790",
  "owner": "@owner:localhost",
  "dir": "/home/you/.config/mau/local",
  "console": "http://127.0.0.1:8790/#token=…",
  "next": ["mau partner create helper --profile codex", "mau chat send helper \"hello\"", "mau --help", "mau deploy --hostname HOSTNAME --owner-email EMAIL"],
  "stop": "Interrupt this command (Ctrl-C). Partner environments stay as they are: containers keep their files."
}
```

It runs in the foreground until it is interrupted. In another terminal, every [CLI command](cli.md) works at once
(`mau` is `node dist/cli.js` of this checkout):

```sh
mau partner create helper --profile codex    # the first one builds the image and installs Host and Codex: minutes
mau chat send helper "hello"
mau doctor --url http://127.0.0.1:8790       # what local mode needs, the service, every partner
```

`console` is there when the web console was built. Open that address: the page takes the owner token from the
fragment, which a browser sends to no server, keeps it for that tab and removes it from the address. Any other tab
is told to use the printed address.

| Option | |
| --- | --- |
| `--port PORT` | The port on `127.0.0.1`; 8790 when not given. |
| `--dir DIR` | The private directory; `~/.config/mau/local` when not given (`MAU_CONFIG_DIR/local` when that is set). |
| `--codex-auth FILE` | The Codex sign-in to use instead of `~/.codex/auth.json`. |
| `--sandbox-proxy URL` | The proxy new partner environments reach the internet through. |

A failed check says what is missing and how to fix it, and changes nothing: `local_requires_source_checkout`,
`platform_archives_missing`, `docker_engine_unreachable`, `codex_sign_in_required` (`"fix": "codex login"`),
`codex_auth_invalid`, `invalid_sandbox_proxy`, `sandbox_proxy_is_loopback`, `port_in_use`.

**Behind a proxy.** A container does not use this machine's proxy settings. When the machine reaches the internet
through a proxy, name it as a container reaches it, for example `--sandbox-proxy http://host.docker.internal:7890`
on Docker Desktop, or the address of the engine's gateway elsewhere; `127.0.0.1` inside a container is the container
itself and is refused. The proxy is given to environments created from then on as `HTTP_PROXY`, `HTTPS_PROXY` and
their lowercase forms (with `NO_PROXY` for the container's own loopback). It is remembered in the directory's
`config/mau.json`; an empty value (`--sandbox-proxy ""`) removes it. An environment keeps the proxy it was created
with. Without the option, `mau local` only says on stderr that the machine has a proxy and environments have none.

## The directory

`~/.config/mau/local/` is readable by you only:

| | |
| --- | --- |
| `config/` | `mau.json`, `providers.json` and the files of the one environment profile (`codex`), made from the same `examples/` as a deployment's configuration. What you add stays; the `codex` profile is written again at every start. |
| `config/cloud/codex-auth.json` | A copy of your Codex sign-in, refreshed from `~/.codex/auth.json` at every start. |
| `state/` | Partners, conversations, memory, schedules and the environment journal. |
| `token` | The owner token, made once. |

Stopping `mau local` leaves partner environments as they are: a container that was running keeps running, and
every container keeps its files. Starting it again goes on with the same state, the same token and the same
partners. `mau partner delete NAME --yes` removes a partner's container; to remove everything, delete the partners,
stop `mau local` and delete the directory.

## What it is not

Local mode replaces the two things a deployment gets from Cloudflare, and both replacements are weaker:

- **The login is one token in a file.** There is no Cloudflare Access. The server accepts exactly the token in
  `token`, as a bearer header, and treats its bearer as the owner `@owner:localhost`. Whoever can read that file,
  or your terminal's output with the console address, is the owner. The server listens on `127.0.0.1` only and
  refuses to start in local mode on any other address or together with an edge identity
  (`local_mode_requires_loopback`, `local_mode_excludes_edge_identity`), so do not put a proxy or a tunnel in front
  of it. A page of another website cannot call it: the token is in no cookie, and the service allows no
  cross-origin request to carry a header.
- **The sandbox is a plain container.** An environment reaches the whole internet and everything this machine's
  network reaches; the egress restrictions of a deployment's environment gateway do not exist here. Commands run as root in
  the container, without CPU or memory limits, and anyone who can use the Docker engine can enter it. There are no
  backups of an environment.
- The Docker provider holds at most three environments, stopped ones included (`trial_capacity_reached` beyond
  that). Partners created with `--share` use another partner's environment and do not count.
- Nothing wakes or pauses an environment by a provider lifetime; Mau itself still pauses one that has been idle
  for ten minutes and resumes it for the next message.

- **Only this machine can pair.** [An agent on your computer](external-agents.md) connects to the service itself,
  and the service listens on `127.0.0.1` only: the agent has to be on the machine `mau local` runs on.

It is not for production and not for more than one person.

## Next: deploy

The same checkout deploys to your own Cloudflare account, with Cloudflare Access as the login and a gateway that
restricts each sandbox:

```sh
node dist/cli.js deploy --hostname mau.example.com --owner-email you@example.com
mau login https://mau.example.com
```

See [deployment](deployment.md). A deployment starts empty: partners and conversations of the local directory are
not moved. `mau login` replaces the CLI's local sign-in; run `mau local` again to return to the local service.
