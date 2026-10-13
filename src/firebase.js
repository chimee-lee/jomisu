// Firebase setup: one place that creates the app, auth and database handles.
import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// Web config is not secret (access is controlled by Firestore rules).
const firebaseConfig = {
  apiKey: "AIzaSyCqhaz60GCkG0QUfaBrMXsdVr_wnWukhTM",
  authDomain: "jomisu.firebaseapp.com",
  projectId: "jomisu",
  storageBucket: "jomisu.firebasestorage.app",
  messagingSenderId: "236629246156",
  appId: "1:236629246156:web:8d7ba078bc542acb2dc269",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();
