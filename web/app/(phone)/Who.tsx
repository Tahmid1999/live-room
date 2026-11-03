import type { Me } from '@/lib/api';

export function Who({ me }: { me: Me | null }) {
  if (!me) return <span className="who mono">&nbsp;</span>;
  return (
    <span className="who mono">
      {me.name} · {me.balance.toLocaleString('en-US')} coins
    </span>
  );
}
