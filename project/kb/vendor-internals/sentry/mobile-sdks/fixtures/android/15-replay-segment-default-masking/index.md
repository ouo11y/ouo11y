# sentry / mobile-sdks / fixtures / android / 15-replay-segment-default-masking

What does an Android segment with default masking look like and weigh?

| Path | What it is |
|---|---|
| [mp4info.json](mp4info.json) | Codec, profile, size, frame count and bit rate of the video (`scripts/mp4info.py`) |
| [replay_event.json](replay_event.json) | `replay_event` part of the segment |
| [replay_recording.json](replay_recording.json) | `replay_recording` part: segment header and rrweb events |
| [replay_video.mp4](replay_video.mp4) | The segment's H.264 video |
