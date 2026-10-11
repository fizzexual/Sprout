# Trusted private service profile

These are local deployment examples for one trusted Sprout HTTP/SQLite worker.
They do not start or install a service. The Python bridge and nginx listener
both bind loopback by default; publishing a listener requires an explicit
operator decision and a network/access policy. This profile does not accept
untrusted source, implement multi-tenant authorization, or replace application
schema validation. See [production readiness](../docs/production-readiness.md).

Keep the native executable, Python SDK, worker source, modules, and lock files in
an immutable versioned directory controlled by the deployer. Run under a separate
unprivileged service identity with only its data directory writable. Pin source
and file hashes, build native SQLite support, and validate a candidate using the
real application fixtures before changing the active directory. The example
unit's absolute paths and account must be provisioned for the target host.
`--cwd /var/lib/sprout` places relative SQLite paths and worker stores in the
writable state directory while executable/source files stay under `/opt/sprout`.
The state directory must already exist. Without this option the bridge uses the
source file's directory, independently of the supervisor's working directory.

`sprout-service.service` configures eight handlers, 5-second worker timeout,
64 KiB bodies, a 512 MiB service cgroup, 128 tasks and 512 descriptors. These are
starting workload bounds, not measured capacity promises. POSIX SIGTERM stops
acceptance and drains bounded handlers. `KillMode=mixed` sends the initial stop
to the bridge, then the supervisor can kill remaining cgroup processes at the
15-second stop deadline. Completed database commits remain completed. Tune and
test these limits on the actual machine. Windows needs an equivalent supervisor
and identity/filesystem policy; this Linux unit is not a Windows service.

The bridge has a 32-connection backlog, a 2-second input socket deadline, and
streamed worker-output bounds. Saturation returns 503; malformed framing/JSON
returns 400; body limits return 413; worker failures return bounded 502/504.
The contacts example's short SQLite lock wait returns 503 on contention and 409
for duplicate email. Do not retry a mutation blindly after a lost response:
a worker may have committed before the client disconnected. Implement an
application idempotency key and durable result if retries must be safe.

The nginx example requires separately supplied TLS certificate/key and a hashed
HTTP Basic password file; no credential or private key belongs in this repo.
It protects every route, including `/health`, before forwarding, clears client
Authorization, buffers and limits requests, bounds upstream time, avoids automatic
upstream retries, and logs method/status/timing without query strings, bodies or
credentials. It cannot give a Sprout worker a verified caller identity: the bridge
currently passes method/path/query/body only. Use a host framework with an
authenticated identity envelope for per-user permissions. Basic authentication
is suitable for this private operator profile, not a complete public identity
or account system. TLS and access rules come from the proxy's
[TLS](https://nginx.org/en/docs/http/ngx_http_ssl_module.html),
[authentication](https://nginx.org/en/docs/http/ngx_http_auth_basic_module.html),
and [proxy](https://nginx.org/en/docs/http/ngx_http_proxy_module.html) contracts.

`/health` is liveness: it responds without running the program or checking its
database. Before promotion and after restart, run an authenticated application
read such as `/contacts` and verify its schema, then execute the deployment's
independent data oracle. No readiness endpoint, metrics exporter, online source
reload, per-route permission policy, or complete request-audit trail is supplied.
Supervisor/proxy logs, an external application readiness probe, alerts, and log
rotation are deployment responsibilities.

For a rolling change, stop forwarding new work to the old instance, drain it,
back up SQLite using a consistent database backup, start the candidate against a
private restored copy, and verify read/write/rollback behavior. Only then migrate
and switch traffic. Retain the prior runtime/source and a tested data restoration
path. An older worker may not understand newly committed schema; reverting only
the executable is not a database rollback. Test restart, SIGTERM during active
work, database lock/storage errors, quota exhaustion, and recovery with the
actual platform supervisor. Record the build and workload hashes with the run.

Before using the examples, validate `nginx -t -c <absolute-config>` with real
private certificate paths and `systemd-analyze verify <unit>` on the deployment
host. No certificate issuance, public listener, DNS change, firewall change,
system installation, or cloud service was performed by this review.
