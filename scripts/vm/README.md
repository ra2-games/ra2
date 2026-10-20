# Source-built v86 CPU

`pnpm run build:cpu` builds the installed v86 dependency from its matching upstream
revision with `patches/v86-single-step.patch`. It replaces only the local installed
WASM inode, preserving pnpm's content store. No game program is downloaded or selected.

The first build requires Rust and its `wasm32-unknown-unknown` target, clang, lld,
make, git and Python 3. Run `rustup target add wasm32-unknown-unknown` after installing
Rust. `dev`, `build`, `check` and `test:unit` invoke this build; direct Vitest invocations
require running it first. CI explicitly installs rustup, the stable Rust toolchain
and the WASM target, including on runners without Rust preinstalled. The owned
source checkout, build signature and reusable `cpu.wasm` artifact live under
`node_modules/.cache/ra2vm-v86`; deleting that directory forces rebuilding.
A matching cached artifact is installed into each fresh pnpm dependency tree using
an inode replacement. Missing, invalid or outdated cache entries trigger a build.
The signature includes the dependency version, patch and build script.
`V86_SOURCE_REPOSITORY` may point to a local upstream clone for an offline source
checkout; Cargo dependencies and Rust's target must also be available.

The patch targets v86 `0.5.441+g847e34d`, source revision
`847e34d5499b17b90d2783d5342ddd243c753497`, files `src/rust/cpu/cpu.rs`
and `src/rust/jit_instructions.rs`. Preserve the upstream BSD license in
[v86.LICENSE.txt](../../public/licenses/v86.LICENSE.txt), including binary distributions. Vite copies this notice to `dist/licenses/`.

Upstream clears EFLAGS.TF as unsupported. The patch retains TF, executes one real
instruction with the existing interpreter, and delivers the actual #DB interrupt.
Instruction faults retain priority. POPF returns out of compiled/interpreted blocks
when TF becomes set. This supports native debugger continuation without inventing
instruction completion. It does not establish complete x86 debug-register, REP,
or interrupt-shadow semantics. Regression cases are in
[debugger.e2e.test.ts](../../tests/basic/vm/debugger.e2e.test.ts).

The build signature hashes dependency inputs only for cache invalidation. It is
unrelated to game executable hashes or admission policies.
