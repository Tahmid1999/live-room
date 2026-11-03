'use client';

// Only code under app/admin imports antd, so the phone pages never download it.
import '@ant-design/v5-patch-for-react-19';
import { ConfigProvider, Layout, Menu } from 'antd';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { getAdminMe } from '@/lib/admin';

type AdminState = { admin: boolean; refresh: () => void };

const AdminContext = createContext<AdminState>({ admin: false, refresh: () => {} });
export const useAdmin = () => useContext(AdminContext);

const PAGES = [
  { href: '/admin', label: 'Rooms' },
  { href: '/admin/bandwidth', label: 'Bandwidth' },
  { href: '/admin/wallets', label: 'Wallets' },
  { href: '/admin/payouts', label: 'Payouts' },
];

export function AdminShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const [admin, setAdmin] = useState(false);
  const refresh = useCallback(() => {
    getAdminMe().then(
      (me) => setAdmin(me.admin),
      () => setAdmin(false),
    );
  }, []);
  useEffect(refresh, [refresh]);

  return (
    <AdminContext.Provider value={{ admin, refresh }}>
      {/* Only the typeface is changed, so the panel's text matches the phone app's. */}
      <ConfigProvider theme={{ token: { fontFamily: 'var(--font-sans), system-ui, sans-serif' } }}>
        <Layout style={{ minHeight: '100vh' }}>
          <Layout.Header className="admin-head">
            <strong style={{ whiteSpace: 'nowrap' }}>Live Room admin</strong>
            <Menu
              mode="horizontal"
              selectedKeys={[path]}
              items={PAGES.map((p) => ({ key: p.href, label: <Link href={p.href}>{p.label}</Link> }))}
            />
            <span style={{ whiteSpace: 'nowrap', fontSize: 13 }}>
              {admin ? 'signed in' : <Link href="/admin/login">read-only · sign in</Link>}
            </span>
          </Layout.Header>
          <Layout.Content style={{ padding: 16 }}>{children}</Layout.Content>
        </Layout>
      </ConfigProvider>
    </AdminContext.Provider>
  );
}
