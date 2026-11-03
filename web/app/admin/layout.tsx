import { AntdRegistry } from '@ant-design/nextjs-registry';
import type { Metadata } from 'next';
import { AdminShell } from './AdminShell';

export const metadata: Metadata = { title: 'Live Room admin' };

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <AntdRegistry>
      <AdminShell>{children}</AdminShell>
    </AntdRegistry>
  );
}
