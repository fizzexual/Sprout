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
| Ongoing Markdown queue and scheduled continuation (F000) | Work ledger saved in `31f33c6`; the existing scheduled task is active every 15 minutes and reads this file before choosing active/unblocked work; later stop/pause still overrides it |
| Validation, project doctor, paginated retry-safe contacts, CSV dry-run, explicit builtins/editor, layered configuration, overload teardown and diagnostic controls | `8dd5d4c` passed all eight jobs in [CI 38284544805](https://github.com/fizzexual/Sprout/actions/runs/38284544805) on its first attempt. Earlier failed revisions remain below; these development contracts do not qualify the pending sustained deployment. |
| Current Windows installation | Normal native SHA256 `94a468c820833b1f0fb26af329e9aed5b07bd892964922254f5e293261a7fbf6`, built from all19 exact Git inputs. Installed intrinsic22/configuration16/Python88 controls completed (one POSIX skip); Unicode13 passed then its missing-compiler setup control completed separately with pinned GCC. Initial failed invocation retained;4CD rollback preserved; still `0.2.0-dev`. |

The earlier `eac6d5b` run [38233671926](https://github.com/fizzexual/Sprout/actions/runs/38233671926)
failed its Windows link-spelling fixture, with seven jobs passing. The corrected
fixture compares the observed link target exactly. That failure remains recorded.

## Earlier batch: application inputs and safer service adoption

| ID | Deliverable | Owner and files | Acceptance / current state |
| --- | --- | --- | --- |
| F001 | Pure declarative input validation | `/root/stdlib`: `lib/validate.sprout`, `src/tests/validation_library_test.py`, shared `src/tests/validation_library_test.sprout`, `docs/validation.md`, `examples/validation/order-input.sprout` | Initial FF485 module: 18 native/nine GC controls and old-name false passes fixed. N008 follow-on: six explicit native calls, 19 boundary/ten GC controls on private A394 and preserved negative preimage. Requires pinned intrinsic-capable runtime; new complete CI pending. |
| F002 | Read-only project doctor | `/root/distribution`: `tools/project_doctor.py`, `src/tests/project_doctor_test.py`, `docs/project-doctor.md` | Ready for integration: Windows 26 passed/two platform skips; independent offline Linux 28/28 passed including real symlink/FIFO controls. Read-only bounded diagnostics and optional trusted version-only probe; fresh CI pending. |
| F003 | Contacts API with pagination and durable request keys | `/root/editor_tooling`: `examples/services/contacts_api.sprout`, `integrations/python/test_contacts_api.py`, `docs/contacts-api.md` | Peer approved: owner/peer each passed 14 real native controls; additional independent SQLite oracle verified retry/conflict/rollback semantics. Original contacts/recovery fixtures untouched; fresh complete CI pending. |

Root integrates and commits verified work. Feature owners hand off exact file
hashes, test results and limitations before peer review. Root owns this ledger;
agents report updates rather than editing it concurrently.

`e19787a` was pushed and [CI 38272445193](https://github.com/fizzexual/Sprout/actions/runs/38272445193)
finished with five of eight jobs passing. Actual WebAssembly, ASan, UBSan, Docker
and Paper passed. All three native jobs stopped at the old mocked WebAssembly
harness: its fake filesystem lacked `mkdirTree` and still expected only one
normal-mode invocation. Root reproduced the failure and updated the mock to
assert the real mounted library/shared corpus plus the separate sandboxed
supplied-source invocation. All 82 editor/playground/Node/application tests now
pass locally. The original failed run is preserved; a fresh corrected-revision
CI run remains required before marking F001–F003 Done.

The corrected `437af0a` [run 38273452312](https://github.com/fizzexual/Sprout/actions/runs/38273452312)
finished seven of eight jobs passing. Windows passed the new foundation and
bounded workload contracts, then its healthy PowerShell upgrade fixture hit the
unchanged 15-second deadline. A second subcase reused that directory and saw the
first attempt's leftover stage. The original timeout's cause remains unknown;
one bounded unmodified local reproduction passed. A pure stub reproduced the
case-contamination defect. The driver now uses separate scenario directories,
retains failed-stage observations, and records bounded timeout/direct-shell
cleanup diagnostics without claiming descendant termination. Four focused peer
controls and all 19 local installer/driver controls passed. No shipping installer
change, deadline extension, job retry or successful full-CI claim follows from
those local results. The next integrated revision still needs all eight jobs.

## Earlier batch: imports and intrinsic lookup

| Item | Owner and scope | State |
| --- | --- | --- |
| N001 | `/root/stdlib`: five new CSV dry-run example/docs/test files | Peer approved: original4CD/FF485 controls plus independent CSV/Decimal oracle; integrated A394/migrated validator18 controls passed. Exact IDs/money, bounded errors/preview, no persistence; fresh CI pending |
| N008 runtime | `/root/distribution`: native parser/evaluator/formatter, dedicated intrinsic controls and documentation | Root approved: candidate A39422 controls, legacy frozen compatibility and SDK/Node integration passed; six F001 calls migrated. Private build inputs frozen; new WASM/full CI and verified install promotion pending |
| N008 editor | `/root/editor_tooling`: editor indexing/help/navigation/rename and controls | Peer approved: 52 controls, preserved/fixed newline diagnostic observation, exact native registry parity, ordinary lexical names retained. New complete CI pending |
| R001 | Root: Windows installer regression driver; `/root/distribution` read-only peer | Corrected confirmed case contamination and retained failure diagnostics; initial CI timeout cause unknown; 19 local controls and final5 diagnostic controls on Windows/Linux passed, next full CI pending |

N002 was subsequently selected and implemented in the separate integration
below. Later edits do not change the exact revision used by an earlier CI run.

The `b39afb6` [candidate CI 38277853794](https://github.com/fizzexual/Sprout/actions/runs/38277853794)
also finished seven of eight jobs. New native/intrinsic/validation/CSV/editor,
rebuilt WASM and sanitizer contracts passed; Windows stopped at an existing
metrics-capacity test with a lost overload response (`10053`). All failed reports
remain immutable. Separate bounded loopback fixtures reproduced complete 503
loss when a client sent its request after full close, matching the observed
error class without claiming the exact remote cause. R002 now half-closes then
discards bounded bytes using the remaining original deadline; it admits no new
handler/worker and keeps attempted-response counters honest.

## Completed integration: configuration and overload teardown

| Item | Owner and exact scope | Evidence / next action |
| --- | --- | --- |
| N002 | `/root/stdlib`: five new pure configuration module/docs/example/test files; `/root/editor_tooling` peer | 16 owner controls/eight GC corpus on A394 and 16 root controls on canonical94 passed; seven focused peer controls and a separate 24-case exact-type oracle approved. Explicit layers, detached values, provenance, bounded errors, no ambient I/O; fresh actual WASM/full CI pending |
| R002 | Root: Python service capacity teardown + dedicated controls; `/root/distribution` peer | Preserved old late-write response loss; six corrected controls passed on Windows/offline Linux, full Python88 completed with one POSIX skip. Final remaining-send-deadline delta and integration wiring peer approved. Exact503, original total0.2s/64KiB cap, no new handler/worker; fresh full CI pending |
| Installation provenance | Root: exact Git-byte normal build | Canonical b39 binary94 built from all19 Git inputs with no warnings; intrinsic22/validation19/CSV18 passed. Prior A394/raw-Git binding false and separate CRLF-only diagnostic preserved. Installed4CD remains until final complete CI and source/build verification |

N003 Node queue and N004 application-contract designs are ready, with explicit
acceptance gates. Their implementations are now selected as the next separate
batch. Do not mistake later edits for coverage by an earlier frozen CI revision.

`479c59e` [CI 38282360254](https://github.com/fizzexual/Sprout/actions/runs/38282360254)
finished seven of eight jobs passing on its first attempt. Windows completed
the overload, installer and host checks, and actual configuration WASM and both
sanitizers passed. macOS failed its eight-worker .NET concurrency control with
`SproutWorkerException: Operation canceled`; prior cancellation/recovery controls
passed. The native status/system code was not printed. Preserve this failure,
keep the candidate unpromoted and investigate without retries or longer budgets.
Installed native remains4CD.

The test-only `8dd5d4c` revision is running one fresh
[CI 38284544805](https://github.com/fizzexual/Sprout/actions/runs/38284544805).
Its per-worker diagnostics retain the identical primary exception even when
the diagnostic sink fails; no shipping SDK/native behavior, test deadline or
worker count changed. A Windows source-copy check passed nine controls using
cached net10 references; the repository Host target remains net8 and still
requires this exact CI. Both local fixture setup failures remain recorded.

That run subsequently completed all eight jobs successfully on its first
attempt. Installed native94 is now verified as described in Done. A passing
fresh run does not explain the earlier macOS startup or PowerShell timeout;
both observations remain recorded. N003–N005 below need their own exact CI.

Review also found that some earlier standalone F001/N002 corpus commands used
an unsupported `--gc-stress` flag. Those local pass counts are ordinary corpus
checks, not GC-stress evidence. Preserve their original artifacts. Actual GC
evidence comes separately from the inherited `SPROUT_GC_STRESS=1` ASan CI runs.
N005's new test had the same mode mistake; its test-only correction and focused
six-case run use the actual environment switch, with the original check retained.

## Integrated batch awaiting correction: worker backpressure and application contracts

| Item | Owner / isolated files | Acceptance / state |
| --- | --- | --- |
| N003 | `/root/distribution`: Node SDK, dedicated queue controls and Node documentation; root peer | Ready for integration:45 Node controls, two preserved/fixed signal-close/admission races and independent exact replay. Bounded FIFO admission, queued cancel/expiry without spawn, confirmed direct-worker slots/cleanup, fail-closed uncertainty; fresh multi-platform CI pending |
| N004 | `/root/editor_tooling`: new pure `lib/api.sprout`, native/shared controls, docs and separate synthetic contacts-preview example; `/root/stdlib` peer | Ready:22 native controls including10 actual GC cases,82 independent peer controls and two root Node/native parity cases. Full JSON plus two-byte newline reservation enforces physical Windows cap; original overflow and root decimal-fixture error retained. Literal routes/exact values/private-safe errors, no implicit auth; actual new WASM/full CI pending |
| N005 | `/root/stdlib`: five new pure workflow-progress module/example/docs/control files; `/root/editor_tooling` peer | Ready:13 native functional controls, corrected actual six-case GC run,65 independent state oracles and six CLI controls. Bounded read-only recorded-state summary, unchanged checkpoints/locks, no replay/liveness/retry/authenticity claim; actual new WASM/full CI pending |
| R003 | Root: .NET test-only per-worker failure diagnostics and private bounded complements | Peer approved: bounded status/exit/system-code observations, identical primary exception even when diagnostic sink fails, same eight workers/deadlines and no SDK/core change. Nine Windows source-copy controls passed using cached net10 references; shipping net8 Host framework unchanged and awaits CI. Initial missing net8 assets/noexec Linux fixture failures retained; Linux24 synchronized ABI calls passed and reaped all direct children, without reproducing or explaining macOS |

Root's independent N003 peer fixture reproduced a close/dispatch race in the
first frozen implementation: an observable getter on an actual AbortSignal
closed the queue while a waiting ticket was shifted for dispatch, then that
ticket started after close had resolved. The exact source and modeled report
are preserved. A second supported-signal getter could leak a listener and
preparation reservation. Both corrections/regressions passed; independent root
replay confirms no post-close launch and recovered admission. Earlier41/44
results stay separate. No OS process was started by the peer models.

## Current corrective batch and active owners

`3e0238e` [CI 38287634384](https://github.com/fizzexual/Sprout/actions/runs/38287634384)
finished with three of eight jobs passing on its first attempt. Windows, Docker
and Paper passed. Preserve all five failed logs and the exact original revision:

- Linux, ASan and UBSan stopped in the workflow-progress atomic-reader fixture.
  An independent offline Linux reproduction confirmed buffered `readline()`
  consumed bytes later bypassed by `communicate()`. The test-only correction
  uses owned unbuffered pipes and a flushed READY/GO handshake. Owner Windows
  and Linux checks retained all16 complete observations,16 real replacements,
  original deadlines and data/lock assertions; the independent peer approved.
- Rebuilt WebAssembly passed all10 API assertions, then the summary checker
  rejected its ANSI-colored `10 passed` line. Root corrected only the checker
  and added wrong-count negatives. The peer approved; actual WebAssembly must
  still complete the subsequent six-case progress corpus on the new revision.
- macOS failed the actual GC-stress API corpus on the unknown-body validation
  path. Bounded Windows and optimized offline Linux probes passed and have not
  reproduced its cause. These passes do not explain the macOS observation.

| Item | Active owner / files | Acceptance / current state |
| --- | --- | --- |
| R004 | `/root/stdlib`: `src/tests/workflow_progress_test.py`; `/root/editor_tooling` peer | Test-only stdout framing correction frozen and peer approved; original fragmented output preserved; fresh full CI required |
| R005 | Root: `playground/tests/wasm-smoke.js` and mock controls; `/root/stdlib` peer | ANSI-aware exact summary counts, eight wrong-count negatives and two mock controls passed; no new actual-WASM claim |
| N010 | `/root/distribution`: scoped precise GC environment roots in `src/sprout.c`, `src/ergonomics_calls.h` and dedicated regression fixtures; `/root/editor_tooling` independent peer | Frozen and peer approved: active/prepared/suspended scopes and normal/error recovery. Eleven Windows minimal-core controls, final five driver controls and independent byte-boundary oracles passed in separate runs. Linux sanitizer cohort remains failed; no combined16/full-SQLite claim. New canonical build/full CI required before installation; macOS cause remains unconfirmed |
| N006 | `/root/stdlib`: new synthetic order-quote example, Python/Node baselines, parity fixtures and docs; root peer | Frozen and peer approved:58-case independent baselines, corrected portable pin controls and14 additional rational-oracle checks. Exact cents/IDs, explicit discount ties/rounding/shipping, no partial quote; fresh full CI required |
| Integration | Root: CI wiring, source/build binding, readiness docs and this ledger | Preserve the installed native94 and both failed long-run reports. No sustained test, clock change or CI rerun; one fresh reviewed revision after the corrective batch is ready |

N006's owner checks matched all58 synthetic cases against separate Python and
Node baselines. Root's additional14 baskets matched an independent exact-rational
oracle and checked int64/Decimal host types. A pre-CI review caught CRLF-sensitive
raw source pins; the corrected controls explicitly hash strict UTF-8 text with
CRLF pairs normalized to LF, while retaining the original raw snapshots. Bare CR,
BOM, invalid UTF-8 and content changes are still rejected. Owner14 semantic groups
and the two changed pin controls remain separate results. Independent wiring
review approved the native/sanitizer/release and ordinary-collection WASM scopes.

The first Windows full-SQLite core compile hit its150-second supervisor before
producing a binary. That failure is retained. A separately identified optimized
minimal Windows core passed11 controls after two test-only fixture corrections
(CRLF summary framing and an invalid outside-test expectation). These results do
not qualify a full-SQLite build or installation. The original Linux sanitizer
fixture first failed execution from a noexec temporary mount. After that setup
correction, its controller exited by SIGKILL with an unexplained cause. A separate
capped producer captured continuous `AddressSanitizer:DEADLYSIGNAL`; its OOM
counters did not increase. That probe does not establish the controller's cause.
The test driver is now being bounded without extending its original15-second
execution deadline; a cap or sanitizer failure must remain a failure.

The final driver also puts stdin write/close under owned-thread supervision:
independent review demonstrated that synchronous writing could delay the first
deadline check even with only four bytes. Five final driver controls and separate
peer byte-boundary checks passed. The15-second supervised I/O limit remains;
process creation and bounded cleanup are separate OS boundaries. Single ASan
version and scalar complements passed without diagnostics, but do not relabel
the failed cohort or explain its bundle signal flood. No shipping code is being
edited while root freezes the reviewed integrated revision.

N007 performance and N009 capability metadata remain saved designs, with no
measurements or shipping implementation yet. Select them after this corrective
batch; do not repeat completed tests merely to populate the queue.

## Next unblocked work after the current batch

Choose the first item whose dependencies are verified. Scope its API and file
ownership before implementation; keep each item independently reviewable.

| ID | Work | Why it helps / acceptance |
| --- | --- | --- |
| N007 | Performance measurements for new libraries/services | Publish workload-specific cost/limits with frozen inputs and bounded synthetic data; performance claims require measured comparisons, not syntax or test counts |
| N009 | Runtime capability metadata and explicit adoption preflight | Design a bounded read-only command exposing compiled capabilities/host ABI so a development version string cannot be mistaken for intrinsic/SQLite support; no project execution, permission guarantee or network; native/WASM/profile parity and independent review required before implementation |
| N011 | Error-safe argument-preparation allocation ownership | Peer source review found raw argument-position storage bypassed by a later argument/default error. First pin one bounded allocation-count reproduction with successful-call controls, then fix confirmed leaks with peer review and fresh CI; no whole-heap claim from ENV-root counts |
| N012 | Explicit registered-type environment reachability | Normal files/modules have existing home roots. A type-only wizard file has a structural registry-home concern; bounded ordinary/stress probes passed and have not reproduced a runtime failure. Require a controlled collector reachability negative before proposing a shipping correction; nested task-local methods remain unsupported by the parser |

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
| Windows installer CI observation | `437af0a` healthy PowerShell upgrade timed out at 15 seconds; original cause unknown. Correct driver isolation/diagnostics with unchanged deadlines, preserve the failure and require fresh complete CI before promotion. |
| HTTP capacity teardown | `b39afb6` observed10053. Local late-write fixtures independently reproduce lost503; correct bounded teardown and require new complete CI before promotion, retaining the exact remote-cause uncertainty and bounded delivery limits. |
| macOS concurrent .NET worker startup | `479c59e` failed with Operation canceled in the existing eight-worker control after earlier cancellation/recovery passed. Prior unexplained macOS startup observation stays recorded. Linux24 synchronized ABI launches passed; no macOS root-cause claim. Add bounded test diagnostics while retaining exact errors/deadlines and require fresh complete CI; repeated clean results alone do not explain this observation. |
| Independent external security audit | Agent peer review and sanitizers are evidence for tested cases; external professional review remains separate. |
| Live Paper and stable release | Live server use awaits the owner's EULA decision. No stable tag/public service/paid infrastructure is authorized. |

## Batch evidence log

- 2026-10-12: Continuing development resumed by the human; existing agent team
  assigned F001–F003. Baseline Git state was clean on documentation `a93739d`.
  Both original frozen reports/inputs were rechecked unchanged. New features
  above are planned/in progress and have not yet passed integrated CI.
- 2026-10-12: F001 local controls passed on native `4cd9f4aa`; its offline
  Linux UBSan controls use a separately identified cached prefeature runtime.
  The shared eight-test corpus also passed Windows GC stress. F003 passed
  14 real native controls. Its first maximum-int64 fixture demonstrated a new
  lower random row ID; the append-only example now uses checked AUTOINCREMENT
  behavior, retains replay at exhaustion, and documents sequence gaps/overhead.
  The failed pre-fix observation remains in private evidence. Independent peer
  review and exact final integrated CI remain pending for these new files.
- 2026-10-12: Independent review reproduced two F001 false passes under legal
  global types named `number` and `visit`, on exact native `4cd9f4aa` and the
  original F001 source. The old source/outputs are preserved. Library-only
  corrections are active; generic builtin-name interference remains a trusted
  source boundary until separately addressed by N008. F002 passed all 28 offline
  Linux controls. F003 peer review also verified exact rows/rollback through an
  independent read-only SQLite oracle.
- 2026-10-12: Final F001 corrections passed the original two collision bodies
  in separately preserved post-fix evidence and two new independent controls.
  All 82 combined Python host/service tests completed on installed native
  `4cd9f4aa`, with one POSIX-only skip. F002 also passed an explicit trusted
  version-only probe against that installation; without a matching profile
  record it correctly reports SQLite capability as unknown. No interpreter,
  SDK, original contacts fixture, installation or sustained policy changed.
  F001–F003 await one fresh integrated cross-platform CI run.
- 2026-10-12: Preserve the `e19787a` five-of-eight CI failure and local mock
  reproduction. Its actual WASM validation corpus and both sanitizer jobs
  passed; mock-only correction keeps capability negatives and fresh-filesystem
  assertions and adds shared-source/mount/sandbox wiring checks. Start N001/N008
  as the next isolated feature batch while corrected CI is prepared.
- 2026-10-12: Preserve the separate `437af0a` seven-of-eight result and Windows
  raw failure log. Local installer/driver correction passed 19 controls after
  independent peer review; no installer behavior changed. N008's private normal
  SQLite candidate passed 22 native controls and 101 combined editor/Node/app
  tests. Root replay preserved nine legacy exit/output observations; one saved
  stderr string had earlier encoding damage, so a separate raw-byte comparison
  proved that baseline/candidate diagnostic bytes match. All failed comparison
  artifacts remain preserved. N001 has 18 local controls and peer review active;
  rebuilt WASM and final candidate CI remain required.
- 2026-10-12: N001 independently verified capped mixed errors, exact currency
  overflow/carry and read-only input observations; its original4CD/FF485 evidence
  remains separate from the new A394/migrated-library18-control run. N008 editor
  has 52 passing controls after the reproduced newline correction. F001 now uses
  six explicit native operations and passed19 boundary/ten GC tests; the archived
  FF485 negative control remains. Native installation is still4CD pending new
  candidate full CI. All source owners are frozen for one integrated commit.
- 2026-10-12: b39's first CI remained7/8; no installation promotion. Root built
  canonical native94 directly from19 committed Git-byte inputs after preserving
  the old three-file raw EOL binding mismatch. All59 intrinsic/validation/CSV
  controls passed on94. R002 fixes the reproduced TCP close response loss within
  the original0.2s and64KiB limits; Python88/one POSIX skip passed. N00216 native
  controls passed separately on94. Both additions subsequently passed peer
  review, including configuration's independent exact-type oracle and the
  service's remaining-send-deadline guard. Fresh actual WASM/full CI remains;
  the original eight-hour gate is still held by the human.
