# sentry / mobile-sdks / fixtures / android / 06-replay-segment-1-touches

How are real taps recorded (rrweb touch events)?

| Path | What it is |
|---|---|
| [envelope-header.json](envelope-header.json) | Envelope header line |
| [replay_event.json](replay_event.json) | `replay_event` part of the segment |
| [replay_recording.json](replay_recording.json) | `replay_recording` part: segment header and rrweb events |
| [replay_video.mp4](replay_video.mp4) | The segment's H.264 video |
| [request.json](request.json) | HTTP method, path, headers (key redacted) and Sentry's response |
