/** Bodies smaller than this go uncompressed: the gzip header and the CPU are not worth it. */
export const GZIP_MIN_BYTES = 1024;

export function canGzip(): boolean {
  return typeof CompressionStream === "function";
}

/** gzip bytes with the platform CompressionStream. */
export async function gzipBytes(data: Uint8Array): Promise<Uint8Array> {
  // Response bodies are streams everywhere (browsers, Node, jsdom); Blob.stream() is not.
  const source = new Response(data as BodyInit).body;
  if (!source) throw new Error("no body stream");
  return new Uint8Array(await new Response(source.pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
}
