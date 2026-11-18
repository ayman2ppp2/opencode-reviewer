# Route inference through your own device

By default the reviewer calls OpenCode from the GitHub runner's network. If the free endpoint rejects that network, you can send model requests through a device you control.

A 429 response does not prove the limit is IP-based. It may be account-wide. Routing through your device is an experiment, not a guaranteed fix.

## Pick one connection

`REVIEWER_EGRESS_PROFILE` selects exactly one connection. There is no automatic switching.

| Profile | Where requests leave | Credentials |
| --- | --- | --- |
| `direct` | GitHub runner | None |
| `laptop` | Linux laptop | `REVIEWER_LAPTOP_RELAY_URL`, `REVIEWER_LAPTOP_RELAY_KEY` |
| `android` | Android 16 phone | `REVIEWER_ANDROID_RELAY_URL`, `REVIEWER_ANDROID_RELAY_KEY` |

A 429, a timeout, or a device going offline **blocks the review**. It never selects another device or falls back to the runner. This avoids rotating egress to work around a provider quota.

## How it works

```text
GitHub runner                    your device
  gateway container                relay.py (loopback only)
    -> POST /v1/relay  ---TLS--->    -> fixed OpenCode endpoint
       <- JSON envelope <--------     <- buffered response
```

Cloudflare Quick Tunnel provides a temporary HTTPS URL with no account. The docs say Quick Tunnels do not support streaming SSE, so the relay buffers the response into a bounded JSON envelope. The gateway rebuilds the exact bytes and streams them to the pinned OpenCode CLI locally.

The relay accepts only the pinned free model and two fixed upstream URLs. It verifies zero pricing before every request. It never forwards provider keys, cookies, or proxy credentials. See [security boundaries](security.md).

## Prepare a device

Python 3.10 or later and `cloudflared` are required. On Android, install Termux from a trusted source and add both packages there.

```sh
pkg install python cloudflared   # Termux only
```

On a Linux laptop, use your distribution's packages or the official installers.

## Start the laptop relay

```sh
python3 device/start.py --profile laptop
```

The script prints JSON with the tunnel URL and the path to the private key file. It keeps the relay and tunnel in the foreground. Stop it with `Ctrl+C`.

To register the tunnel with one or more repositories you own, and authenticate with your `gh` login:

```sh
python3 device/start.py --profile laptop \
  --repo OWNER/REPOSITORY --register
```

Add `--activate` to make the laptop the repository's default connection. The key is sent to `gh secret set` on stdin, never on a command line or in a log. The URL is a secret because possession of the URL plus key is what authenticates a request.

## Start the Android standby

On the phone, in Termux:

```sh
python3 device/start.py --profile android --repo OWNER/REPOSITORY --register
```

Do not pass `--activate` for the standby. Leave the laptop as the default. To use the phone, run `gh workflow run review.yml -f pr_number=123 -f egress_profile=android`, or change the repository variable `REVIEWER_EGRESS_PROFILE`.

Android may suspend background processes. A tunnel dies when Termux is killed or the phone sleeps. Check the relay is still running before selecting the phone.

## Tunnel limits

Quick Tunnel hostnames change each time you restart `cloudflared`. Re-register or let the operator update the secrets. There is no uptime guarantee. Cloudflare documents connection time limits on published applications, so a long buffered model response may fail. The relay uses a 90-second upstream budget to stay below the enclosing deadlines.

## Rotate the key

Delete the key file and restart the relay to generate a new one. Re-register with `--register` so the repository secret matches. Stopping the relay closes the old tunnel.

## Verify locally without model calls

```sh
python3 -B -m unittest discover -s device -p 'test_*.py'
bun run check
bun run reviewer build
bun run verify:isolation
```

The tests exercise the HTTP protocol and the real OpenCode CLI against a local fixture. They do not call the provider. A real end-to-end check still needs a free-model request and may be blocked by quota.
