'use client';

import { Descriptions, Table } from 'antd';
import { AdminGift, getAdminGifts, getWallets } from '@/lib/admin';
import { GIFTS } from '@/lib/api';
import { clock, count } from '@/lib/format';
import { usePoll } from '@/lib/poll';

const giftName = (id: string) => GIFTS.find((g) => g.id === id)?.name ?? id;

export default function WalletsPage() {
  const wallets = usePoll(getWallets, 2000).data;
  const gifts = usePoll(getAdminGifts, 2000);

  return (
    <>
      <Descriptions size="small" bordered column={{ xs: 1, md: 3 }} style={{ marginBottom: 16 }}>
        <Descriptions.Item label="Ledger sum (must be 0)">
          {wallets && (
            <strong className="mono" style={wallets.ledgerSum === 0 ? undefined : { color: '#cf1322' }}>
              {count(wallets.ledgerSum)}
            </strong>
          )}
        </Descriptions.Item>
        <Descriptions.Item label="Coins in guest wallets">
          <span className="mono">{wallets && count(wallets.coinsInCirculation)}</span>
        </Descriptions.Item>
        <Descriptions.Item label="Gifts today (UTC)">
          <span className="mono">{wallets && count(wallets.giftsToday)}</span>
        </Descriptions.Item>
      </Descriptions>

      <Table<AdminGift>
        size="small"
        rowKey={(g) => `${g.at}-${g.guest}-${g.giftId}-${g.coins}`}
        pagination={false}
        loading={!gifts.data && !gifts.failed}
        dataSource={gifts.data ?? []}
        locale={{ emptyText: gifts.failed ? 'could not reach the API' : 'no gifts in the last 24 hours' }}
        columns={[
          { title: 'Time', dataIndex: 'at', render: (t) => <span className="mono">{clock(t)}</span> },
          { title: 'Guest', dataIndex: 'guest' },
          { title: 'Room', dataIndex: 'room' },
          { title: 'Gift', dataIndex: 'giftId', render: giftName },
          { title: 'Coins', dataIndex: 'coins', align: 'right', render: (c) => <span className="mono">{c}</span> },
        ]}
      />
    </>
  );
}
