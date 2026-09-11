import { LoginForm } from "@/components/login-form";

export default function LoginPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 px-6 py-16">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-semibold text-ink">Taymna</h1>
        <p className="text-sm text-ink-soft">Sign in to manage your machines.</p>
      </div>
      <LoginForm />
    </main>
  );
}
