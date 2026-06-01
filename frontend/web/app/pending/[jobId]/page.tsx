import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { DecideOverlay } from '@/components/DecideOverlay';
import type { PendingJobDetail } from '@/lib/types';

interface Props {
  params: Promise<{ jobId: string }>;
}

export const dynamic = 'force-dynamic';

async function loadDetail(
  jobId: string,
  spaceId: string,
  token: string,
): Promise<PendingJobDetail | null> {
  const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
  const resp = await fetch(
    `${apiBase}/api/spaces/${spaceId}/pending/${jobId}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    },
  );
  if (resp.status === 404) return null;
  if (!resp.ok) {
    throw new Error(`Failed to load job: HTTP ${resp.status}`);
  }
  return (await resp.json()) as PendingJobDetail;
}

export default async function PendingDetailPage({ params }: Props) {
  const { jobId } = await params;

  // Beta scope: PR-4A-2 lands /spaces/me. For PR-4A-1 the user's
  // current space_id is carried on a cookie set after registration.
  // If unset, the middleware would have already bounced us.
  const cookieStore = headers();
  const cookieHdr = (await cookieStore).get('cookie') || '';
  const tokenMatch = cookieHdr.match(/(?:^|;\s*)lucid_jwt=([^;]+)/);
  const spaceMatch = cookieHdr.match(/(?:^|;\s*)lucid_space_id=([^;]+)/);
  const token = tokenMatch ? decodeURIComponent(tokenMatch[1]!) : '';
  const spaceId = spaceMatch ? decodeURIComponent(spaceMatch[1]!) : '';

  if (!token || !spaceId) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16">
        <p className="text-text-secondary">
          Sign in to view this Decide Overlay. (Auth UI lands in PR-4A-2.)
        </p>
      </main>
    );
  }

  let detail: PendingJobDetail | null = null;
  try {
    detail = await loadDetail(jobId, spaceId, token);
  } catch (err) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16">
        <p className="text-accent-error">{(err as Error).message}</p>
      </main>
    );
  }

  if (!detail) {
    notFound();
  }

  return <DecideOverlay spaceId={spaceId} jobId={jobId} initial={detail} />;
}
