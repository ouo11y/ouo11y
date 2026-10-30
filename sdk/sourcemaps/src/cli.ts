#!/usr/bin/env node
import { parseArgs } from "node:util";
import { deleteMaps, findArtifacts, findDSYMs, inject, upload, uploadDSYM, type Artifact, type UploadOptions } from "./index.js";

const usage = `ouo-sourcemaps: debug ids into built JavaScript, source maps and dSYMs up to rum-api (ADR-0011)

  ouo-sourcemaps inject <dir>... [--dry-run]
      Appends a debug id (and the snippet the ouo browser SDK reads) to every bundle that has a
      map, and writes it into the map. Idempotent: run it after every build, before deploying.

  ouo-sourcemaps upload <dir>... --url <rum-api> --token <upload token> [options]
      PUTs every map to <rum-api>/v1/sourcemaps.
      --url <url>          rum-api base URL                         [OUO_SOURCEMAPS_URL]
      --token <token>      the project's upload token (a CI secret)  [OUO_UPLOAD_TOKEN]
      --project <id>       fail unless the token is this project's    [OUO_PROJECT_ID]
      --release <version>  the build's service.version: also index by release + URL path  [OUO_RELEASE]
      --url-prefix <path>  URL path <dir> is served under (default "/")
      --delete-after       delete the .map files after a successful upload (never deploy them)
      --dry-run            list what would be uploaded

  ouo-sourcemaps inject-and-upload <dir>... (same options as upload)

  ouo-sourcemaps upload-dsym <path>... --url <rum-api> --token <upload token> [--project] [--release] [--dry-run]
      PUTs every DWARF file of the .dSYM bundles under each path (or the path itself when it is a
      file) to <rum-api>/v1/dsyms, so native iOS crashes get function names, files and lines.
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

/** The upload options from the flags, else the environment; exits when --url or --token is missing. */
function uploadOptions(values: { url?: string; token?: string; project?: string; release?: string }, dryRun: boolean): UploadOptions {
  const env = process.env;
  const url = values.url ?? env["OUO_SOURCEMAPS_URL"];
  const token = values.token ?? env["OUO_UPLOAD_TOKEN"];
  const project = values.project ?? env["OUO_PROJECT_ID"];
  const release = values.release ?? env["OUO_RELEASE"];
  if (!url) fail("--url (or OUO_SOURCEMAPS_URL) is required");
  if (!token && !dryRun) fail("--token (or OUO_UPLOAD_TOKEN) is required");
  return { url, token: token ?? "", ...(project ? { project } : {}), ...(release ? { release } : {}) };
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

  let artifacts: Artifact[] = [];
  if (cmd === "inject" || cmd === "inject-and-upload") {
    artifacts = await artifactsOf(dirs);
    for (const a of artifacts) {
      const r = await inject(a, { dryRun });
      process.stdout.write(`${r.changed ? "injected" : "kept    "} ${r.debugId}  ${a.rel}\n`);
    }
    if (artifacts.length === 0) process.stderr.write("ouo-sourcemaps: no bundle with a source map found\n");
    if (cmd === "inject") return 0;
  } else if (cmd === "upload") {
    artifacts = await artifactsOf(dirs);
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
      process.stdout.write(`uploaded ${r.debugId ?? "(release only)                     "}  ${r.file}${o.release ? `  release ${o.release}` : ""}\n`);
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
    if (r.error) {
      failed++;
      process.stderr.write(`failed   ${f}: ${r.error}\n`);
      continue;
    }
    for (const d of r.dsyms ?? []) process.stdout.write(`uploaded ${d.debug_id} (${d.arch})  ${f}\n`);
  }
  process.stdout.write(`${files.length - failed}/${files.length} dSYM file(s) uploaded\n`);
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => fail((e as Error).stack ?? String(e)),
);
