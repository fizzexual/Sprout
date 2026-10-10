# Where Sprout fits in this GitHub stack

Start with a narrow implementation layer and retain the host's platform tools.
Sprout workers exchange typed JSON; hosts control permissions, scheduling and
when results become live behavior. This permits gradual migration and rollback.

| Existing projects/languages | First Sprout replacement | Keep in the host |
| --- | --- | --- |
| TotalReach / Mineen / MamaSQL: TypeScript and JavaScript | Pricing, validation, report generation, scheduled automation via the Node SDK | React/Next/Svelte UI, websocket/session handling, desktop platform APIs |
| frameatlas / cyber: Python | Transformation rules, CSV/SQLite reports, workflow coordination, selected API handlers via Python workers | PyAV/Pillow media engines, HTTP framework infrastructure and Python packages |
| Magmafun / Skript gameplay scripts: Java and Skript | Join/reward/mob rules through a bounded Paper adapter; expand only after server validation | Paper events, tick scheduling, player/world APIs and permissions |
| TaskManager: C# and ASP.NET | Replaceable business rules through the .NET/native host boundary | ASP.NET hosting, authentication, Dapper/PostgreSQL connectivity |
| prodstamp: Go | Validation/policy workers through the Go/native host boundary | Container execution, process supervision and infrastructure tooling |
| kestrel-sql: Rust | Configurable query/report policies through the C ABI or a JSON worker | Storage engine internals, allocation control, indexing and concurrency |
| VeloTravel: Kotlin/Android | Server-side or externally hosted rules first | Compose, Android lifecycle, device APIs and native packaging |

The first finished app is the offline CSV dashboard. The first service example
uses a Python HTTP host with Sprout validation and parameterized SQLite queries.
Native language SDKs share a process ABI instead of duplicating VM heaps. SQLite
is the supported in-language database foundation; PostgreSQL/Prisma ecosystems
remain host integrations until real drivers and transaction tests exist.

The strongest practical direction is readable, replaceable rules combined with
checkpointed automation. Exact money and binary values cross host boundaries
without silently changing representation. Parallel work is bounded and joined;
workflow recovery distinguishes completed, failed and uncertain side effects.
Complete-project bundles and verified lockfiles make those tools distributable.

These are adoption targets grounded in the repositories inspected for this task.
They do not establish that a complete application has already migrated, that the
bytecode experiment is faster, or that mobile/browser hosts can spawn native
processes. Select a representative workload, compare behavior and operational
costs, then move the next layer after its failure/recovery tests pass.
