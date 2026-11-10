# sentry / mobile-sdks / fixtures / android / 05-replay-segment-0

What does Android replay segment 0 contain (416x912 H.264 Baseline, masked class list in `options`)?

| Path | What it is |
|---|---|
| [envelope-header.json](envelope-header.json) | Envelope header line |
| [mp4info.json](mp4info.json) | Codec, profile, size, frame count and bit rate of the video (`scripts/mp4info.py`) |
| [replay_event.json](replay_event.json) | `replay_event` part of the segment |
| [replay_recording.json](replay_recording.json) | `replay_recording` part: segment header and rrweb events |
| [replay_video.mp4](replay_video.mp4) | The segment's H.264 video |
| [request.json](request.json) | HTTP method, path, headers (key redacted) and Sentry's response |
