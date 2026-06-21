import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Chrome, ArrowRight, X } from "lucide-react";

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
      <div className="relative w-full max-w-sm rounded-2xl border border-white/[0.08] bg-[#0c0c10] p-8 shadow-2xl">
        <button
          onClick={onClose}
          className="absolute right-4 top-4 text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="mb-8 text-center">
          <p className="mb-2 text-[10px] font-medium tracking-[0.2em] uppercase text-muted-foreground">
            Aumorphic
          </p>
          <h2 className="text-xl font-semibold tracking-tight">
            {mode === "signin" ? "Sign In" : "Sign Up"}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Access your Intelligence dashboard
          </p>
        </div>

        <button
          className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-white/[0.08] bg-transparent px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-white/[0.04] disabled:opacity-50"
          onClick={handleGoogle}
          disabled={loading}
        >
          <Chrome className="h-4 w-4" />
          Continue with Google
        </button>

        <div className="relative my-6">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t border-white/[0.06]" />
          </div>
          <div className="relative flex justify-center text-xs">
            <span className="bg-[#0c0c10] px-3 text-muted-foreground uppercase tracking-wider">or</span>
          </div>
        </div>

        <form onSubmit={handleEmailSubmit} className="space-y-4">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            required
            className="h-11 border-white/[0.08] bg-white/[0.03] text-sm placeholder:text-muted-foreground/60 focus-visible:ring-primary/20 focus-visible:ring-offset-0"
          />
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            required
            className="h-11 border-white/[0.08] bg-white/[0.03] text-sm placeholder:text-muted-foreground/60 focus-visible:ring-primary/20 focus-visible:ring-offset-0"
          />

          {error && (
            <p className="text-xs text-red-400">{error}</p>
          )}

          <Button
            type="submit"
            variant="secondary"
            className="w-full h-11 gap-2 text-sm font-medium"
            disabled={loading}
          >
            {mode === "signin" ? "Sign In" : "Sign Up"}
            <ArrowRight className="h-4 w-4" />
          </Button>
        </form>

        <div className="mt-6 text-center text-sm text-muted-foreground">
          {mode === "signin" ? (
            <>
              No account?{" "}
              <button
                type="button"
                className="text-foreground hover:text-primary transition-colors"
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
                className="text-foreground hover:text-primary transition-colors"
                onClick={() => { setMode("signin"); setError(""); }}
              >
                Sign in
              </button>
            </>
          )}
        </div>

        <button
          onClick={onClose}
          className="mt-4 w-full text-center text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
