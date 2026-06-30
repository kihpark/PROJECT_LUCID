import { headers } from 'next/headers';
import { PendingQueueView } from '@/components/PendingQueueView';

export const dynamic = 'force-dynamic';

export default async function PendingQueuePage() {
  const h = await headers();
  const cookieHdr = h.get('cookie') || '';
  const spaceMatch = cookieHdr.match(/(?:^|;\s*)lucid_space_id=([^;]+)/);
  const spaceId = spaceMatch ? decodeURIComponent(spaceMatch[1]!) : '';

  if (!spaceId) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16">
        {/* feat/i18n-ko-display-names-separation (★ PO 2026-06-30) —
          * 빈상태 메시지 한국어화. */}
        <p className="text-text-secondary">
          활성화된 지식 공간이 없습니다. 로그인해 주세요.
        </p>
      </main>
    );
  }

  return <PendingQueueView spaceId={spaceId} />;
}
