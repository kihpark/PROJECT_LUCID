import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default function AutoAcceptedPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-16">
      <h1 className="text-2xl font-light mb-3">Auto-accepted</h1>
      <p className="text-text-secondary mb-6">
        Facts that were automatically accepted under a trusted source policy.
      </p>
      <div className="rounded-lg border border-accent-warm/30 bg-accent-warm/5 p-4 text-sm">
        <strong className="block text-accent-warm mb-2">
          Beta scope notice
        </strong>
        <p className="text-text-secondary mb-2">
          The trusted-source auto-accept flow lands in Sprint 5 — until then, every
          captured fact runs through the standard Decide path on the {' '}
          <Link
            href={{ pathname: '/pending' } as never}
            className="text-accent-cool underline"
          >
            Pending Queue
          </Link>
          .
        </p>
        <p className="text-text-secondary">
          The backing endpoint{' '}
          <code className="font-mono text-text-muted">
            GET /api/spaces/{'{space_id}'}/facts?validation_method=auto
          </code>{' '}
          is not yet implemented; this page is intentionally a placeholder so the
          Pending Queue header can link here without a dead end.
        </p>
      </div>
    </main>
  );
}
