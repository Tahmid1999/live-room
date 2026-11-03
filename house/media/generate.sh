#!/bin/sh
# Builds house.y4m and house.wav from nothing but ffmpeg's own generators.
# FONT is a path ffmpeg's drawtext can open (colons escaped as \:), e.g.
#   FONT='C\:/Windows/Fonts/consola.ttf' ./generate.sh
set -eu
cd "$(dirname "$0")"
FONT="${FONT:-/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf}"
FFMPEG="${FFMPEG:-ffmpeg}"

# 30 s at 15 fps, 640x360; the moving tick under the clock is the loop position.
# A y4m is raw frames (about 155 MB), so it is built on demand instead of
# committed. The clock lets someone watching tell a live loop from a frozen frame.
$FFMPEG -y -v error -f lavfi -i "color=c=0xf3efe4:s=640x360:r=15:d=30" -vf "\
drawbox=x=0:y=0:w=640:h=6:color=0x1b2a4a@1:t=fill,\
drawbox=x=0:y=354:w=640:h=6:color=0x1b2a4a@1:t=fill,\
drawbox=x=40:y=292:w=560:h=2:color=0x1b2a4a@0.25:t=fill,\
drawtext=fontfile='$FONT':text='|':fontcolor=0x1b2a4a:fontsize=30:x='36+560*t/30':y=280,\
drawtext=fontfile='$FONT':text='house stream':fontcolor=0x1b2a4a:fontsize=44:x=40:y=88,\
drawtext=fontfile='$FONT':text='generated test card':fontcolor=0x1b2a4a@0.6:fontsize=20:x=40:y=150,\
drawtext=fontfile='$FONT':text='%{pts\:hms}':fontcolor=0x1b2a4a:fontsize=64:x=40:y=196,\
format=yuv420p" -f yuv4mpegpipe house.y4m

# A slow, quiet pentatonic phrase: sine notes with long fades and a soft echo.
# 24 s, mono 48 kHz, ends on silence so the loop point does not click.
# $1 frequency, $2 length, $3 where the fade-out starts (0.9 s before the end)
note() { echo "sine=f=$1:d=$2:r=48000,volume=1.2,afade=t=in:d=0.4,afade=t=out:st=$3:d=0.9"; }
INPUTS=""; LABELS=""; i=0
for spec in "261.63 2.4 1.5" "329.63 2.4 1.5" "392.00 2.4 1.5" "329.63 2.4 1.5" "440.00 2.4 1.5" "392.00 2.4 1.5" "293.66 2.4 1.5" "261.63 3.6 2.7" "196.00 3.6 2.7"; do
  set -- $spec
  INPUTS="$INPUTS -f lavfi -i $(note $1 $2 $3)"
  LABELS="$LABELS[$i:a]"
  i=$((i + 1))
done
$FFMPEG -y -v error $INPUTS -filter_complex "${LABELS}concat=n=$i:v=0:a=1,aecho=0.7:0.6:380|760:0.25|0.12,lowpass=f=2200[out]" -map "[out]" -ac 1 -ar 48000 -c:a pcm_s16le house.wav
ls -l house.y4m house.wav
