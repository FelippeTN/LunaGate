import { useState } from "react";
import { clearToken, getToken } from "@/api";
import { TokenGate } from "@/features/auth/TokenGate";
import { Dashboard } from "@/features/dashboard/Dashboard";

export default function App() {
  const [authed, setAuthed] = useState(!!getToken());

  if (!authed) {
    return <TokenGate onDone={() => setAuthed(true)} />;
  }

  return (
    <Dashboard
      onLogout={() => {
        clearToken();
        setAuthed(false);
      }}
    />
  );
}
