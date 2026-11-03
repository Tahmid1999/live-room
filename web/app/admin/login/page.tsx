'use client';

import { Alert, Button, Form, Input } from 'antd';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { login } from '@/lib/admin';
import { useAdmin } from '../AdminShell';

export default function LoginPage() {
  const router = useRouter();
  const { refresh } = useAdmin();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit({ password }: { password: string }) {
    setBusy(true);
    setError('');
    try {
      await login(password);
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
      <Button type="primary" htmlType="submit" loading={busy}>
        Sign in
      </Button>
    </Form>
  );
}
