# sentry / mobile-sdks / fixtures / ios / 12-replay-segment-recovered-after-crash

Which segment of the crashed replay is sent at the next launch (cocoa sdk name)?

| Path | What it is |
|---|---|
| [envelope-header.json](envelope-header.json) | Envelope header line |
| [replay_event.json](replay_event.json) | `replay_event` part of the segment |
| [replay_recording.json](replay_recording.json) | `replay_recording` part: segment header and rrweb events |
| [replay_video.mp4](replay_video.mp4) | The segment's H.264 video |
| [request.json](request.json) | HTTP method, path, headers (key redacted) and Sentry's response |
