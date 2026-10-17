import type { VideoManifest } from '../api/types';

/** Epoch ms of the replay start in the video fixture. */
export const VIDEO_START = 1_791_471_538_000;

/**
 * Video manifest shaped like rum-api's `GET /v1/sessions/{id}/replay/video` for a Sentry replay:
 * three 5 s segments at 1 fps, a 2 s gap between seq 1 and seq 2, touches in the video's pixel space.
 */
export const videoManifest: VideoManifest = {
  session_id: 'sess-video',
  kind: 'video',
  viewport: { width: 288, height: 624, scale: 1 },
  platform: 'ios',
  started_at: VIDEO_START,
  ended_at: VIDEO_START + 17_000,
  segments: [
    {
      seq: 0,
      started_at: VIDEO_START,
      ended_at: VIDEO_START + 5000,
      duration_ms: 5000,
      frame_count: 5,
      bytes: 48_211,
      path: '/v1/sessions/sess-video/replay/video/0',
    },
    {
      seq: 1,
      started_at: VIDEO_START + 5000,
      ended_at: VIDEO_START + 10_000,
      duration_ms: 5000,
      frame_count: 5,
      bytes: 40_002,
      path: '/v1/sessions/sess-video/replay/video/1',
    },
    {
      seq: 2,
      started_at: VIDEO_START + 12_000,
      ended_at: VIDEO_START + 17_000,
      duration_ms: 5000,
      frame_count: 5,
      bytes: 39_517,
      path: '/v1/sessions/sess-video/replay/video/2',
    },
  ],
  touches: [
    { ts: VIDEO_START + 2000, x: 144, y: 312, phase: 'began' },
    { ts: VIDEO_START + 6500, x: 72, y: 600, phase: 'ended' },
  ],
  source: { vendor: 'sentry', replay_id: '0123456789abcdef0123456789abcdef' },
};
