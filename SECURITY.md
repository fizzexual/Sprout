# Security Policy

## Supported Versions

Sprout is under active development. Security fixes are applied to the latest
release only. You can find it on the
[Releases page](https://github.com/fizzexual/Sprout/releases/latest)
(v0.1.15 at the time of writing).

| Version | Supported |
| ------- | --------- |
| latest release | Yes |
| older releases | No |

## Reporting a Vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, report it privately by email to **fizzexual@gmail.com**. This keeps the
details confidential until a fix is available.

When reporting, please include:

- The Sprout version (the output of `sprout version`) and your operating system
- A description of the vulnerability and its impact
- Steps to reproduce (a minimal `.sprout` program or request if possible)
- The affected component (the interpreter, `--sandbox`, the Docker playground,
  or the browser playground)
- Any suggested remediation

You can expect an acknowledgement within 7 days. Once the issue is confirmed, a
fix will be prepared and released, crediting the reporter (unless anonymity is
requested).

## Scope

Reports about these parts of the project are especially welcome:

- **The interpreter** (`src/sprout.c`): a `.sprout` program that crashes the
  interpreter with memory corruption, such as a buffer overflow or a
  use-after-free.
- **Sandbox mode** (`--sandbox` or `SPROUT_SANDBOX=1`): any way for sandboxed code
  to read or write files, use the on-disk store, reach the network, run shell
  commands, load another file with `use`, or turn the sandbox off.
- **The Docker playground** (`playground/` and `docker-compose.yml`): escaping the
  container, or getting around its limits (timeout, memory, output cap, input
  size, concurrent runs).
- **The browser playground** (`playground/web/`, published at
  <https://fizzexual.github.io/Sprout/>): for example, script injection into the
  page.
- **The package manager** (`sprout add`, `sprout install`): for example, writing
  files outside `sprout_packages/`.

Out of scope: without `--sandbox`, a Sprout program can read and write files,
fetch URLs, and (with `use system`) run shell commands. That is by design. Only
run code you trust without the sandbox. Endless loops and high CPU or memory use
are also expected; the sandbox does not limit them, so a host must set OS or
container limits (see [playground/README.md](playground/README.md)).
