'use client';

export default function Error({
  error,
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h2 className="text-lg font-light text-accent-error mb-3">
        Failed to load Decide Overlay
      </h2>
      <p className="text-sm text-text-secondary mb-4">{error.message}</p>
      <button
        onClick={reset}
        className="rounded-md border border-border-subtle px-3 py-1.5 text-sm hover:bg-bg-card-hover"
      >
        Try again
      </button>
    </main>
  );
}
