'use client';

import { Typography } from 'antd';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Bandwidth, getBandwidth } from '@/lib/api';
import { age, axisRate, clock, count, rate } from '@/lib/format';
import { usePoll } from '@/lib/poll';

// Video is Agora, audio is LiveKit; the same colour means the same engine in both charts.
const VIDEO = '#d46b08';
const AUDIO = '#1677ff';
const BUDGET = '#cf1322';
const MAX_VIEWERS = 5000;

// Square-root axes keep a line through the origin straight, but pull small
// values up: on a linear axis the budget sits about 1% above the floor and
// the 44-viewer crossing is a pixel from the y axis.
const SQRT = 'sqrt' as const;

function crossingText(bw: Bandwidth): string {
  const { agora, livekit } = bw.projection.crossing;
  if (agora !== undefined && livekit !== undefined) {
    return `video crosses at ~${count(agora)} viewers · audio at ~${count(livekit)}`;
  }
  if (agora !== undefined) return `video crosses at ~${count(agora)} viewers`;
  if (livekit !== undefined) return `audio crosses at ~${count(livekit)} viewers`;
  return 'no measured bitrate yet, so nothing to project';
}

function perViewerText(bw: Bandwidth, engine: 'agora' | 'livekit'): string {
  const name = engine === 'agora' ? 'video · Agora' : 'audio · LiveKit';
  const per = bw.projection.perViewer[engine];
  if (!per) return `${name} · not measured yet`;
  const base = `${name} · ${rate(per.bps)} per viewer`;
  return per.source === 'last' ? `${base} · last measured ${age(Date.now() - per.at)} ago` : base;
}

function yTicks(max: number) {
  return [0, ...[1e8, 5e8, 1e9, 2e9, 4e9, 8e9, 16e9].filter((v) => v < max * 0.95), max];
}

function LiveChart({ bw }: { bw: Bandwidth }) {
  const data = bw.series.map((p) => ({
    t: p.t,
    livekit: p.livekitBps,
    audioReported: p.audioReportedBps,
    wouldBe: p.wouldBeVideoBps,
  }));
  const top = Math.max(
    bw.budgetBps * 1.1,
    ...data.map((p) => Math.max(p.livekit ?? 0, p.audioReported, p.wouldBe)),
  );
  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
        <CartesianGrid stroke="#f0f0f0" />
        <XAxis
          dataKey="t"
          type="number"
          domain={['dataMin', 'dataMax']}
          tickFormatter={(t) => clock(t).slice(0, 5)}
          tick={{ fontSize: 12 }}
        />
        <YAxis
          scale={SQRT}
          domain={[0, top]}
          ticks={[0, 1e5, 1e6, 5e6, 2e7, 6e7].filter((v) => v < top)}
          tickFormatter={axisRate}
          tick={{ fontSize: 12 }}
          width={72}
        />
        <Tooltip
          labelFormatter={(t) => clock(Number(t))}
          formatter={(v) => (typeof v === 'number' ? rate(v) : 'no reading')}
        />
        <Legend />
        <ReferenceLine
          y={bw.budgetBps}
          stroke={BUDGET}
          strokeDasharray="5 4"
          label={{ value: `budget ${rate(bw.budgetBps)}`, position: 'insideTopLeft', fill: BUDGET, fontSize: 12 }}
        />
        <Line
          dataKey="wouldBe"
          name="video egress, would-be (viewer reports)"
          stroke={VIDEO}
          dot={false}
          isAnimationActive={false}
        />
        <Line
          dataKey="livekit"
          name="audio egress, measured at LiveKit"
          stroke={AUDIO}
          dot={false}
          connectNulls={false}
          isAnimationActive={false}
        />
        {/* The same audio as the viewers say they received it. Close to the
            measured line means the reports can be trusted for video too. */}
        <Line
          dataKey="audioReported"
          name="audio egress, viewer reports (cross-check)"
          stroke={AUDIO}
          strokeDasharray="4 3"
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function ProjectionChart({ bw }: { bw: Bandwidth }) {
  const { lines, crossing } = bw.projection;
  const rows = new Map<number, { x: number; agora?: number; livekit?: number }>();
  for (const line of lines) {
    for (const [x, y] of line.points) {
      rows.set(x, { ...rows.get(x), x, [line.engine]: y });
    }
  }
  // With nothing measured the value axis has no data to scale from, so it and
  // the budget line vanish. Two zero rows and an invisible line keep them drawn.
  const empty = rows.size === 0;
  const data = empty
    ? [{ x: 0, floor: 0 }, { x: MAX_VIEWERS, floor: 0 }]
    : [...rows.values()].sort((a, b) => a.x - b.x);
  const has = (engine: 'agora' | 'livekit') => lines.some((l) => l.engine === engine);
  const top = Math.max(bw.budgetBps * 1.5, ...lines.flatMap((l) => l.points.map(([, y]) => y)));
  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data} margin={{ top: 8, right: 24, bottom: 0, left: 8 }}>
        <CartesianGrid stroke="#f0f0f0" />
        <XAxis
          dataKey="x"
          type="number"
          scale={SQRT}
          domain={[0, MAX_VIEWERS]}
          ticks={[0, 50, 250, 1000, 2500, MAX_VIEWERS]}
          tickFormatter={count}
          tick={{ fontSize: 12 }}
          height={44}
          label={{ value: 'concurrent viewers, √ scale', position: 'insideBottom', offset: 0, fontSize: 12 }}
        />
        <YAxis
          scale={SQRT}
          domain={[0, top]}
          ticks={yTicks(top)}
          tickFormatter={axisRate}
          tick={{ fontSize: 12 }}
          width={88}
          label={{ value: 'egress, √ scale', angle: -90, position: 'insideLeft', offset: 4, style: { textAnchor: 'middle' }, fontSize: 12 }}
        />
        <Tooltip
          labelFormatter={(x) => `${count(Number(x))} viewers`}
          formatter={(v) => (typeof v === 'number' ? rate(v) : '')}
        />
        <Legend />
        <ReferenceLine
          y={bw.budgetBps}
          stroke={BUDGET}
          strokeDasharray="5 4"
          label={{
            value: `server budget ${rate(bw.budgetBps)}`,
            position: 'insideBottomRight',
            fill: BUDGET,
            fontSize: 12,
          }}
        />
        {empty && <Line dataKey="floor" stroke="none" legendType="none" dot={false} isAnimationActive={false} />}
        {has('agora') && (
          <Line dataKey="agora" name="video (Agora, if self-hosted)" stroke={VIDEO} dot={false} isAnimationActive={false} />
        )}
        {has('livekit') && (
          <Line dataKey="livekit" name="audio (LiveKit)" stroke={AUDIO} dot={false} isAnimationActive={false} />
        )}
        {crossing.agora !== undefined && (
          <ReferenceDot x={crossing.agora} y={bw.budgetBps} r={5} fill={VIDEO} stroke="#fff" ifOverflow="visible" />
        )}
        {crossing.livekit !== undefined && (
          <ReferenceDot x={crossing.livekit} y={bw.budgetBps} r={5} fill={AUDIO} stroke="#fff" ifOverflow="visible" />
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}

export default function BandwidthPage() {
  const { data: bw, failed } = usePoll(getBandwidth, 5000);
  if (!bw) return <p>{failed ? 'could not reach the API' : 'loading'}</p>;

  const { used, free, pauseAt, paused } = bw.agora;
  return (
    <>
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        Last 60 minutes
      </Typography.Title>
      <LiveChart bw={bw} />
      <p style={{ fontSize: 12, opacity: 0.65 }}>
        A gap in the measured audio line is a sample LiveKit could not be read for, not zero traffic. The dashed
        line is what the audio viewers reported for the same seconds; the video line rests on reports like it. The
        value axis is square-root scaled so small readings stay visible next to the budget.
      </p>

      <Typography.Title level={5}>Where the budget runs out</Typography.Title>
      <p className="mono" style={{ margin: '0 0 4px', fontWeight: 500 }}>
        {crossingText(bw)}
      </p>
      <ProjectionChart bw={bw} />
      <p style={{ margin: 0, fontSize: 12, opacity: 0.65 }}>projection from measured bitrate</p>
      <p style={{ margin: '2px 0 0', fontSize: 12, opacity: 0.65 }}>
        Both axes are square-root scaled: a line through zero stays straight, and both crossings stay on the page.
      </p>
      <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13 }} className="mono">
        <li>{perViewerText(bw, 'agora')}</li>
        <li>{perViewerText(bw, 'livekit')}</li>
      </ul>

      <Typography.Title level={5}>Agora minutes this month</Typography.Title>
      <p style={{ margin: 0 }}>
        <span className="mono">
          {count(used)} / {count(free)}
        </span>
        {' · '}
        video pauses at <span className="mono">{count(pauseAt)}</span> ({Math.round((pauseAt / free) * 100)}%)
        {paused && <span style={{ color: BUDGET }}> · paused now</span>}
      </p>
    </>
  );
}
