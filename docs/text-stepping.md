# Finite text-stepping regression contracts

This regression package preserves six shared Sprout test groups and
sixteen small C helper cases. The runtime correction caps nominal UTF-8 advances
at the text terminator. It retains existing valid text and complete legacy byte
grouping; it does not validate or normalize all strings or change `char` into a
Unicode-codepoint constructor. Invalid legacy text is compared as ASCII byte
hex, never emitted as JSON text. Strict JSON rejection remains a checked case.

The public package and wiring passed independent source review and three
portable modeled controls. The first integrated candidate passed actual WASM
and both separate sanitizer profiles; its full CI failed on other fixture and
decision stress gates. Three explicit native profiles and installation promotion
remain pending complete qualification. Compiler warnings are retained in the
minimal-build reports.
The earlier private corrected candidate
passed one normal6/actualGC6/helper16 profile; that evidence does not qualify this
new portable driver or explain any earlier platform incident. Original failures
and sources remain preserved.

From the reviewed checkout, explicitly select a newly built trusted interpreter
and trusted local C compiler:

```sh
SPROUT_TEXT_STEP_CC=cc python src/tests/text_stepping_test.py /absolute/path/to/new/sprout --report-dir /new/exclusive/report
```

On Windows, use the trusted cached compiler's absolute path and the newly built
native `.exe`. An omitted report directory creates a named retained temporary
directory and prints its path. An existing report directory is refused. Running
the driver without an explicit binary prints usage and executes nothing. It
never picks an installed runtime implicitly or launches a version/capability
query. The known preserved original1544 binary is explicitly refused; a hash
check cannot prove that an arbitrary other executable is new, safe or derived
from this checkout. The caller must trust the interpreter, compiler and flags.
An unknown executable can execute arbitrary code despite these intended test
arguments. These controls are not an executable-authentication sandbox.

Parent `SPROUT_GC_STRESS` or `SPROUT_SANDBOX` presence, including an empty value,
is rejected before source reads, helper import, report creation or process
dispatch. The driver owns the normal and actual-GC environments. It preserves
other supplied sanitizer configuration. `SPROUT_TEXT_STEP_CC` selects one
trusted compiler executable; otherwise trusted `cc`/`gcc` is required and missing
compilers fail rather than skip. `SPROUT_TEXT_STEP_CFLAGS` follows the existing
trusted compiler convention (`shlex` splitting, default `-O2 -Wall`, at most4096
characters). The compiler/system headers, flags and ambient toolchain settings
are trust inputs, not authenticated or hermetic dependencies.

The sequence is fixed, with no retries:

1. One minimal C inclusion fixture compile, bounded by90 supervised seconds.
2. Explicit native shared six, normal collection.
3. The exact same native shared six with actual `SPROUT_GC_STRESS=1`.
4. The newly built minimal helper's sixteen cases and exact typed JSON result.

The helper compile is a separate test fixture, **not** the full-SQLite interpreter
build, native capability profile or evidence of a reproducible binary. The
driver supplies no SQLite define/vendor compile to that helper. Sanitizer
targets apply their trusted flags to this fixture separately. Its C source
includes the current repository `src/sprout.c`; the only change from the private
helper is that include path. The report records resolved compiler, native, host,
source/include inventory, compile argv/flags and helper binary identities.
All known nineteen native inputs plus the driver/corpus/C fixture/bounded helper
have distinct raw hashes and canonical UTF-8/LF source hashes. This is declared
snapshot correspondence, not a proof of every compiler-system-header input.

Each interpreter invocation retains the unchanged3000ms/five-million-step VM
limits. Each of the three payloads has a five-second supervised I/O deadline.
The separately reviewed helper supervisor retains32768 bytes per stream;
crossing the cap fails after a read chunk of at most4096bytes. This does not
prevent a child from generating more output. Process creation and filesystem
preflight/report operations are OS boundaries; direct child kill/wait1s and
reader joins0.5s each are separate bounded cleanup attempts. Unconfirmed cleanup
fails. There is no hard inclusive wall-time, resident-memory, process-tree or
descendant-isolation guarantee.

Known exit/capture/cleanup/stream evidence and the first failure are retained
before artifact writes. Secondary artifact, source/selected-file postflight and
report/sink errors do not replace an earlier primary. All postflight checks must
pass before a success marker. Nonzero/crash/sanitizer/capture/cleanup/stderr,
wrong/duplicate/nonzero-failure summary or wrong helper JSON fails and stops
later payloads. Compiler stderr is retained; compiler warnings alone are not
interpreted as a native semantic result. No reporting sink is guaranteed writable
or durable; unsuccessful reports/temporary files remain for diagnosis.

The independent portable source/fake checks run with:

```sh
python src/tests/text_stepping_driver_test.py
```

Those three groups refuse actual Popen before importing the driver. They model
at most six supervisor completions, including one compiler per modeled profile,
and check source adaptation, admission, complete three-payload success and
first-failure artifact/postflight handling. They do not run the Sprout or C
corpus, requalify the supervisor, or claim actual child reaping. Their direct
entry has a10-second controller timer; preflight/report OS calls remain distinct
boundaries. Fresh native/sanitizer CI runs the actual profile separately, and
actual WASM runs the unchanged six shared bodies in a fresh sandboxed instance
with strict complete6/0 summary acceptance. Finite regression evidence is not
production, exploitability or sustained-load certification.
