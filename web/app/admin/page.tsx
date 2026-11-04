'use client';

import { Button, message, Popconfirm, Table } from 'antd';
import { AdminRoom, getAdminRooms, killRoom } from '@/lib/admin';
import { age, rate } from '@/lib/format';
import { usePoll } from '@/lib/poll';
import { useAdmin } from './AdminShell';

export default function RoomsPage() {
  const { admin } = useAdmin();
  const { data, failed, reload } = usePoll(getAdminRooms, 2000);
  const [toast, holder] = message.useMessage();

  async function kill(room: AdminRoom) {
    try {
      await killRoom(room.id);
      reload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <>
      {holder}
      <Table<AdminRoom>
        size="small"
        rowKey="id"
        pagination={false}
        loading={!data && !failed}
        dataSource={data ?? []}
        locale={{ emptyText: failed ? 'could not reach the API' : 'no rooms' }}
        columns={[
          {
            title: 'Room',
            render: (_, r) => (
              <>
                {r.title}
                {r.house && <span style={{ opacity: 0.55 }}> · house stream</span>}
              </>
            ),
          },
          { title: 'Kind', dataIndex: 'kind' },
          { title: 'Host', dataIndex: 'hostName' },
          {
            title: 'Status',
            dataIndex: 'status',
            render: (s) => <span style={s === 'LIVE' ? undefined : { color: '#cf1322' }}>{s}</span>,
          },
          { title: 'Viewers', dataIndex: 'viewers', align: 'right', render: (v) => <span className="mono">{v}</span> },
          { title: 'Age', dataIndex: 'ageSec', align: 'right', render: (s) => <span className="mono">{age(s * 1000)}</span> },
          {
            title: 'Per viewer',
            dataIndex: 'perViewerBps',
            align: 'right',
            render: (bps) => <span className="mono">{bps ? rate(bps) : '-'}</span>,
          },
          {
            title: 'Egress (viewer reports)',
            align: 'right',
            dataIndex: 'totalBps',
            render: (bps) => <span className="mono">{bps ? rate(bps) : '-'}</span>,
          },
          ...(admin
            ? [
                {
                  title: '',
                  align: 'right' as const,
                  render: (_: unknown, r: AdminRoom) => (
                    <Popconfirm
                      title={`Kill ${r.title}?`}
                      description="Everyone in it is cut off."
                      okText="Kill"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => kill(r)}
                    >
                      <Button size="small" danger disabled={r.status === 'KILLED'}>
                        Kill
                      </Button>
                    </Popconfirm>
                  ),
                },
              ]
            : []),
        ]}
      />
      <p style={{ marginTop: 8, fontSize: 12, opacity: 0.65 }}>
        refreshes every 2 s
      </p>
    </>
  );
}
