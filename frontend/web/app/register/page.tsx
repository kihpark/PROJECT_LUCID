import { RegisterForm } from '@/components/RegisterForm';

export const dynamic = 'force-dynamic';

export default function RegisterPage() {
  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-light mb-2">Lucid</h1>
        <p className="text-text-secondary text-sm mb-6">
          가입하기 — 첫 사실을 캡처할 공간을 만듭니다.
        </p>
        <RegisterForm />
      </div>
    </main>
  );
}
