# Sprout ongoing work ledger

Updated: 2026-10-12 (Europe/Kyiv). This is the scheduled task's work queue.
The user authorized continuing useful feature development with multiple agents
while the eight-hour qualification is pending. Keep this file current at every
handoff: record what changed, what was actually verified, who owns active files,
what comes next, and what remains blocked. Planned work is not delivered work.

## Current rules

- Work in the existing `codex/revive-sprout` branch. Read this ledger, the latest
  human instructions, agent status, Git state and the private readiness state
  before choosing work. Reuse existing agents; do not duplicate active work.
- Complete small, useful batches with bounded fixtures, peer review, relevant
  regressions and fresh native/SDK/WebAssembly CI before declaring them verified.
  Preserve failed attempts; do not rerun jobs to hide failures or loosen checks.
- Choose the next unblocked item rather than waiting on the eight-hour gate.
  Replenish the queue with concrete application needs and acceptance criteria
  before it runs out. Do not repeat completed audits merely to stay occupied.
- Keep the ongoing scheduled task active until the user stops or pauses it.
  A later stop/pause takes precedence over this development mandate.
- Do not change clock/NTP/power settings, publish a service, use paid
  infrastructure, accept the Minecraft EULA, start that server, contact others,
  or read/expose private application source. Tests stay synthetic, bounded and
  loopback-only. Stable tags/releases need a separate explicit decision.
- Keep source/build/report provenance exact. The private machine evidence is
  `D:/Codex/Kestrel/work/sprout-production-state.json`; do not put private
  application data or credentials into this public Markdown file.

## Done and verified

| Work | Evidence and practical limits |
| --- | --- |
| Native/runtime foundation, exact values, SQLite and migrations, workflows, bundles/packages, host SDKs, editor and playground | Existing feature docs and cross-platform regressions; development contracts remain version-pinned |
| Runtime/store and SDK security fixes | Reproduced failures, bounded regressions and preserved earlier CI observations; agent review is not an external professional audit |
| Opt-in HTTP aggregate metrics | Fixed categories without request contents; installed Python suite completed 68 tests with one POSIX skip |
| Windows Unicode interpreter arguments and filesystem boundaries | 14 installed controls passed; bounded bundle path guard; old code-page package metadata migration documented |
| Staged installer publication and truthful cleanup/PATH status | 15 controls, PowerShell 5.1 checks and peer review; OS cleanup refusals remain explicit |
| Finite SQLite backup/restore/upgrade rollback exercise | Five exact restored contacts, six clean hosts and 12/12 worker exits; point-in-time recovery, not crash/supervisor/eight-hour qualification |
| Integrated candidate and existing installation | `db6b598` passed all eight jobs in [CI 38234599062](https://github.com/fizzexual/Sprout/actions/runs/38234599062) on its first attempt; installed native SHA256 `4cd9f4aa893808ee10cc9fed128bddfc1ef980364977f0be265eb7817157d24f`; remains `0.2.0-dev` |

The earlier `eac6d5b` run [38233671926](https://github.com/fizzexual/Sprout/actions/runs/38233671926)
failed its Windows link-spelling fixture, with seven jobs passing. The corrected
fixture compares the observed link target exactly. That failure remains recorded.

## Active batch: application inputs and safer service adoption

| ID | Deliverable | Owner and files | Acceptance / current state |
| --- | --- | --- | --- |
| F000 | Markdown work queue and recurring continuation | Root: this file, automation prompt, private state, CI integration | In progress: task must read this file and continue unblocked work after each verified batch |
| F001 | Pure declarative input validation | `/root/stdlib`: `lib/validate.sprout`, `src/tests/validation_library_test.py`, `docs/validation.md`, `examples/validation/order-input.sprout` | In progress: nested schema, aggregated bounded field paths, strict exact kinds, missing/null policy, invalid-schema rejection, no input mutation or I/O; native and WASM evidence required |
| F002 | Read-only project doctor | `/root/distribution`: `tools/project_doctor.py`, `src/tests/project_doctor_test.py`, `docs/project-doctor.md` | In progress: bounded project/package/native diagnostics and structured JSON; no project execution, repair or network; identity/profile uncertainty and optional bounded trusted version probe must be explicit |
| F003 | Contacts API with pagination and durable request keys | `/root/editor_tooling`: `examples/services/contacts_api.sprout`, `integrations/python/test_contacts_api.py`, `docs/contacts-api.md` | In progress: bounded keyset pages, transactional POST idempotency, changed-payload conflict, concurrent same-key consistency, restart persistence and bounded real native SQLite tests; original contacts/recovery fixtures stay untouched |

Root integrates and commits verified work. Feature owners hand off exact file
hashes, test results and limitations before peer review. Root owns this ledger;
agents report updates rather than editing it concurrently.

## Next unblocked work

Choose the first item whose dependencies are verified. Scope its API and file
ownership before implementation; keep each item independently reviewable.

| ID | Work | Why it helps / acceptance |
| --- | --- | --- |
| N001 | CSV import validation example using F001 | Turn dirty application data into accepted rows and bounded row/field errors; preserve exact identifiers/money and demonstrate dry-run behavior with synthetic CSV |
| N002 | Pure layered configuration module | Merge explicit defaults, file maps and CLI overrides with schema validation and provenance; no ambient environment access, mutation or secret logging |
| N003 | Node SDK bounded request queue | Add useful concurrency/backpressure/cancellation without sharing VM state; test queued cancellation, overflow, timeout and complete owned-worker cleanup |
| N004 | Reusable application request/result contracts | Small source module for method/route/field validation and bounded response errors; test against the contacts example and current Python/Node host contracts |
| N005 | Workflow progress tooling | Make partial/failed/uncertain job state easier to inspect and explain without replaying effects; read-only exact checkpoint fixtures and concise actionable output |
| N006 | Representative rules migration example | Add a second synthetic pricing/validation workflow with pinned host-language parity, exact-value cases and rollback instructions; never read private application source |
| N007 | Performance measurements for new libraries/services | Publish workload-specific cost/limits with frozen inputs and bounded synthetic data; performance claims require measured comparisons, not syntax or test counts |

As items complete, record their exact evidence below, move them to Done, and
add the next useful scoped item. New priorities from the human supersede this
order. Do not silently broaden an item into a public deployment or stable release.

## Remaining release and deployment gates

| Gate | State / next action |
| --- | --- |
| Eight-hour qualification of the final changed candidate | **Pending by explicit user choice.** Wait until the user reviews this PC's time synchronization and confirms a reviewed or alternative environment is ready. Do not launch or retry a sustained workload while pending. |
| Original frozen eight-hour evidence | Original `86` failed duration/health qualification; separate data/cleanup diagnostic observed 115,200 contacts and 117,933 exits. Final `d9` stopped after 1,115.532 seconds on a confirmed 2.5843477-second backward clock step; 4,464 contacts and 4,570 exits are diagnostic observations. Both remain unqualified and immutable. |
| New agreed sustained run | Freeze final native/source/header/SDK/harness inputs and fresh trusted review inputs before launch. Preserve v2 policy SHA256 `e0fa18931226ba2c181d2700dea0da3e91fc9cba878c551232298cb9342bd0ee`; independently verify exact clocks/raw duration, actual SQLite data, lifecycle/thread baselines, cadence and resource/storage limits. Never reuse the failed candidate's sealed trust. |
| Actual supervisor/crash recovery and representative deployment | Finite cold recovery and compiled/adapter tests do not establish these platform-specific behaviors. Keep limits explicit and scope any future rehearsal separately. |
| Independent external security audit | Agent peer review and sanitizers are evidence for tested cases; external professional review remains separate. |
| Live Paper and stable release | Live server use awaits the owner's EULA decision. No stable tag/public service/paid infrastructure is authorized. |

## Batch evidence log

- 2026-10-12: Continuing development resumed by the human; existing agent team
  assigned F001–F003. Baseline Git state was clean on documentation `a93739d`.
  Both original frozen reports/inputs were rechecked unchanged. New features
  above are planned/in progress and have not yet passed integrated CI.
