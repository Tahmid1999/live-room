import { PrismaClient, RoomKind } from '@prisma/client';
import { engineFor } from './rooms/engine';

// hostName is the label the app shows for the house stream.
export const HOUSE_ROOMS: { kind: RoomKind; title: string; hostName: string }[] = [
  { kind: 'VIDEO', title: 'Desk camera', hostName: 'house' },
  { kind: 'AUDIO', title: 'Late radio', hostName: 'house' },
];

// One house room per kind, found by kind rather than by id so a rerun updates
// it in place and brings back one an admin killed.
export async function seedHouseRooms(prisma: PrismaClient) {
  for (const { kind, title, hostName } of HOUSE_ROOMS) {
    const data = { title, hostName, engine: engineFor(kind), status: 'LIVE' as const };
    const existing = await prisma.room.findFirst({ where: { house: true, kind } });
    if (existing) {
      await prisma.room.update({ where: { id: existing.id }, data });
    } else {
      await prisma.room.create({ data: { ...data, kind, house: true } });
    }
  }
}

if (require.main === module) {
  const prisma = new PrismaClient();
  seedHouseRooms(prisma)
    .then(() => prisma.room.findMany({ where: { house: true } }))
    .then((rooms) => rooms.forEach((r) => console.log(`${r.kind} ${r.id} ${r.title}`)))
    .finally(() => prisma.$disconnect());
}
