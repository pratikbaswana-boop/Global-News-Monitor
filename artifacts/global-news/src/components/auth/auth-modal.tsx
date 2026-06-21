import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LogIn, Chrome } from "lucide-react";

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AuthModal({ isOpen, onClose }: AuthModalProps) {
  const { signInGoogle, signInEmail, signUpEmail } = useAuth();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  if (!isOpen) return null;

  async function handleGoogle() {
    setLoading(true);
    setError("");
    try {
      await signInGoogle();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Google sign-in failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      if (mode === "signin") {
        await signInEmail(email, password);
      } else {
        await signUpEmail(email, password);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-xl border border-border/50 bg-card p-6 shadow-2xl">
        <div className="mb-4 text-center">
          <h2 className="text-lg font-semibold tracking-tight">{mode === "signin" ? "Sign In" : "Create Account"}</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Access your intelligence dashboard
          </p>
        </div>

        <Button
          variant="outline"
          className="w-full mb-4 gap-2"
          onClick={handleGoogle}
          disabled={loading}
        >
          <Chrome className="h-4 w-4" />
          Continue with Google
        </Button>

        <div className="relative mb-4">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t border-border/40" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-card px-2 text-muted-foreground">or</span>
          </div>
        </div>

        <form onSubmit={handleEmailSubmit} className="space-y-3">
          <div>
            <Label htmlFor="auth-email" className="text-xs font-medium">Email</Label>
            <Input
              id="auth-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="auth-password" className="text-xs font-medium">Password</Label>
            <Input
              id="auth-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              className="mt-1"
            />
          </div>

          {error && (
            <p className="text-xs text-red-400">{error}</p>
          )}

          <Button type="submit" className="w-full gap-2" disabled={loading}>
            <LogIn className="h-4 w-4" />
            {mode === "signin" ? "Sign In" : "Create Account"}
          </Button>
        </form>

        <div className="mt-4 text-center text-xs text-muted-foreground">
          {mode === "signin" ? (
            <>
              No account?{" "}
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => { setMode("signup"); setError(""); }}
              >
                Sign up
              </button>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => { setMode("signin"); setError(""); }}
              >
                Sign in
              </button>
            </>
          )}
        </div>

        <button
          onClick={onClose}
          className="mt-3 w-full text-center text-xs text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
