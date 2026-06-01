export default function HomePage() {
  return (
    <main className="min-h-screen px-6 py-16">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-light mb-4">Lucid</h1>
        <p className="text-text-secondary mb-8">
          Validation infrastructure for the post-AI internet.
        </p>
        <p className="text-text-muted text-sm">
          The Pending Queue lands in PR-4A-2. For now, navigate directly to{' '}
          <code className="text-accent-cool">/pending/&lt;job_id&gt;</code> to
          open a Decide Overlay.
        </p>
      </div>
    </main>
  );
}
