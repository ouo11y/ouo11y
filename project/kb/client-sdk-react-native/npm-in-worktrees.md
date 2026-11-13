# npm fails in a worktree when the main checkout is broken

Why does every `npm` command at a worktree root print `Exit prior to config file resolving` / `call config.load() before reading values` and exit 1? Seen 2026-11-11 with npm 11.12.1.

**Cause.** Worktrees live under the main checkout (`<repo>/.claude/worktrees/<name>`). npm looks for a workspace root above the current folder, reads `<repo>/package.json` and every workspace `package.json` it lists. If one of those is not valid JSON, npm exits before it prints an error. That day the main checkout was mid-merge with conflict markers in four `package.json` files.

**How it was found.** Loading `@npmcli/config` directly prints the real error:

```bash
N="$(dirname "$(dirname "$(which npm)")")/lib/node_modules/npm"
node -e 'const C=require(process.argv[1]+"/node_modules/@npmcli/config");const d=require(process.argv[1]+"/node_modules/@npmcli/config/lib/definitions");new C({npmPath:process.argv[1],...d,argv:process.argv}).load().catch(e=>console.error(e.message))' "$N"
```

**Workaround.** Give npm the prefix, so it does not look above it: `npm --prefix "$PWD" ci`. `npx` inside a workspace folder works once the install is done. Do not fix the main checkout from a session that does not own it.
