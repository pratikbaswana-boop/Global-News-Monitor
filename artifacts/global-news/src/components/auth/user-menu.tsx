import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { LogOut, User } from "lucide-react";

export function UserMenu() {
  const { user, logout } = useAuth();

  if (!user) return null;

  return (
    <div className="flex items-center gap-2 px-2">
      {user.photoURL ? (
        <img
          src={user.photoURL}
          alt={user.displayName || user.email || ""}
          className="h-7 w-7 rounded-full border border-border/40"
        />
      ) : (
        <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center">
          <User className="h-3.5 w-3.5 text-primary" />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium truncate">
          {user.displayName || user.email || "User"}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground hover:text-foreground"
        onClick={() => logout()}
        title="Sign out"
      >
        <LogOut className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
