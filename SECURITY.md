# Security

## Reporting a vulnerability

Please report privately through GitHub: open the repository's **Security** tab
and choose **Report a vulnerability**. Do not open a public issue for a
security problem.

Include what you found, how to reproduce it, and which revision you tested.
Use your own installation and test data. Never test against someone else's
installation, real recordings, or Owlet's services.

This is a volunteer project. Reports are read and fixed on a best-effort
basis, with no promised response time.

## Scope

In scope: this repository's code and documented setup, for example
- reading recordings or `.owlet_tokens` from outside the host,
- the web app being reachable beyond loopback or your private network when
  installed as documented,
- the recorder or logs exposing account tokens or vitals,
- the deploy scripts weakening the host's permissions.

Out of scope:
- Owlet's cloud, apps and devices. Report those to Owlet.
- Installations changed from the documented setup, such as binding the web app
  to `0.0.0.0` or exposing it publicly. It has no authentication by design and
  must stay private.

## Design notes for reviewers

- The web app has no login. Its only protection is that it binds
  `127.0.0.1` and is reached by SSH tunnel or a private tailnet.
- `.owlet_tokens` holds a Firebase refresh token that can read the sock. It is
  created with mode `0600`, git-ignored, and copied to the host only by
  `box/deploy.sh`. Your Owlet password is never stored.
- The systemd units run as an unprivileged `owlet` user with a sandbox; the web
  unit also refuses non-loopback, non-tailnet addresses.
