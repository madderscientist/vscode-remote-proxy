# [Remote Proxy](https://marketplace.visualstudio.com/items?itemName=madderscientist.remote-proxy)

[Source](https://github.com/madderscientist/vscode-remote-proxy) |
[Issues](https://github.com/madderscientist/vscode-remote-proxy/issues)

Share your local computer's network with VS Code Remote-SSH and host-networked
Dev Containers. Proxy connections follow participating windows, not a permanent
service.

```text
Remote application
  |
  v
Remote 127.0.0.1:1080 (HTTP)
  |
  v
SSH reverse forward to the local computer
  |
  +-- Built-in mode ------> Built-in HTTP proxy ------> Internet
  |
  +-- Existing-proxy mode -> Local HTTP/mixed proxy --> Internet
                            (e.g. Clash on 7890)
```

The extension runs **locally**, not on the SSH host or in the container.
The remote port speaks **HTTP**, even though its default number is 1080.
There is no SOCKS-to-HTTP conversion, TLS interception, or required Python service.

## When to use it

- Your laptop has internet access, but an SSH host needs to use that connection
  for tools or remote extensions that honor HTTP proxy settings.
- You want to share an existing local Clash/Mihomo HTTP or mixed port without
  manually starting an SSH reverse-forwarding command.
- You connect with Remote-SSH, reopen a project in a Dev Container, and close
  the original SSH window while continuing to use the container.
- You want proxy processes to stop with the last participating window instead
  of installing a persistent system service.

Choose built-in direct mode when the local computer can reach the required
destinations itself. Choose existing-proxy mode when traffic must follow your
local proxy's routing rules. This extension is not a system-wide VPN: remote
applications must be configured to use the HTTP proxy.

## Quick start

1. Install the release VSIX in a **local** VS Code window.
2. Connect normally with SSH once to verify the host key.
3. Run **Remote Proxy: Configure enabled hosts** and select one or more aliases
   from your local SSH configuration. No hosts are enabled by default.
4. Open a Remote-SSH folder. The extension asks for the proxy connection's
   password in a masked input box. Keys are optional.
5. Configure remote consumers to use `http://127.0.0.1:1080`. Stop any old
   listener using that port before switching.
6. Open the Dev Container as usual. Keeping only the container window is
   supported when it shares the SSH host's network.

For example, given this local SSH configuration:

```sshconfig
Host lab
    HostName 192.0.2.10
    User developer

Host build-server
    HostName 192.0.2.20
    User builder
```

The equivalent **local User Settings** are:

```json
{
    "remoteProxy.hosts": ["lab", "build-server"]
}
```

Use exact `Host` aliases, including non-ASCII characters, not underlying IPs.
The extension passes the alias directly to OpenSSH, which resolves the user,
address, port, identity, and jump settings.

### Use Clash or another local proxy

If Clash is listening on local `127.0.0.1:7890` with an **HTTP or mixed** port:

```json
{
    "remoteProxy.hosts": ["lab", "build-server"],
    "remoteProxy.localProxyPort": 7890
}
```

The remote URL remains `http://127.0.0.1:1080`. SSH forwards directly to the
existing local proxy; the built-in HTTP proxy is not started. A closed local
port produces an error, with no silent fallback to direct networking.
The startup check tests TCP reachability, not proxy protocol or internet access.
SOCKS-only ports are not supported. Clash retains control over its own routing
rules, authentication and lifecycle; this extension never starts or stops it.
If the local proxy requires authentication, consumers must provide it.

Set `remoteProxy.localProxyPort` to `0` (the default) for built-in direct access.
This mode does not automatically use Clash, OS proxy settings or proxy environment
variables; an OS-level VPN/TUN may still affect the local machine's routing.

### Configure remote consumers

In remote VS Code settings:

```json
{
    "http.proxy": "http://127.0.0.1:1080"
}
```

The VS Code setting applies to VS Code requests and extensions that honor it;
it does not export proxy variables for command-line tools or every extension.
For terminals or tools that read proxy environment variables:

```sh
export HTTP_PROXY=http://127.0.0.1:1080
export HTTPS_PROXY=http://127.0.0.1:1080
export ALL_PROXY=http://127.0.0.1:1080
export http_proxy="$HTTP_PROXY"
export https_proxy="$HTTPS_PROXY"
export all_proxy="$ALL_PROXY"
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"
```

For Remote-SSH, add the exports above to
`~/.vscode-server/server-env-setup` on the remote host.

For a host-networked Dev Container, put the needed variables in `remoteEnv`
and the VS Code proxy URL in `customizations.vscode.settings.http.proxy`.
For example, merge these fields into your existing Dev Container configuration:

```json
{
    "remoteEnv": {
        "HTTP_PROXY": "http://127.0.0.1:1080",
        "HTTPS_PROXY": "http://127.0.0.1:1080",
        "ALL_PROXY": "http://127.0.0.1:1080",
        "http_proxy": "http://127.0.0.1:1080",
        "https_proxy": "http://127.0.0.1:1080",
        "all_proxy": "http://127.0.0.1:1080",
        "NO_PROXY": "localhost,127.0.0.1,::1",
        "no_proxy": "localhost,127.0.0.1,::1"
    },
    "customizations": {
        "vscode": {
            "settings": {
                "http.proxy": "http://127.0.0.1:1080"
            }
        }
    }
}
```

This example does not enable host networking; configure that separately in
your container runtime or Compose service. Preserve your existing fields.
Existing containers may need their remote settings updated separately.
Reopen the window to refresh environment variables; old processes retain their
environment. Bridge-networked containers cannot use host loopback this way.

Installing this extension does **not** edit remote settings, shell profiles,
SSH configuration, or system proxy configuration. Programs must support the
configured proxy mechanism themselves. A proxy URL remaining in settings does
not keep a listener alive.

### Dev Container window does not keep the proxy connected

Check **Remote Proxy: Show log** in the **Dev Container window itself**.
A ready message in the original SSH window does not confirm that the container
window has joined the shared connection.

If the container log says `Host not enabled` and the decoded aliases still
contain `ssh-remote+...`, update the local extension to 0.1.1 or later.
Nested SSH authorities must be decoded to the original SSH alias before matching
`remoteProxy.hosts`. As an immediate workaround, run **Remote Proxy: Attach this
remote window** in the container window and enter the enabled SSH alias exactly.
Then retry the connection and verify it still works after closing the SSH window.

Also confirm that the container's running proxy environment uses `http://`, not
`socks5h://`, for this extension's HTTP port. Changing Compose environment values
requires recreating the container, not just restarting it. Reopen the container
window after changing `remoteEnv`; existing VS Code processes keep their old
environment. Preserve any data or packages in the container's writable layer
before recreating it.

### Cannot start the local broker / another broker is already running

Version 0.1.2 fixes the shutdown/reconnect startup race described below.

The extension reuses a running broker. During shutdown, its control channel
closes before SSH exits and the lock is released. Startup waits for lock
conflicts within a bounded 10-second window, checking for a broker started by
another window without repeatedly launching children while the locks remain.
Reusing a control channel requires a response from the broker, not just a
successful socket connection; a shutdown reset before that response is retried
within the same startup window.
Other startup failures are reported promptly. A failure or timeout requires
explicit **Retry connection**; rapid Retry cancels obsolete startup attempts.

If the failure persists, close all participating Remote-SSH and Dev Container
windows. Check the PID in `broker.lock` and its process command line before
stopping anything: a live PID alone does not prove it is this extension's broker.
Only after confirming that no broker is running or starting, remove stale
`broker.lock` / `broker-starting.lock` files from the specific local global-storage
directory named in the error, reopen a remote window and retry. Do not delete
locks belonging to a live broker or terminate unrelated VS Code processes.
A live PID is not proof of a healthy broker. The extension does not kill it or
steal its lock when the control channel is unavailable. Stale startup guards
and locks pointing at reused PIDs require the same ownership checks.

`broker.log` is appended across launches. `HTTP request failed`, `CONNECT failed`
and `Client connection failed` entries describe individual proxy requests, not
necessarily the latest startup failure. New broker entries include an ISO
timestamp and `[broker PID]`, with startup, control-listening and shutdown
markers. Use those to separate instances; older unmarked entries cannot be
reliably attributed to a particular attempt. For example,
`ENETUNREACH 169.254.169.254:80` means a request to a link-local address (commonly
used for cloud instance metadata) could not be reached from the local computer.
Such requests generally need to bypass the proxy and run on the remote host.
For tools that honor proxy environment variables, include `169.254.169.254` in
both `NO_PROXY` and `no_proxy`, preserving existing exclusions. Connection resets
alone do not identify a startup failure; check the last broker error separately.

For CONNECT upstream failures, the log includes the destination host/port,
whether TCP establishment had completed (`connect` or `tunnel` phase), elapsed
milliseconds and the error code. No request headers, URL paths or tunnel payloads
are included. A reset after establishment can come from the destination or an
intermediary; it does not by itself mean the proxy SSH disconnected. Failed
tunnels are closed individually, without replaying their traffic or closing
other tunnels. Older entries without destination/phase details cannot be
retroactively attributed to a particular service.

### Proxy disconnects after it was ready

Version 0.1.2 separates local heartbeats from remote filesystem checks so a slow
check cannot expire a responsive window's lease. A late check also cannot
reconnect after its control channel closes. See **Lifecycle and authentication**
below for the connection policy.

`broker.log` records numbered window leases, heartbeat expiry ages, remaining
window counts and shutdown reasons. **Remote Proxy: Show log** records
control-channel releases (Retry, configuration changes or disposal) and the
last heartbeat age. Remote checks taking at least 2 seconds are logged on
completion; a check still pending after 5 seconds logs once. Use these entries
to distinguish heartbeat expiry, window closure and SSH failure.

These diagnostics omit passwords, authentication tokens and workspace paths.
Installing updated files does not update an already-running broker:
close participating remote windows, allow the old broker to exit normally,
then reload and reconnect with the new extension.

## Settings and commands

All settings are local application settings. Default Settings is read-only;
edit **Preferences: Open User Settings (JSON)** or use the commands.

| Setting | Default | Meaning |
|---|---|---|
| `remoteProxy.hosts` | `[]` | Enabled SSH aliases |
| `remoteProxy.remotePort` | `1080` | Remote loopback HTTP port |
| `remoteProxy.localProxyPort` | `0` | Built-in direct proxy, or an existing local HTTP/mixed port |
| `remoteProxy.authentication` | `"password"` | `"password"` or noninteractive `"key"` |
| `remoteProxy.sshPath` | `"ssh"` | Local OpenSSH executable |
| `remoteProxy.sshConfigFile` | `""` | Override local SSH config path |
| `remoteProxy.windowBindings` | `{}` | Explicit bindings for unrecognized container authorities |

Commands:

- **Configure enabled hosts**: read local SSH config and choose multiple aliases.
- **Attach this remote window**: explicitly bind an unrecognized remote window.
- **Disable for this host**: remove its enabled alias and disable related bindings.
- **Retry connection**: reconnect after failure or cancellation.
- **Show log**: open the local output channel.

SSH configuration discovery uses `remoteProxy.sshConfigFile`, then
`remote.SSH.configFile`, then `~/.ssh/config` (`%USERPROFILE%\.ssh\config` on
Windows). An explicit path is also passed to SSH with `-F`.
The picker supports nested `Include`, quoted paths and glob patterns.
Relative includes resolve from `~/.ssh`; cycles are ignored and nesting is
limited to 16. Only concrete aliases are listed, not wildcard or negated `Host`
patterns. Conditional includes are enumerated statically; the parser does not
execute `Match exec`. Re-run the picker after editing the config.

## Lifecycle and authentication

VS Code windows using the same local extension storage, SSH alias and proxy
settings share a local broker and one SSH connection. After an initial remote
filesystem check succeeds, each window renews its lease every 2 seconds
independently of subsequent checks. Closing the last window stops the broker's
proxy and SSH child. Only extension-owned processes are terminated.

Different aliases for the same remote machine are not automatically merged.
Different settings, local profiles or local computers can create separate
brokers that compete for the same remote port. An occupied port is reported
as an error; no existing listener is killed or taken over.

A window's lease expires after 10 seconds without a local heartbeat, checked
every second: approximately 11 seconds of detection delay. An explicit remote
filesystem error releases the lease. Only one check is in flight per connection
generation; a pending check does not block heartbeats. If it never returns while
the window and proxy SSH remain alive, the proxy stays connected until an
explicit failure, window closure or disable command.
After a broker connection closes, use **Retry connection** or reopen the window.
An unclaimed broker exits after 15 seconds. The extension does not keep
containers alive or stop them; the container's own shutdown policy applies.

The proxy SSH connection is separate from Remote-SSH. It cannot share that
extension's password dialog. Password mode requests ordinary password
authentication for each new connection; attaching to an existing ready broker
does not prompt again. Cancellation/failure does not repeatedly reopen the prompt.
Input expires after 120 seconds, with a 135-second overall authentication limit.

Passwords are transient process-memory data, not saved in settings, files,
logs or command arguments. They pass through the local control channel and a
token-authenticated loopback askpass endpoint. Host key verification stays strict.
Use a normal SSH terminal to resolve unknown or changed host keys.

## Comparison with MosRat/ssh_proxy

[MosRat/ssh_proxy](https://github.com/MosRat/ssh_proxy) includes the
**Remote Proxy Auto Forward** extension
(`MosRat-2333.vscode-remote-proxy`). It addresses a similar remote-networking
problem with a broader daemon-based architecture. This project instead focuses
on a small, window-scoped OpenSSH workflow.

The comparison below describes the upstream source at
[commit 1375a5b8](https://github.com/MosRat/ssh_proxy/tree/1375a5b8e5a9b46c0020c14f1e54f2a8c3ffa7a8),
not a runtime test or a guarantee about its current Marketplace release.

| Area | Remote Proxy (this project) | MosRat/ssh_proxy at the referenced revision |
|---|---|---|
| Runtime | Local temporary Node.js broker and OpenSSH child | Local Rust daemon and persistent remote peer |
| Background services | No system service or remote agent installed | Daemon is the normal production control plane |
| Local direct internet | Built-in direct HTTP proxy | VS Code startup requires a detected/configured local upstream proxy |
| Existing local proxy | Explicit local HTTP/mixed port, e.g. Clash 7890 | Local proxy discovery, manual URL and HTTP/SOCKS upstream options |
| Remote-SSH to Dev Container | Participating host-networked container windows can retain the shared broker | Automatic startup is restricted to SSH windows; manual host override is available |
| Remote configuration | User-managed; does not edit settings, startup files or Git | Can manage remote VS Code, terminal, server-env and Git proxy settings |
| Lifecycle | Last lease closes the broker and its SSH connection; stale leases expire | Daemon owns route lifecycle and persistent state; extension disposal requests route stop, not daemon removal |
| Scope | HTTP/CONNECT over OpenSSH reverse TCP forwarding | Broader routing, peer transport, diagnostics and recovery system |

See upstream's
[architecture](https://github.com/MosRat/ssh_proxy/blob/1375a5b8e5a9b46c0020c14f1e54f2a8c3ffa7a8/docs/architecture.md),
[extension guide](https://github.com/MosRat/ssh_proxy/blob/1375a5b8e5a9b46c0020c14f1e54f2a8c3ffa7a8/apps/vscode-remote-proxy/README.md),
and [startup policy](https://github.com/MosRat/ssh_proxy/blob/1375a5b8e5a9b46c0020c14f1e54f2a8c3ffa7a8/apps/vscode-remote-proxy/src/startupCoordinator.ts)
for its own feature descriptions and constraints.

Use this project if you prefer explicit remote configuration, direct local
internet access without another proxy application, and window-scoped processes.
Consider upstream if you prefer a managed daemon, broader proxy/transport
options, and automated remote configuration. Neither approach is universally
better; they make different lifecycle and deployment trade-offs.

Both extensions use some `remoteProxy.*` settings and command names. Do not
enable them together in the same VS Code profile; use separate profiles for
comparison to avoid configuration, command and remote-port conflicts.

## Requirements and limitations

- Local OpenSSH 8.4+ supporting `SSH_ASKPASS_REQUIRE`; remote forwarding allowed.
- A Linux/Unix SSH host that can run `printf` and `cat`.
- An open remote folder/workspace. Empty remote windows cannot be identified.
- Host networking for Dev Containers using the host's loopback proxy.
- Password mode does not support MFA/keyboard-interactive-only servers.
  Use key/agent authentication for jump hosts.
- Startup can occur after another extension's first request; retry that request.
- A local user or process able to access the loopback proxy can use it.
  Do not expose it or the forwarded port on untrusted interfaces.
- Linux automated tests include real SSH forwarding. Cross-platform UI and
  password authentication should be verified before a general public release.
- If initialization is forcibly killed, `broker-starting.lock` can remain in
  the extension's local global storage. After confirming no broker is starting,
  remove that specific file and retry. Other normal shutdown files are cleaned up.

## Development

Node.js 20+ is sufficient for tests; there are no npm dependencies.

```sh
npm test
npm run package
```

The lightweight packager uses Windows PowerShell's built-in .NET ZIP support
on Windows and the `zip` executable elsewhere. It writes
`dist/remote-proxy-0.1.2.vsix`. It packages only runtime files, the README and
license. Tests cover HTTP/CONNECT, password validation and cancellation, host
selection, SSH config parsing, control-channel failures, multiple leases and
shutdown without stopping an external proxy. Process-level lifecycle tests
use real broker children and control connections (Windows named pipes or Unix
sockets), with a controlled SSH worker to reproduce shutdown/Retry races and
verify that a stalled remote check cannot expire a responsive window's lease.
They use isolated temporary storage, not VS Code's real locks. The Linux
integration tests need `ssh`, `sshd` and `ssh-keygen`; they are skipped if
Linux/sshd is absent. No test uses your existing SSH keys.

To release, set `version` in `package.json` without a `v` prefix (for example,
`0.1.2`). Commit and push the changes to `main`, then create and push the matching
Git tag:

```sh
git tag -a v0.1.2 -m "Release v0.1.2"
git push origin v0.1.2
```

The Deploy workflow runs on pushed `v*` tags, tests and builds the extension,
then creates a GitHub Release with the VSIX attached. Marketplace publishing is
manual. Do not move an existing release tag.

Repository name: **vscode-remote-proxy**. Marketplace publisher:
`madderscientist`.

### Switching from the prototype

Uninstall **Session HTTP Proxy** (`local-tools.session-http-proxy`) locally and
remove its `sessionHttpProxy.*` user settings. Do not run both extensions:
they may compete for the same remote port. Install **Remote Proxy**
(`madderscientist.remote-proxy`) and select the hosts again. No prototype settings,
passwords or storage are migrated automatically.
