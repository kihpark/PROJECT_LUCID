'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthMe } from '@/lib/useAuthMe';
import { AssistantView } from '@/components/AssistantView';

export default function AssistantPage() {
  const { me, loading } = useAuthMe();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !me) {
      router.push('/login');
    }
  }, [me, loading, router]);

  if (loading) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '60vh',
          color: '#9db0b5',
          fontSize: 14,
        }}
      >
        로딩 중...
      </div>
    );
  }

  if (!me) {
    return null;
  }

  const spaceId = me.default_space_id ?? '';

  return <AssistantView spaceId={spaceId} />;
}
