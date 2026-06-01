import { LoginForm } from '@/components/LoginForm';

export const dynamic = 'force-dynamic';

export default function LoginPage() {
  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-light mb-2">Lucid</h1>
        <p className="text-text-secondary text-sm mb-6">Sign in to continue.</p>
        <LoginForm />
      </div>
    </main>
  );
}
