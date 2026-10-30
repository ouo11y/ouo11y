# dSYM symbolication of native iOS crashes (W7, 2026-10-29)

Built for work package W7 ([ADR-0011](../../docs/adr/0011-source-maps-and-symbolication.md) section 7, user guide [docs/symbolication.md](../../docs/symbolication.md)). Code: `services/rum-api/internal/sourcemap/dsym.go` (store, Mach-O, DWARF lookup) and `native.go` (frames, stack text). This entry records what is not obvious from the code.

## Address math

- `svma = instruction_addr - image_addr + image_vmaddr`: the address in the binary's own address space, which is what the dSYM's DWARF uses. `image_vmaddr` is `__TEXT`'s vmaddr (`0x100000000` for an app or a command-line executable), `image_addr` the load address with the ASLR slide.
- **Minus one for every frame after the first.** Those frames are return addresses: they point to the instruction after the call, which can be the next line or, at the end of an inlined body, another function. One byte back is inside the call instruction (arm64 instructions are 4 bytes). `atos` does not adjust, so to compare by hand pass `addr - 1` for frames 1 and up. Frame 0 is the faulting pc and is used as is.
- A frame without `image_addr` (the report leaves it out when the address is in no known image, such as dyld's start frame) finds its image by `[image_addr, image_addr + image_size)`.

## DWARF lookup with the standard library

- **`Reader.SeekPC` is not enough on real dSYMs.** dsymutil writes a unit's range as the span of its functions (`DW_AT_low_pc` + `DW_AT_high_pc` as a length), so units overlap: in a React Native Release dSYM, four units claimed one address and `SeekPC` returned `EXLegacyAppDelegateWrapper.m`, which has no code there. `parseDebugFile` lists every unit's ranges once (`Reader.SkipChildren` on a unit jumps to the next unit, so this is cheap) and `lookup` tries each unit that covers the address until one has a function DIE around it.
- File and line come from the unit's line table (`LineReader.SeekPC`). The function comes from the `DW_TAG_subprogram` / `DW_TAG_inlined_subroutine` DIEs whose `Ranges` contain the address, innermost last. The walk descends into every DIE with children (namespaces, types, lexical blocks) and skips the children of functions that do not contain the address.
- **Inlined chains**: the innermost function gets the line-table position; each outer function gets the inlined child's `DW_AT_call_file` (an index into `LineReader.Files()`, entry 0 is nil before DWARF 5) and `DW_AT_call_line`. This gives the same frames as `atos -i`.
- **Names**: `DW_AT_name`, else the name of `DW_AT_abstract_origin` (inlined and out-of-line copies) or `DW_AT_specification` (methods), else `DW_AT_linkage_name`. Swift's `DW_AT_name` is the base name (`level2`); `atos` prints the demangled linkage name (`level2(_:)`). Go has no Swift demangler; the e2e script compares base names for that reason.
- **Symbol-table fallback**: code compiled without debug info (in the RN sample: Sentry's Swift pods, `<deduplicated_symbol>` stubs) has no unit. The dSYM keeps the binary's symbol table, so `lookup` returns the nearest `N_SECT` symbol in `__TEXT,__text` before the address, with the leading `_` removed and no file. Swift symbols stay mangled (`$s6Sentry...`).

## Measured (2026-10-29, M-series Mac, `go test`)

TinyShop (Expo + `@sentry/react-native` + react-native-screens) Release simulator dSYM, 50.5 MiB universal, 26.5 MiB per slice, 423 units of which 158 have code ranges:

- parse (`macho.NewFile` + `DWARF()` + unit index): 24–31 ms, about 21 MiB of heap;
- 200 function addresses spread over `__text`: 0.85 ms each on average, 11 ms at worst; all 200 named (47 with file and line, the same 47 `atos` resolves to a line; the rest by symbol);
- the cache counts a parsed slice by its decompressed size against `sourcemaps.cache_bytes` (512 MiB).

## Fixture

`internal/sourcemap/testdata/dsym/` holds `crashy.c`, its arm64 + x86_64 dSYM DWARF (19 KB) and `gen.sh`. Two traps when making one:

- `clang -g a.c -o a` in one step deletes the temporary `.o`, and `dsymutil` then writes a dSYM with no DWARF ("unable to open object file"). Compile and link separately.
- The DWARF records the compile directory. `-fdebug-prefix-map=$PWD=/src` keeps local paths (user names, scratch folders) out of the committed file.

The UUIDs and addresses in `dsym_test.go` come from `gen.sh`'s output; a regeneration with another clang changes them.

## End to end

`project/agents/mobile-sdk/verify/w7-dsym-e2e.sh` crashes `OuoCrashProbe` (`swift build`, then `dsymutil` on the debug binary), builds the exception with the RN SDK's own `nativeCrashAttributes` (bundled by esbuild with `expo-modules-core` and `react-native` external), sends it through the collector, uploads with the CLI and compares rum-api's frames with `atos -i`.
