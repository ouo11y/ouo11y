// Renderer choice by `ouo.replay.format` (SDK spec RPL-24, Muninn spec RDR-2). A format this
// table does not know is stored but not playable, never an error.

export type Renderer = 'rrweb';

export interface FormatInfo {
  /** Structure (DOM or wireframe) or pixel (frames or video). */
  kind: 'structure' | 'pixel' | 'unknown';
  /** Set when the kit can play the format. */
  renderer?: Renderer;
  /** Why it cannot be played here, when it cannot. */
  reason?: string;
}

const FORMATS: Record<string, FormatInfo> = {
  'rrweb/2': { kind: 'structure', renderer: 'rrweb' },
  // Seam for the pixel players: the MVP plugin's frame and video players read the MVP wire;
  // porting them to these formats is the next slice.
  'ouo-frames/3': { kind: 'pixel', reason: 'the frames player is not wired to ouo-frames/3 yet' },
  'ouo-video/1': { kind: 'pixel', reason: 'the video player is not wired to ouo-video/1 yet' },
  'ouo-wireframe/1': { kind: 'structure', reason: 'wireframe replays are not built yet' },
};

export function formatInfo(format: string): FormatInfo {
  return FORMATS[format] ?? { kind: 'unknown', reason: `format ${format} is stored but this player cannot decode it` };
}
