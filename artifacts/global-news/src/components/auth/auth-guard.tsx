import { useEffect } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";

interface AuthGuardProps {
  children: React.ReactNode;
  allowedEmails?: string[];
}

export function AuthGuard({ children, allowedEmails }: AuthGuardProps) {
  const { user, loading } = useAuth();
  const [, setLocation] = useLocation();

  const email = user?.email ?? null;
  const emailAllowed = !allowedEmails || (email !== null && allowedEmails.includes(email.toLowerCase()));

  useEffect(() => {
    if (!loading && !user) {
      setLocation("/");
    } else if (!loading && user && !emailAllowed) {
      setLocation("/dashboard");
    }
  }, [user, loading, emailAllowed, setLocation]);

  if (loading) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!user || !emailAllowed) return null;

  return <>{children}</>;
}
