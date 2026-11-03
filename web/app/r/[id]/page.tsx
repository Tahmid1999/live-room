import { RoomList } from '@/app/RoomList';
import { Room } from './Room';

export default async function RoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <aside className="aside">
        <h2 className="label">Rooms</h2>
        <RoomList current={id} />
      </aside>
      <Room key={id} id={id} />
    </>
  );
}
