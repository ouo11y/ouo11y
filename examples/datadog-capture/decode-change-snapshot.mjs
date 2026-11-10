// Decodes the start of a Datadog browser replay full snapshot in "Change" format
// (record type 2 with format 1) into readable nodes. Research aid, not a full player.
//
//   node decode-change-snapshot.mjs <capture-or-fixture.json> [maxNodes]
//
// The file must be a capture record written by server.mjs (body.parts[].json is the segment).
import { readFileSync } from 'node:fs'

const [file, max = '25'] = process.argv.slice(2)
const rec = JSON.parse(readFileSync(file, 'utf8'))
const segment = rec.body.parts.find((p) => p.name === 'segment').json
const full = segment.records.find((r) => r.type === 2 && r.format === 1)
if (!full) throw new Error('no Change-format full snapshot (type 2, format 1) in this segment')

// One string table per snapshot. AddString (0) and AddRoleAnnotatedStrings (11) append to it in order;
// a number where a string is expected is an index into it.
const table = []
for (const change of full.data) {
  if (change[0] === 0) table.push(...change.slice(1))
  if (change[0] === 11) for (const group of change.slice(1)) table.push(...group.slice(1))
}
const str = (v) => JSON.stringify(typeof v === 'number' ? table[v] : v)

let nodeId = 0
for (const change of full.data) {
  if (change[0] !== 1) continue // AddNode
  for (const node of change.slice(1)) {
    if (nodeId >= Number(max)) break
    const [insertion, name, ...rest] = node
    const where =
      insertion === null ? 'root' : insertion > 0 ? `append to #${nodeId - insertion}` : insertion === 0 ? `after #${nodeId - 1}` : `before #${nodeId + insertion}`
    const extras = rest.map((x) => (Array.isArray(x) ? `${str(x[0])}=${str(x[1])}` : str(x))).join(' ')
    console.log(`#${nodeId} ${where.padEnd(14)} ${str(name)} ${extras}`)
    nodeId++
  }
}
console.log(`string table: ${table.length} entries; change types in snapshot: ${full.data.map((c) => c[0]).join(',')}`)
