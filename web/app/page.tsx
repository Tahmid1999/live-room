'use client';

import { useEffect, useState } from 'react';
import { getMe, Me } from '@/lib/api';
import { RoomList } from './RoomList';
import { Who } from './Who';

export default function Lobby() {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    getMe().then(setMe, () => {});
  }, []);

  return (
    <main className="col">
      <div className="top">
        <h1>Live Room</h1>
        <Who me={me} />
      </div>
      <p className="lede">
        Two live rooms, one video and one audio. Watch, chat, and spend your 1,000 demo coins on gifts.
      </p>
      <h2 className="label">Rooms</h2>
      <RoomList />
    </main>
  );
}
