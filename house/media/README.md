# House stream media

Both files are generated with ffmpeg from its own test sources. Nothing here comes from anyone else's recording, so there is no licence to credit. The app footer says so: `house streams: generated test card and tone`.

`generate.sh` builds both. It needs ffmpeg with `drawtext` and a monospace font:

    FONT='C\:/Windows/Fonts/consola.ttf' sh media/generate.sh     # Windows
    sh media/generate.sh                                           # Linux, DejaVu Sans Mono

## house.y4m (video, git-ignored)

640x360, 15 fps, 30 s, raw yuv420p. Raw frames come to about 155 MB, so the file is not committed; the Dockerfile builds it, and `generate.sh` builds it locally. Chromium loops it. The card is the site's light background (`#f3efe4`) with the words `house stream`, a running clock and a tick that crosses the card once per loop, so a frozen picture is obvious. The command, from the script:

    ffmpeg -f lavfi -i "color=c=0xf3efe4:s=640x360:r=15:d=30" -vf "drawbox=...,drawtext=...text='house stream'...,drawtext=...text='%{pts\:hms}'...,format=yuv420p" -f yuv4mpegpipe house.y4m

The page publishes this at about 600-900 kbps (the encoder is capped at 900 kbps in `web/app/house/Publisher.tsx`).

## house.wav (audio, committed)

24 s, mono, 48 kHz, 16-bit PCM, about 2.4 MB. A slow, quiet phrase of sine notes (C4 E4 G4 E4 A4 G4 D4 C4 G3) with fades on each note, a soft echo and a low-pass at 2.2 kHz, ending on silence so the loop point does not click. Built from `sine` sources with `afade`, `concat`, `aecho` and `lowpass`; the exact filter graph is in `generate.sh`.

## Replacing them

Tahmid can swap either file for his own recording. The video must be y4m at about 640x360 (`ffmpeg -i clip.mp4 -vf scale=640:360 -r 15 -pix_fmt yuv420p house.y4m`), under 60 s, and the audio a 16-bit PCM wav. Update the footer line in `web/app/(phone)/layout.tsx` if the new files are not generated.
