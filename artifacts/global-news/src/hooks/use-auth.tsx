import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import {
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  type User as FirebaseUser,
} from "firebase/auth";
import { firebaseAuth, googleProvider } from "@/lib/firebase";

export interface AuthUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
}

async function syncUserToBackend(fbUser: FirebaseUser) {
  try {
    await fetch("/api/auth/user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uid: fbUser.uid,
        email: fbUser.email,
        displayName: fbUser.displayName,
        photoURL: fbUser.photoURL,
      }),
    });
  } catch {
    // Silently fail — backend sync is non-critical
  }
}

interface AuthContextValue {
  user: AuthUser | null;
  firebaseUser: FirebaseUser | null;
  loading: boolean;
  signInGoogle: () => Promise<void>;
  signInEmail: (email: string, password: string) => Promise<void>;
  signUpEmail: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function mapUser(fbUser: FirebaseUser): AuthUser {
  return {
    uid: fbUser.uid,
    email: fbUser.email,
    displayName: fbUser.displayName,
    photoURL: fbUser.photoURL,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(firebaseAuth, (fbUser: FirebaseUser | null) => {
      if (fbUser) {
        setUser(mapUser(fbUser));
        setFirebaseUser(fbUser);
        void syncUserToBackend(fbUser);
      } else {
        setUser(null);
        setFirebaseUser(null);
      }
      setLoading(false);
    });
    return unsub;
  }, []);

  const signInGoogle = useCallback(async () => {
    const result = await signInWithPopup(firebaseAuth, googleProvider);
    if (result.user) {
      setUser(mapUser(result.user));
      setFirebaseUser(result.user);
    }
  }, []);

  const signInEmail = useCallback(async (email: string, password: string) => {
    const result = await signInWithEmailAndPassword(firebaseAuth, email, password);
    if (result.user) {
      setUser(mapUser(result.user));
      setFirebaseUser(result.user);
    }
  }, []);

  const signUpEmail = useCallback(async (email: string, password: string) => {
    const result = await createUserWithEmailAndPassword(firebaseAuth, email, password);
    if (result.user) {
      setUser(mapUser(result.user));
      setFirebaseUser(result.user);
    }
  }, []);

  const logout = useCallback(async () => {
    await signOut(firebaseAuth);
    setUser(null);
    setFirebaseUser(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, firebaseUser, loading, signInGoogle, signInEmail, signUpEmail, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
