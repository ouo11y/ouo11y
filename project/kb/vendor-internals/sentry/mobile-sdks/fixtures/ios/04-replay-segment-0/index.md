# sentry / mobile-sdks / fixtures / ios / 04-replay-segment-0

What does replay segment 0 contain (msgpack parts, `options` event, 402x874 H.264 Main mp4)?

| Path | What it is |
|---|---|
| [envelope-header.json](envelope-header.json) | Envelope header line |
| [mp4info.json](mp4info.json) | Codec, profile, size, frame count and bit rate of the video (`scripts/mp4info.py`) |
| [replay_event.json](replay_event.json) | `replay_event` part of the segment |
| [replay_recording.json](replay_recording.json) | `replay_recording` part: segment header and rrweb events |
| [replay_video.mp4](replay_video.mp4) | The segment's H.264 video |
| [request.json](request.json) | HTTP method, path, headers (key redacted) and Sentry's response |
