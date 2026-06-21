'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthMe } from '@/lib/useAuthMe';
import {
  approveApplication,
  listApplications,
  type ApplicationListItem,
  type ApproveResponse,
} from '@/lib/api';

export const dynamic = 'force-dynamic';

export default function AdminApplicationsPage() {
  const router = useRouter();
  const { me, loading: meLoading } = useAuthMe();

  const [items, setItems] = useState<ApplicationListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [approved, setApproved] = useState<Record<string, ApproveResponse>>({});

  // Admin gate
  useEffect(() => {
    if (meLoading) return;
    if (!me || !me.is_admin) {
      router.replace('/home');
    }
  }, [me, meLoading, router]);

  // Fetch list when admin confirmed
  useEffect(() => {
    if (meLoading) return;
    if (!me || !me.is_admin) return;
    let cancelled = false;
    listApplications('pending')
      .then((res) => { if (!cancelled) setItems(res.items); })
      .catch((err) => { if (!cancelled) setError((err as Error).message); });
    return () => { cancelled = true; };
  }, [me, meLoading]);

  if (meLoading || !me || !me.is_admin) {
    return (
      <main className="p-6" data-testid="admin-applications-loading">
        Loading...
      </main>
    );
  }

  const onApprove = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      const resp = await approveApplication(id);
      setApproved((prev) => ({ ...prev, [id]: resp }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <main className="p-6 max-w-5xl mx-auto" data-testid="admin-applications-page">
      <h1 className="text-xl font-light mb-4">신청 관리 (Pending applications)</h1>
      {error && (
        <p role="alert" className="text-accent-error text-xs mb-2">{error}</p>
      )}
      {items === null && (
        <p data-testid="admin-applications-fetching">불러오는 중...</p>
      )}
      {items !== null && items.length === 0 && (
        <p data-testid="admin-applications-empty">대기 중인 신청이 없습니다.</p>
      )}
      {items !== null && items.length > 0 && (
        <table className="w-full text-xs border-collapse" data-testid="admin-applications-table">
          <thead>
            <tr className="text-left border-b border-border-subtle">
              <th className="py-2 pr-3">email</th>
              <th className="py-2 pr-3">profession</th>
              <th className="py-2 pr-3">q1</th>
              <th className="py-2 pr-3">q2</th>
              <th className="py-2 pr-3">created</th>
              <th className="py-2 pr-3">status</th>
              <th className="py-2 pr-3">action</th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => {
              const r = approved[row.application_id];
              return (
                <tr
                  key={row.application_id}
                  className="border-b border-border-subtle/40 align-top"
                  data-testid={`admin-app-row-${row.application_id}`}
                >
                  <td className="py-2 pr-3 break-all">{row.email}</td>
                  <td className="py-2 pr-3">{row.profession ?? '-'}</td>
                  <td className="py-2 pr-3 max-w-xs truncate" title={row.q1 ?? ''}>
                    {row.q1 ?? '-'}
                  </td>
                  <td className="py-2 pr-3 max-w-xs truncate" title={row.q2 ?? ''}>
                    {row.q2 ?? '-'}
                  </td>
                  <td className="py-2 pr-3">{row.created_at ?? '-'}</td>
                  <td className="py-2 pr-3">{r?.status ?? row.status}</td>
                  <td className="py-2 pr-3">
                    {r ? (
                      <div className="space-y-1">
                        <p className="text-text-secondary">
                          승인 완료 — 임시 비밀번호 (한 번만 표시):
                        </p>
                        <input
                          readOnly
                          value={r.temp_password}
                          data-testid={`temp-password-${row.application_id}`}
                          className="w-full rounded-md border border-border-subtle bg-bg-card p-1 text-xs font-mono"
                        />
                      </div>
                    ) : (
                      <button
                        type="button"
                        data-testid={`approve-${row.application_id}`}
                        disabled={busyId === row.application_id}
                        onClick={() => onApprove(row.application_id)}
                        className="rounded-md border border-border-subtle px-2 py-1 hover:bg-bg-card"
                      >
                        {busyId === row.application_id ? '승인 중...' : '승인'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}
