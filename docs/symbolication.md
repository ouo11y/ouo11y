# Native crash symbolication: readable iOS crashes from dSYMs

A native iOS crash caught by the ouo React Native SDK (or `OuoCrash` in `sdk/ios`) reaches ouo as addresses: `0   MyApp   0x0000000104a1c2f0 0x104a00000 + 115440`. Upload the build's dSYM once and ouo shows the function, file and line of every frame in your code:

```
0   MyApp   0x0000000104a1c2f0 crashSegv (in MyApp) (ChaosScreen.swift:42)
1   MyApp   0x0000000104a1c3c4 level2 (in MyApp) (ChaosScreen.swift:47)
```

Web and JavaScript stacks use source maps instead: [sourcemaps.md](sourcemaps.md). The design is [ADR-0011](adr/0011-source-maps-and-symbolication.md), section 7.

## How it works

- Every binary Xcode links gets a new build UUID (`LC_UUID`), and its dSYM carries the same UUID. The crash report lists the UUID of each binary a frame points into (`ouo.crash.images`), so a frame finds its dSYM without a release name.
- `ouo-sourcemaps upload-dsym` sends the dSYM's DWARF file to rum-api with the project's upload token. rum-api stores one copy per architecture under its UUID, next to the project's source maps.
- When the plugin (or any client) reads the session, rum-api translates each frame. The record in Loki keeps the raw addresses. A dSYM uploaded after the crash still applies.
- Frames in system libraries (`libsystem_kernel`, `UIKitCore`, `dyld`) have no dSYM from you and stay as addresses. That is expected: the frames that matter are in your app.

## Setup

### 1. An upload token (operator)

The same token as for source maps: `projects.<id>.upload_token` in rum-api, or `OUO_UPLOAD_TOKENS=<project>:<token>`. It is a CI secret, never the public project token in the app. The local stack has `demo:ut_dev_demo_0000000000000000`. Details: [sourcemaps.md](sourcemaps.md#1-give-the-project-an-upload-token-operator).

### 2. Build with dSYMs

Release builds write a dSYM by default (`DEBUG_INFORMATION_FORMAT = dwarf-with-dsym`). Keep it that way for every configuration you ship. Where the dSYMs are:

| Build | dSYM folder |
|---|---|
| `xcodebuild archive -archivePath build/MyApp.xcarchive` | `build/MyApp.xcarchive/dSYMs/` |
| Xcode or `npx expo run:ios --configuration Release` | `~/Library/Developer/Xcode/DerivedData/<App>-<hash>/Build/Products/Release-iphoneos/` (`-iphonesimulator` for a simulator build) |
| `swift build` (a command-line tool) | none: run `dsymutil .build/debug/<tool> -o <tool>.dSYM` |

### 3. Upload after every build you ship

```bash
npx ouo-sourcemaps upload-dsym build/MyApp.xcarchive/dSYMs \
  --url "$OUO_SOURCEMAPS_URL" --token "$OUO_UPLOAD_TOKEN" --release "$APP_VERSION"
```

- A path can be a `.dSYM` bundle, a folder with dSYMs anywhere under it, or one DWARF file. Every `<name>.dSYM/Contents/Resources/DWARF/<binary>` found is uploaded, frameworks included.
- Each architecture of a universal dSYM is stored separately. The output lists them: `uploaded 55dca0d0-6915-31b5-91cf-827d7da30926 (arm64)  .../MyApp`.
- Upload the dSYMs of every build that reaches users, simulator and device builds alike: each link gets a new UUID, so the dSYM of yesterday's build does not match today's crash.
- `--release` is kept with the upload for listing only. `--project` makes the upload fail unless the token belongs to that project. `--dry-run` lists the files.
- Environment variables: `OUO_SOURCEMAPS_URL`, `OUO_UPLOAD_TOKEN`, `OUO_PROJECT_ID`, `OUO_RELEASE`.

## What you see

In the session timeline, a fatal native error shows **symbolicated 4/5** next to "Show stack trace". The **Original** view lists each frame as `function (file:line) in binary`. A function inlined by the compiler shows as its own frame marked `(inlined)`, followed by the function it was inlined into, the way `atos -i` prints them. Frames without a dSYM show the binary and address. **Raw** shows the stack exactly as the SDK sent it.

Swift functions appear under their DWARF name (`level2`), without the argument labels Xcode shows (`level2(_:)`). Code built without debug information gets the name of the symbol it is in (Swift names stay mangled, `$s6Sentry...`), and no file.

## Checking an upload

```bash
dwarfdump --uuid build/MyApp.xcarchive/dSYMs/MyApp.app.dSYM      # the UUIDs of the dSYM
curl -s -H "Authorization: Bearer $OUO_READ_TOKEN" "$OUO_RUM_API_URL/v1/sourcemaps?project=<id>"   # entries with "kind":"dsym"
```

The crash's own UUIDs are in its `Binary Images` lines (`<55dca0d0...>`). When a frame of your app stays as an address:

- **The UUIDs differ**: the dSYM is from another build. Upload the one from the build that crashed.
- **400 `no DWARF (__debug_info)`**: the app binary was uploaded instead of the dSYM, or the build has `DEBUG_INFORMATION_FORMAT = dwarf` (no dSYM).
- **413**: the file is above `limits.max_dsym_bytes` (512 MiB by default).

To compare by hand: `atos -i -arch arm64 -o MyApp.app.dSYM/Contents/Resources/DWARF/MyApp -l <image_addr> <instruction_addr>`, with the addresses from the raw stack.

## Retention and deletion

dSYMs follow the source-map rules: kept for `retention.sourcemaps` (90 days by default) from the upload, a re-upload restarts it, and `DELETE /v1/admin/projects/{project}` deletes them. Keep the retention at least as long as your crashes are kept in Loki.

## Limits

- iOS (Mach-O) only. Android R8 / ProGuard mappings come with the Android SDK (W9).
- Only the crashed thread has frames (an `OuoCrash` limit).
- Upload goes to rum-api directly, as for source maps, until the collector route exists (N41).
