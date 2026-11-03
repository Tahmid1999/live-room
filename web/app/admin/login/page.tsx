'use client';

import { Alert, Button, Form, Input } from 'antd';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { getAdminMe, login } from '@/lib/admin';
import { useAdmin } from '../AdminShell';

export default function LoginPage() {
  const router = useRouter();
  const { refresh } = useAdmin();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cookieLost, setCookieLost] = useState(false);

  async function submit({ password }: { password: string }) {
    setBusy(true);
    setError('');
    setCookieLost(false);
    try {
      await login(password);
      // Inside a cross-site iframe the browser drops the SameSite=Strict cookie
      // even though the password was right; /me is the only way to tell.
      if (!(await getAdminMe()).admin) {
        setCookieLost(true);
        return;
      }
      refresh();
      router.push('/admin');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Form layout="vertical" onFinish={submit} style={{ maxWidth: 320 }}>
      <p style={{ marginTop: 0 }}>The panel is read-only for everyone. Signing in adds the kill-room action.</p>
      <Form.Item name="password" label="Password" rules={[{ required: true, message: 'enter the password' }]}>
        <Input.Password autoComplete="current-password" autoFocus />
      </Form.Item>
      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}
      {cookieLost && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="sign in from the full-size page"
          description={
            <a href="/admin/login" target="_blank" rel="noreferrer">
              open the sign-in page in a new tab
            </a>
          }
        />
      )}
      <Button type="primary" htmlType="submit" loading={busy}>
        Sign in
      </Button>
    </Form>
  );
}
