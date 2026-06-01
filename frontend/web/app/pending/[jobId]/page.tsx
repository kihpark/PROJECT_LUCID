import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { DecideOverlay } from '@/components/DecideOverlay';
import { apiBase, ssrJson } from '@/lib/server-fetch';
import type { PendingJobDetail } from '@/lib/types';

interface Props {
  params: Promise<{ jobId: string }>;
}

export const dynamic = 'force-dynamic';

export default async function PendingDetailPage({ params }: Props) {
  const { jobId } = await params;

  const h = await headers();
  const cookieHdr = h.get('cookie') || '';
  const tokenMatch = cookieHdr.match(/(?:^|;\s*)lucid_jwt=([^;]+)/);
  const spaceMatch = cookieHdr.match(/(?:^|;\s*)lucid_space_id=([^;]+)/);
  const token = tokenMatch ? decodeURIComponent(tokenMatch[1]!) : '';
  const spaceId = spaceMatch ? decodeURIComponent(spaceMatch[1]!) : '';

  if (!token || !spaceId) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16">
        <p className="text-text-secondary">
          Sign in to view this Decide Overlay.
        </p>
      </main>
    );
  }

  let detail: PendingJobDetail | null = null;
  try {
    detail = await ssrJson<PendingJobDetail>(
      `/api/spaces/${spaceId}/pending/${jobId}`,
      { token },
    );
  } catch (err) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16">
        <h2 className="text-lg font-light text-accent-error mb-3">
          Could not load the Decide Overlay
        </h2>
        <p className="text-sm text-text-secondary mb-2">
          {(err as Error).message}
        </p>
        <p className="text-xxs text-text-muted font-mono">
          API base: <code>{apiBase()}</code> — override with
          <code className="ml-1">NEXT_PUBLIC_API_URL</code> in
          .env.local if the backend lives elsewhere.
        </p>
      </main>
    );
  }

  if (!detail) {
    notFound();
  }

  return <DecideOverlay spaceId={spaceId} jobId={jobId} initial={detail} />;
}
