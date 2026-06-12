import { headers } from 'next/headers';
import { RecallView } from '@/components/RecallView';

export const dynamic = 'force-dynamic';

export default async function RecallPage() {
  const h = await headers();
  const cookieHdr = h.get('cookie') || '';
  const spaceMatch = cookieHdr.match(/(?:^|;\s*)lucid_space_id=([^;]+)/);
  const spaceId = spaceMatch ? decodeURIComponent(spaceMatch[1]!) : '';

  if (!spaceId) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16">
        <p className="text-text-secondary">
          No active KnowledgeSpace. Sign in to continue.
        </p>
      </main>
    );
  }

  return <RecallView spaceId={spaceId} />;
}
