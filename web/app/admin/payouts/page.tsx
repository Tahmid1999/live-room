'use client';

import { Descriptions, Table, Typography } from 'antd';
import { getAdminRooms, getPayouts, Payouts } from '@/lib/admin';
import { clock, count } from '@/lib/format';
import { usePoll } from '@/lib/poll';

type Run = Payouts['runs'][number];
type Payout = Payouts['payouts'][number];

const stamp = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-CA')} ${clock(d.getTime())}`;
};

export default function PayoutsPage() {
  const { data, failed } = usePoll(getPayouts, 5000);
  const rooms = usePoll(getAdminRooms, 30_000).data;
  const title = (id: string) => rooms?.find((r) => r.id === id)?.title ?? id.slice(-6);

  return (
    <>
      <Descriptions size="small" bordered column={1} style={{ marginBottom: 16, maxWidth: 420 }}>
        <Descriptions.Item label="Earnings not yet settled">
          <span className="mono">{data && count(data.earningsUnsettled)}</span>
        </Descriptions.Item>
      </Descriptions>

      <Typography.Title level={5}>Settlement runs</Typography.Title>
      <Table<Run>
        size="small"
        rowKey="id"
        pagination={false}
        loading={!data && !failed}
        dataSource={data?.runs ?? []}
        locale={{ emptyText: failed ? 'could not reach the API' : 'no run has settled anything yet' }}
        columns={[
          { title: 'Finished', dataIndex: 'finishedAt', render: (v) => <span className="mono">{stamp(v)}</span> },
          { title: 'Replica', dataIndex: 'replica', render: (v) => <span className="mono">{v}</span> },
          {
            title: 'Duration',
            align: 'right',
            render: (_, r) => (
              <span className="mono">{Date.parse(r.finishedAt) - Date.parse(r.startedAt)} ms</span>
            ),
          },
          { title: 'Rows', dataIndex: 'rows', align: 'right', render: (v) => <span className="mono">{v}</span> },
          { title: 'Coins', dataIndex: 'total', align: 'right', render: (v) => <span className="mono">{count(v)}</span> },
        ]}
      />

      <Typography.Title level={5} style={{ marginTop: 16 }}>
        Payouts
      </Typography.Title>
      <Table<Payout>
        size="small"
        rowKey="id"
        pagination={false}
        loading={!data && !failed}
        dataSource={data?.payouts ?? []}
        locale={{ emptyText: 'no payouts' }}
        columns={[
          { title: 'Created', dataIndex: 'createdAt', render: (v) => <span className="mono">{stamp(v)}</span> },
          { title: 'Room', dataIndex: 'roomId', render: title },
          { title: 'Run', dataIndex: 'runId', render: (v: string) => <span className="mono">{v.slice(-6)}</span> },
          { title: 'Coins', dataIndex: 'amount', align: 'right', render: (v) => <span className="mono">{count(v)}</span> },
        ]}
      />
    </>
  );
}
