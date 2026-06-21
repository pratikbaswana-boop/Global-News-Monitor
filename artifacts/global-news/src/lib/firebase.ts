import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyCpXUS94zeHoHgGpwLBvEmyOxoI6Zzx27A",
  authDomain: "aumorphic.firebaseapp.com",
  projectId: "aumorphic",
  storageBucket: "aumorphic.firebasestorage.app",
  messagingSenderId: "91815352371",
  appId: "1:91815352371:web:a30a29d5706593a1082b46",
  measurementId: "G-9Y85TN5970",
};

export const firebaseApp = initializeApp(firebaseConfig);
export const firebaseAuth = getAuth(firebaseApp);
export const googleProvider = new GoogleAuthProvider();
