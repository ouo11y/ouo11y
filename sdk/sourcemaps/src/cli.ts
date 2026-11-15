#!/usr/bin/env node
import { parseArgs } from "node:util";
import { artifactOf, composeHermesMaps, deleteMaps, findArtifacts, findDSYMs, inject, upload, uploadDSYM, type Artifact, type InjectResult, type UploadOptions } from "./index.js";

const usage = `ouo-sourcemaps: debug ids into built JavaScript, source maps and dSYMs up to Muninn (ADR-0011, ADR-0026)

  ouo-sourcemaps inject <dir>... [--bundle <file> --sourcemap <map>] [--react-native] [--dry-run]
      Appends a debug id (and the snippet the ouo SDK reads) to every bundle that has a map, and
      writes it into the map. Idempotent: run it after every build, before deploying. React Native
      bundles (.bundle, .jsbundle, or any file with --react-native) get the React Native snippet:
      run it before hermesc, or use withOuoDebugIds from @ouo11y/sourcemaps/metro instead.

  ouo-sourcemaps upload <dir>... --url <muninn> --token <upload token> --project <id> [options]
      PUTs every map to <muninn>/api/v1/projects/<id>/debug-files/sourcemap/<debug id>, keyed by
      the bundle's debug id (from the map, the //# debugId= comment, or the id a React Native
      bundle, text or Hermes bytecode, holds). A map without one needs --release: its id is then
      derived from the map's bytes and only the release + URL path finds it.
      Bundles: .js .mjs .cjs .bundle .jsbundle .hbc with <file>.map or a sourceMappingURL.
      --bundle <file>      a bundle whose map is elsewhere, with --sourcemap (repeatable)
      --sourcemap <file>   the map of the --bundle at the same position
      --url <url>          Muninn's public base URL                 [OUO_SOURCEMAPS_URL]
      --token <token>      the project's upload token (a CI secret)  [OUO_UPLOAD_TOKEN]
      --project <id>       the project the maps belong to (required) [OUO_PROJECT_ID]
      --release <version>  the build's service.version: also index by release + URL path  [OUO_RELEASE]
      --url-prefix <path>  URL path <dir> is served under (default "/")
      --delete-after       delete the .map files after every upload succeeded (never deploy them)
      --dry-run            list what would be uploaded
      A debug id already stored with the same map succeeds (200); with a different map it fails (409).

  ouo-sourcemaps inject-and-upload <dir>... (same options as upload)

  ouo-sourcemaps compose <packager.map> <hermes.map> -o <out.map> [--bundle <file>]
      Composes Metro's map with hermesc's (-output-source-map) into the map of the bytecode, with
      the app's metro-source-map, and keeps the debug id (of the packager map, or of --bundle).

  ouo-sourcemaps upload-dsym <path>... --url <muninn> --token <upload token> --project <id> [--release] [--dry-run]
      Splits every DWARF file of the .dSYM bundles under each path (or the path itself when it is
      a file) into its architecture slices and PUTs each to
      <muninn>/api/v1/projects/<id>/debug-files/dsym/<LC_UUID>, so native iOS crashes get
      function names, files and lines.
`;

function fail(msg: string): never {
  process.stderr.write(`ouo-sourcemaps: ${msg}\n`);
  process.exit(2);
}

async function artifactsOf(dirs: string[]): Promise<Artifact[]> {
  if (dirs.length === 0) fail("no directory given\n\n" + usage);
  const out: Artifact[] = [];
  for (const d of dirs) {
    try {
      out.push(...(await findArtifacts(d)));
    } catch (e) {
      fail(`${d}: ${(e as Error).message}`);
    }
  }
  return out;
}

/** The upload options from the flags, else the environment; exits when --url, --token or --project is missing. */
function uploadOptions(values: { url?: string; token?: string; project?: string; release?: string }, dryRun: boolean): UploadOptions {
  const env = process.env;
  const url = values.url ?? env["OUO_SOURCEMAPS_URL"];
  const token = values.token ?? env["OUO_UPLOAD_TOKEN"];
  const project = values.project ?? env["OUO_PROJECT_ID"];
  const release = values.release ?? env["OUO_RELEASE"];
  if (!url) fail("--url (or OUO_SOURCEMAPS_URL) is required");
  if (!token && !dryRun) fail("--token (or OUO_UPLOAD_TOKEN) is required");
  if (!project) fail("--project (or OUO_PROJECT_ID) is required");
  return { url, token: token ?? "", project, ...(release ? { release } : {}) };
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string" },
      token: { type: "string" },
      project: { type: "string" },
      release: { type: "string" },
      "url-prefix": { type: "string" },
      "delete-after": { type: "boolean" },
      "dry-run": { type: "boolean" },
      bundle: { type: "string", multiple: true },
      sourcemap: { type: "string", multiple: true },
      "react-native": { type: "boolean" },
      output: { type: "string", short: "o" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, ...dirs] = positionals;
  if (values.help || !cmd) {
    process.stdout.write(usage);
    return values.help ? 0 : 2;
  }
  const dryRun = values["dry-run"] === true;

  if (cmd === "upload-dsym") {
    if (dirs.length === 0) fail("no path given\n\n" + usage);
    return uploadDSYMs(dirs, uploadOptions(values, dryRun), dryRun);
  }

  if (cmd === "compose") {
    const [packager, hermes] = dirs;
    if (!packager || !hermes || !values.output) fail("compose <packager.map> <hermes.map> -o <out.map>\n\n" + usage);
    const bundle = values.bundle?.[0];
    const r = await composeHermesMaps(packager, hermes, values.output, bundle ? { bundle } : {});
    process.stdout.write(`composed ${r.debugId ?? "(no debug id)"}  ${values.output}\n`);
    return 0;
  }

  // Directories, and bundles whose map is in another folder (--bundle / --sourcemap pairs).
  const bundles = values.bundle ?? [];
  const maps = values.sourcemap ?? [];
  if (bundles.length !== maps.length) fail("give one --sourcemap per --bundle");
  const collect = async (): Promise<Artifact[]> => [
    ...(dirs.length > 0 || bundles.length === 0 ? await artifactsOf(dirs) : []),
    ...bundles.map((b, i) => artifactOf(b, maps[i]!)),
  ];

  let artifacts: Artifact[] = [];
  if (cmd === "inject" || cmd === "inject-and-upload") {
    artifacts = await collect();
    for (const a of artifacts) {
      let r: InjectResult;
      try {
        r = await inject(a, { dryRun, ...(values["react-native"] ? { reactNative: true } : {}) });
      } catch (e) {
        fail((e as Error).message);
      }
      process.stdout.write(`${r.changed ? "injected" : "kept    "} ${r.debugId}  ${a.rel}\n`);
    }
    if (artifacts.length === 0) process.stderr.write("ouo-sourcemaps: no bundle with a source map found\n");
    if (cmd === "inject") return 0;
  } else if (cmd === "upload") {
    artifacts = await collect();
  } else {
    fail(`unknown command ${cmd}\n\n${usage}`);
  }

  const o = uploadOptions(values, dryRun);
  if (artifacts.length === 0) {
    process.stderr.write("ouo-sourcemaps: no bundle with a source map found\n");
    return 1;
  }
  let failed = 0;
  for (const a of artifacts) {
    if (dryRun) {
      process.stdout.write(`would upload ${a.rel} -> ${o.url}\n`);
      continue;
    }
    const r = await upload(a, { ...o, ...(values["url-prefix"] ? { urlPrefix: values["url-prefix"] } : {}) });
    if (r.error) {
      failed++;
      process.stderr.write(`failed   ${r.file}: ${r.error}\n`);
    } else {
      const notes = [r.derived ? "id derived from the map" : "", r.status === 200 ? "already stored" : ""].filter(Boolean);
      process.stdout.write(`uploaded ${r.debugId}  ${r.file}${o.release ? `  release ${o.release}` : ""}${notes.length > 0 ? `  (${notes.join(", ")})` : ""}\n`);
    }
  }
  if (failed === 0 && values["delete-after"] && !dryRun) {
    await deleteMaps(artifacts);
    process.stdout.write(`deleted ${artifacts.length} map(s)\n`);
  }
  process.stdout.write(`${artifacts.length - failed}/${artifacts.length} map(s) uploaded\n`);
  return failed === 0 ? 0 : 1;
}

async function uploadDSYMs(paths: string[], o: UploadOptions, dryRun: boolean): Promise<number> {
  const files: string[] = [];
  for (const p of paths) {
    try {
      files.push(...(await findDSYMs(p)));
    } catch (e) {
      fail(`${p}: ${(e as Error).message}`);
    }
  }
  if (files.length === 0) {
    process.stderr.write("ouo-sourcemaps: no .dSYM bundle found\n");
    return 1;
  }
  let failed = 0;
  for (const f of files) {
    if (dryRun) {
      process.stdout.write(`would upload ${f} -> ${o.url}\n`);
      continue;
    }
    const r = await uploadDSYM(f, o);
    for (const d of r.dsyms ?? []) process.stdout.write(`uploaded ${d.debug_id} (${d.arch})  ${f}\n`);
    if (r.error) {
      failed++;
      process.stderr.write(`failed   ${f}: ${r.error}\n`);
    }
  }
  process.stdout.write(`${files.length - failed}/${files.length} dSYM file(s) uploaded\n`);
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => fail((e as Error).stack ?? String(e)),
);
