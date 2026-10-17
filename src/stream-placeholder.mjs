// A stand-in first picture for /stream when a camera has no kept live keyframe yet (never watched here).
//
// Instant start (stream-primer.mjs) answers /stream with the camera's last live keyframe, so Home Assistant's
// go2rtc gets its RTSP DESCRIBE reply within its fixed 5 s while a battery camera wakes. A camera nobody has
// watched through this bridge has no such keyframe, and its first live view timed out before the camera
// answered. This keyframe fills that gap: one H.264 IDR (640x360, baseline, SPS+PPS in band, so it decodes on
// its own) showing a dark screen with "Budzenie kamery…". Generated once with:
//
//   ffmpeg -f lavfi -i "color=c=0x1c1c1c:s=640x360:d=1" \
//     -vf "drawtext=text='Budzenie kamery…':fontcolor=0xbbbbbb:fontsize=28:x=(w-text_w)/2:y=(h-text_h)/2" \
//     -frames:v 1 -c:v libx264 -profile:v baseline -pix_fmt yuv420p -x264-params keyint=1:repeat-headers=1 \
//     -bsf:v h264_mp4toannexb -f h264 placeholder.h264
//
// It is H.264 only: a camera whose live feed turns out to be H.265 cannot follow it in the same stream (the
// consumer's ffmpeg fixed its codec on the placeholder), so the route ends that response once the first live
// keyframe is kept, and the reconnect is primed with the right codec.
export const PLACEHOLDER_KEYFRAME = Buffer.from(
  [
    "AAAAAWdCwB7cCgL/lwEQAAADABAAAAMDIPFi+AAAAAFozg8sgAAAAQYF//9b3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2",
    "NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cu",
    "dmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTAgcmVmPTEgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MTow",
    "eDExMSBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0wIG1lX3JhbmdlPTE2IGNocm9tYV9t",
    "ZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MCBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0t",
    "MiB0aHJlYWRzPTExIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNl",
    "ZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MCB3ZWlnaHRwPTAga2V5aW50PTEga2V5aW50",
    "X21pbj0xIHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByYz1jcmYgbWJ0cmVlPTAgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1p",
    "bj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAFliIQEvJigADNPJycnJycnJycnJycnJycn",
    "JycnJycnJycnJycnJycnJycnJycnJycnXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "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",
    "6666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666",
    "6666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666",
    "6666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666",
    "6666666666666666666666666666666666666666666666666666666666666666666666666666668=",
  ].join(""),
  "base64",
);
export const PLACEHOLDER_CODEC = "h264";
